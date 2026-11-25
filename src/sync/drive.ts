/**
 * 구글 드라이브 REST v3 를 fetch 로 직접 부른다 (gapi 없음). 화면·저장소를 모른다.
 * 토큰은 매 요청마다 getToken() 으로 읽는다. 토큰이 없으면 요청하지 않고 AuthError 를 던진다.
 */
import { MULTIPART_MAX_BYTES } from './names';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,parents,size,modifiedTime,appProperties)';
const UPLOAD_FIELDS = 'id,name,size';

const KIB = 1024;
const CHUNK_UNIT = 256 * KIB;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * KIB;
/** 조각 하나가 끊겨서 상태를 물어 이어 보내는 최대 횟수 */
const MAX_CHUNK_RECOVERIES = 3;

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

/** 401 이거나 토큰이 없다. 대기열은 이 오류를 받으면 멈추고 재로그인을 시도한다 */
export class AuthError extends DriveError {
  constructor(message = '드라이브에 로그인되어 있지 않습니다', reason?: string) {
    super(message, 401, false, reason);
    this.name = 'AuthError';
  }
}

export interface DriveClientOptions {
  fetch: typeof fetch;
  getToken: () => string | null;
  /** resumable 조각 크기. 기본 8 MiB, 256 KiB 배수로 맞춘다 */
  resumableChunkBytes?: number;
}

export interface DriveUploadMeta {
  name: string;
  parents?: string[];
  mimeType: string;
  appProperties?: Record<string, string>;
}

interface ApiErrorBody {
  error?: { message?: string; errors?: Array<{ reason?: string }> };
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** 검색식 안의 문자열 값에서 `\` 와 `'` 를 이스케이프한다 */
export function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function errorFromResponse(res: Response): Promise<DriveError> {
  let reason: string | undefined;
  let message: string | undefined;
  try {
    const body = JSON.parse(await res.text()) as ApiErrorBody;
    reason = body.error?.errors?.[0]?.reason;
    message = body.error?.message;
  } catch {
    // JSON 이 아닌 응답은 상태 문구만 쓴다
  }
  const text = `드라이브 응답 ${res.status}: ${message ?? (res.statusText || '알 수 없는 오류')}`;
  if (res.status === 401) return new AuthError(text, reason);
  const retryable =
    res.status === 429 || res.status >= 500 || (res.status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason));
  return new DriveError(text, res.status, retryable, reason);
}

export class DriveClient {
  // 전역 fetch 는 객체의 메서드로 부르면 "Illegal invocation" 이 난다. 지역 함수로 감싸 둔다.
  private readonly doFetch: (url: string, init: RequestInit) => Promise<Response>;
  private readonly getToken: () => string | null;
  private readonly chunkBytes: number;

  constructor(opts: DriveClientOptions) {
    const f = opts.fetch;
    this.doFetch = (url, init) => f(url, init);
    this.getToken = opts.getToken;
    const want = opts.resumableChunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.chunkBytes = Math.max(CHUNK_UNIT, Math.floor(want / CHUNK_UNIT) * CHUNK_UNIT);
  }

  // ── 검색·폴더 ──────────────────────────────────────────
  async findFolder(name: string, parentId: string): Promise<DriveFile | null> {
    const q = `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const list = await this.listFiles(q);
    return list[0] ?? null;
  }

  /** 찾고 없으면 만든다. parentId 는 'root' 도 된다 */
  async ensureFolder(name: string, parentId: string): Promise<string> {
    const found = await this.findFolder(name, parentId);
    if (found) return found.id;
    const res = await this.send(`${FILES_URL}?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    const created = (await res.json()) as DriveFile;
    return created.id;
  }

  /** 폴더가 아닌 파일 (휴지통 제외) */
  async findFile(name: string, parentId: string): Promise<DriveFile | null> {
    const q = `name = '${escapeQuery(name)}' and '${escapeQuery(parentId)}' in parents and mimeType != '${FOLDER_MIME}' and trashed = false`;
    const list = await this.listFiles(q);
    return list[0] ?? null;
  }

  /** nextPageToken 을 따라 끝까지 모은다. fields 를 바꾸면 nextPageToken 을 직접 넣어야 한다 */
  async listFiles(q: string, fields: string = LIST_FIELDS): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, spaces: 'drive', fields, pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.send(`${FILES_URL}?${params.toString()}`, { method: 'GET' });
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(fileId: string): Promise<Blob> {
    const res = await this.send(`${FILES_URL}/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' });
    return res.blob();
  }

  // ── 업로드 ─────────────────────────────────────────────
  /** 5MB 이하는 multipart, 넘으면 resumable (SPEC 7장). existingFileId 가 있으면 그 파일을 갱신한다 */
  upload(meta: DriveUploadMeta, blob: Blob, existingFileId?: string): Promise<DriveFile> {
    return blob.size <= MULTIPART_MAX_BYTES
      ? this.uploadMultipart(meta, blob, existingFileId)
      : this.uploadResumable(meta, blob, existingFileId);
  }

  async uploadMultipart(meta: DriveUploadMeta, blob: Blob, existingFileId?: string): Promise<DriveFile> {
    const boundary = `bookscan-${randomToken()}`;
    const head =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadataBody(meta, existingFileId))}\r\n` +
      `--${boundary}\r\nContent-Type: ${meta.mimeType}\r\n\r\n`;
    const body = new Blob([head, blob, `\r\n--${boundary}--`]);
    const res = await this.send(uploadUrl('multipart', existingFileId), {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return (await res.json()) as DriveFile;
  }

  async uploadResumable(meta: DriveUploadMeta, blob: Blob, existingFileId?: string): Promise<DriveFile> {
    const start = await this.send(uploadUrl('resumable', existingFileId), {
      method: existingFileId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': meta.mimeType,
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(metadataBody(meta, existingFileId)),
    });
    const session = start.headers.get('Location');
    if (!session) throw new DriveError('드라이브가 업로드 주소를 주지 않았습니다', start.status, false, 'noSessionUri');
    return this.runSession(session, blob);
  }

  /**
   * 세션 URI 로 조각을 보낸다. 조각이 끊기면(네트워크 오류·5xx) `bytes *\/total` 로 어디까지 받았는지 묻고
   * 그 다음부터 이어 보낸다. 조각당 최대 3번까지 복구하고, 그 뒤에는 retryable DriveError 를 던진다.
   */
  private async runSession(session: string, blob: Blob): Promise<DriveFile> {
    const total = blob.size;
    let offset = 0;
    let failures = 0;
    // 빈 파일은 보낼 조각이 없으므로 처음부터 `bytes */0` 으로 마무리한다
    let query = total === 0;
    for (;;) {
      const asQuery = query;
      let res: Response;
      try {
        if (asQuery) {
          res = await this.send(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` } }, [308]);
        } else {
          const end = Math.min(offset + this.chunkBytes, total);
          res = await this.send(
            session,
            { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` }, body: blob.slice(offset, end) },
            [308],
          );
        }
      } catch (e) {
        if (!(e instanceof DriveError) || e instanceof AuthError) throw e;
        if (e.status === 404 || e.status === 410) {
          throw new DriveError(`업로드 세션이 만료됐습니다 (${e.status})`, e.status, true, 'sessionExpired');
        }
        if (e.status === 0 || e.status >= 500) {
          failures++;
          if (failures > MAX_CHUNK_RECOVERIES) {
            throw new DriveError(`업로드가 계속 끊겨 중단했습니다: ${e.message}`, e.status, true, e.reason);
          }
          query = true;
          continue;
        }
        throw e;
      }

      if (res.status === 200 || res.status === 201) return (await res.json()) as DriveFile;

      // 308: 서버가 받은 만큼을 Range 로 알려 준다. 없으면 아직 한 바이트도 못 받은 것이다
      offset = receivedBytes(res.headers.get('Range'));
      if (offset >= total) {
        // 다 받았다는데 완료 응답이 없다. 상태를 다시 물어 본다
        failures++;
        if (failures > MAX_CHUNK_RECOVERIES) {
          throw new DriveError('업로드가 끝났는데 드라이브가 완료 응답을 주지 않았습니다', 308, true, 'incomplete');
        }
        query = true;
        continue;
      }
      if (!asQuery) failures = 0;
      query = false;
    }
  }

  // ── 공통 요청 ──────────────────────────────────────────
  /** 토큰을 붙여 보낸다. 2xx 와 accept 에 든 상태만 돌려주고 나머지는 DriveError 로 던진다 */
  private async send(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: BodyInit },
    accept: number[] = [],
  ): Promise<Response> {
    const token = this.getToken();
    if (!token) throw new AuthError();
    let res: Response;
    try {
      res = await this.doFetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new DriveError(`네트워크 오류: ${why}`, 0, true, 'network');
    }
    if (res.ok || accept.includes(res.status)) return res;
    throw await errorFromResponse(res);
  }
}

function uploadUrl(kind: 'multipart' | 'resumable', existingFileId?: string): string {
  const base = existingFileId ? `${UPLOAD_URL}/${encodeURIComponent(existingFileId)}` : UPLOAD_URL;
  return `${base}?uploadType=${kind}&fields=${UPLOAD_FIELDS}`;
}

/** 갱신할 때는 parents 를 넣지 않는다 (넣으면 드라이브가 거부한다) */
function metadataBody(meta: DriveUploadMeta, existingFileId?: string): Record<string, unknown> {
  return {
    name: meta.name,
    mimeType: meta.mimeType,
    ...(meta.parents && !existingFileId ? { parents: meta.parents } : {}),
    ...(meta.appProperties ? { appProperties: meta.appProperties } : {}),
  };
}

/** `Range: bytes=0-N` → N+1. 헤더가 없으면 0 */
function receivedBytes(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null;
  return m?.[1] ? Number(m[1]) + 1 : 0;
}

function randomToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

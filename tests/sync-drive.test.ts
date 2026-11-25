/**
 * 드라이브 클라이언트(drive.ts)·이름 규칙(names.ts)·토큰 제공자(token.ts) 단위 테스트.
 * 가짜 fetch 가 메모리 "드라이브"를 흉내 내고, 401·5xx·네트워크 오류·308 을 원하는 횟수만큼 끼워 넣는다.
 */
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { originalName } from '../src/export/bookjson';
import { AuthError, DriveClient, DriveError, escapeQuery } from '../src/sync/drive';
import {
  BOOK_JSON_NAME,
  MULTIPART_MAX_BYTES,
  ORIGINAL_FOLDER_NAME,
  ROOT_FOLDER_NAME,
  bookFolderName,
  pdfFileName,
  sanitizeTitle,
} from '../src/sync/names';
import { DRIVE_SCOPE, GisTokenProvider, MemoryTokenProvider, loadGisScript } from '../src/sync/token';

// ── 가짜 드라이브 ────────────────────────────────────────────────
// URL·method·헤더를 보고 메모리 "드라이브"(폴더·파일 목록)를 흉내 낸다. 두 테스트 파일에 같은 내용을 둔다.
const FOLDER_MIME = 'application/vnd.google-apps.folder';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties?: Record<string, string>;
  data: Buffer;
  trashed: boolean;
}

interface UploadMetaBody {
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

interface Session {
  meta: UploadMetaBody;
  existingId?: string;
  chunks: Buffer[];
  receivedBytes: number;
  total: number;
  fileId?: string;
}

export interface Req {
  method: string;
  url: URL;
  headers: Headers;
  /** 본문 앞 2000바이트 (문자열). multipart 의 JSON 파트에서 파일 이름을 가려내는 데 쓴다 */
  head: string;
}

interface ParsedMultipart {
  contentType: string;
  boundary: string;
  raw: Buffer;
  metaHeaders: string;
  meta: UploadMetaBody;
  mediaHeaders: string;
  data: Buffer;
}

interface Fault {
  match: (r: Req) => boolean;
  times: number;
  /** network: 요청 전에 끊김 / after: 서버는 처리했는데 응답 전에 끊김 / status: 오류 응답 */
  kind: 'network' | 'after' | 'status';
  status?: number;
  reason?: string;
  message?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function errorRes(status: number, reason: string, message: string): Response {
  return jsonRes({ error: { code: status, message, errors: [{ reason }] } }, status);
}
const unescapeQ = (s: string) => s.replace(/\\(.)/g, '$1');

export class FakeDrive {
  files = new Map<string, FakeFile>();
  log: Req[] = [];
  multiparts: ParsedMultipart[] = [];
  faults: Fault[] = [];
  sessions = new Map<string, Session>();
  /** 설정하면 이 토큰이 아닌 요청은 401 */
  validToken: string | null = null;
  latencyMs = 3;
  /** 요청별로 지연을 바꾼다 (undefined 면 latencyMs) */
  slow: ((r: Req) => number | undefined) | undefined;
  pageSize = 1000;
  partialBytes: number | undefined;
  inFlight = 0;
  maxInFlight = 0;
  private seq = 0;

  fail(match: (r: Req) => boolean, kind: Fault['kind'], times = 1, extra: { status?: number; reason?: string; message?: string } = {}): void {
    this.faults.push({ match, kind, times, ...extra });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = await toBuffer(init?.body);
    const req: Req = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      head: raw.subarray(0, 2000).toString('latin1'),
    };
    this.log.push(req);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await sleep(this.slow?.(req) ?? this.latencyMs);
      if (this.validToken !== null && req.headers.get('Authorization') !== `Bearer ${this.validToken}`) {
        return errorRes(401, 'authError', 'Invalid Credentials');
      }
      const fault = this.faults.find((f) => f.times > 0 && f.match(req));
      if (fault) fault.times--;
      if (fault?.kind === 'network') throw new TypeError('Failed to fetch');
      if (fault?.kind === 'status') {
        if (fault.status === 308) return new Response(null, { status: 308 });
        return errorRes(fault.status ?? 500, fault.reason ?? 'backendError', fault.message ?? 'Backend Error');
      }
      const res = await this.handle(req, raw);
      if (fault?.kind === 'after') throw new TypeError('Failed to fetch');
      return res;
    } finally {
      this.inFlight--;
    }
  };

  // ── 검사용 ──
  private pathOf(f: FakeFile): string {
    const parent = f.parents[0];
    const up = parent && parent !== 'root' ? this.files.get(parent) : undefined;
    return up ? `${this.pathOf(up)}/${f.name}` : f.name;
  }
  /** 휴지통이 아닌 모든 항목의 경로 (정렬). 폴더는 끝에 `/` */
  tree(): string[] {
    return [...this.files.values()]
      .filter((f) => !f.trashed)
      .map((f) => this.pathOf(f) + (f.mimeType === FOLDER_MIME ? '/' : ''))
      .sort();
  }
  byName(name: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.name === name && f.mimeType !== FOLDER_MIME && !f.trashed);
  }
  folders(name: string): FakeFile[] {
    return [...this.files.values()].filter((f) => f.name === name && f.mimeType === FOLDER_MIME && !f.trashed);
  }
  /** 폴더와 그 아래를 모두 지운다 (사용자가 드라이브에서 폴더를 지운 상황) */
  removeTree(id: string): void {
    for (const f of [...this.files.values()]) if (f.parents.includes(id)) this.removeTree(f.id);
    this.files.delete(id);
  }
  /** 서버에 직접 파일을 만든다 (업로드는 됐는데 앱이 몰랐던 상황) */
  put(name: string, parentId: string, data: Buffer, mimeType = 'image/jpeg'): FakeFile {
    const f: FakeFile = { id: `f${++this.seq}`, name, mimeType, parents: [parentId], data, trashed: false };
    this.files.set(f.id, f);
    return f;
  }
  requests(filter: (r: Req) => boolean): Req[] {
    return this.log.filter(filter);
  }

  // ── 요청 처리 ──
  private async handle(r: Req, raw: Buffer): Promise<Response> {
    const path = r.url.pathname;
    const p = r.url.searchParams;
    if (path === '/upload/drive/v3/files' || path.startsWith('/upload/drive/v3/files/')) return this.handleUpload(r, raw);
    if (path === '/drive/v3/files' && r.method === 'GET') return this.handleList(p);
    if (path === '/drive/v3/files' && r.method === 'POST') {
      const body = JSON.parse(raw.toString('utf8')) as UploadMetaBody;
      return this.store(body, Buffer.alloc(0));
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m?.[1] && r.method === 'GET' && p.get('alt') === 'media') {
      const f = this.files.get(decodeURIComponent(m[1]));
      return f ? new Response(new Uint8Array(f.data), { status: 200 }) : errorRes(404, 'notFound', 'File not found');
    }
    return errorRes(404, 'notFound', `처리하지 않는 요청: ${r.method} ${path}`);
  }

  private handleList(p: URLSearchParams): Response {
    const q = p.get('q') ?? '';
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1];
    const parent = /and '((?:[^'\\]|\\.)*)' in parents/.exec(q)?.[1];
    const folderOnly = q.includes(`mimeType = '${FOLDER_MIME}'`);
    const filesOnly = q.includes(`mimeType != '${FOLDER_MIME}'`);
    const all = [...this.files.values()].filter(
      (f) =>
        !f.trashed &&
        (name === undefined || f.name === unescapeQ(name)) &&
        (parent === undefined || f.parents.includes(unescapeQ(parent))) &&
        (!folderOnly || f.mimeType === FOLDER_MIME) &&
        (!filesOnly || f.mimeType !== FOLDER_MIME),
    );
    const size = Math.min(this.pageSize, Number(p.get('pageSize') ?? 1000));
    const start = Number(p.get('pageToken') ?? 0);
    const page = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : undefined;
    return jsonRes({ ...(next ? { nextPageToken: next } : {}), files: page.map((f) => this.fileJson(f)) });
  }

  private fileJson(f: FakeFile) {
    return { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, size: String(f.data.length), appProperties: f.appProperties };
  }

  /** 새 파일(existingId 없음) 또는 갱신. 오류면 Response 를 돌려준다 */
  private storeRaw(meta: UploadMetaBody, data: Buffer, existingId?: string): FakeFile | Response {
    if (existingId) {
      const f = this.files.get(existingId);
      if (!f) return errorRes(404, 'notFound', `File not found: ${existingId}`);
      if (meta.parents !== undefined) return errorRes(400, 'invalid', '갱신할 때는 parents 를 보낼 수 없다');
      f.name = meta.name;
      f.data = data;
      if (meta.appProperties) f.appProperties = meta.appProperties;
      return f;
    }
    const parents = meta.parents ?? ['root'];
    for (const pid of parents) {
      if (pid !== 'root' && !this.files.has(pid)) return errorRes(404, 'notFound', `File not found: ${pid}`);
    }
    const f: FakeFile = {
      id: `f${++this.seq}`,
      name: meta.name,
      mimeType: meta.mimeType,
      parents,
      appProperties: meta.appProperties,
      data,
      trashed: false,
    };
    this.files.set(f.id, f);
    return f;
  }

  private store(meta: UploadMetaBody, data: Buffer, existingId?: string): Response {
    const r = this.storeRaw(meta, data, existingId);
    return r instanceof Response ? r : jsonRes(this.fileJson(r));
  }

  private async handleUpload(r: Req, raw: Buffer): Promise<Response> {
    const p = r.url.searchParams;
    const idMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(r.url.pathname);
    const existingId = idMatch?.[1] ? decodeURIComponent(idMatch[1]) : undefined;
    const kind = p.get('uploadType');

    if (r.method === 'PUT') return this.handleSessionPut(r, raw);
    if (kind === 'multipart') {
      const parsed = parseMultipart(r.headers.get('Content-Type') ?? '', raw);
      this.multiparts.push(parsed);
      return this.store(parsed.meta, parsed.data, existingId);
    }
    if (kind === 'resumable') {
      const length = Number(r.headers.get('X-Upload-Content-Length'));
      const meta = JSON.parse(raw.toString('utf8')) as UploadMetaBody;
      if (!Number.isFinite(length) || !r.headers.get('X-Upload-Content-Type')) return errorRes(400, 'invalid', '시작 헤더가 없다');
      const id = `sess${this.sessions.size + 1}`;
      this.sessions.set(id, { meta, existingId, chunks: [], receivedBytes: 0, total: length });
      return new Response(null, {
        status: 200,
        headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}` },
      });
    }
    return errorRes(400, 'invalid', 'uploadType 이 없다');
  }

  private handleSessionPut(r: Req, raw: Buffer): Response {
    const s = this.sessions.get(r.url.searchParams.get('upload_id') ?? '');
    if (!s) return errorRes(404, 'notFound', 'Session not found');
    const range = r.headers.get('Content-Range') ?? '';
    const progress = (): Response => {
      if (s.fileId) return jsonRes(this.fileJson(this.files.get(s.fileId)!), 200);
      return new Response(null, {
        status: 308,
        headers: s.receivedBytes > 0 ? { Range: `bytes=0-${s.receivedBytes - 1}` } : {},
      });
    };
    const q = /^bytes \*\/(\d+)$/.exec(range);
    if (q) {
      if (s.total === 0 && !s.fileId) return this.finish(s);
      return progress();
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) return errorRes(400, 'invalid', `Content-Range 형식 오류: ${range}`);
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (Number(m[3]) !== s.total || raw.length !== end - start + 1) return errorRes(400, 'invalid', '조각 크기가 Content-Range 와 다르다');
    if (start !== s.receivedBytes) return progress();
    // partialBytes: 서버가 조각의 앞부분만 저장한 상황 (Range 헤더로 알려 준다)
    const keep = this.partialBytes !== undefined ? raw.subarray(0, this.partialBytes) : raw;
    s.chunks.push(keep);
    s.receivedBytes += keep.length;
    return s.receivedBytes === s.total ? this.finish(s) : progress();
  }

  private finish(s: Session): Response {
    const r = this.storeRaw(s.meta, Buffer.concat(s.chunks), s.existingId);
    if (r instanceof Response) return r;
    s.fileId = r.id;
    return jsonRes(this.fileJson(r), s.existingId ? 200 : 201);
  }
}

async function toBuffer(body: BodyInit | null | undefined): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new Error('가짜 드라이브가 모르는 본문 형식');
}

/** multipart/related 본문을 엄격하게 읽는다: `--b CRLF 헤더 CRLF CRLF JSON CRLF --b CRLF 헤더 CRLF CRLF 데이터 CRLF --b--` */
export function parseMultipart(contentType: string, raw: Buffer): ParsedMultipart {
  const m = /^multipart\/related; boundary=(\S+)$/.exec(contentType);
  if (!m?.[1]) throw new Error(`Content-Type 이 multipart/related 가 아니다: ${contentType}`);
  const boundary = m[1];
  const CRLF2 = Buffer.from('\r\n\r\n');
  const open = Buffer.from(`--${boundary}\r\n`);
  const mid = Buffer.from(`\r\n--${boundary}\r\n`);
  const close = Buffer.from(`\r\n--${boundary}--`);
  if (raw.indexOf(open) !== 0) throw new Error('본문이 경계로 시작하지 않는다');
  if (raw.length < close.length || !raw.subarray(raw.length - close.length).equals(close)) throw new Error('본문이 닫는 경계로 끝나지 않는다');
  const h1End = raw.indexOf(CRLF2, open.length);
  const midAt = raw.indexOf(mid, h1End);
  if (h1End < 0 || midAt < 0) throw new Error('JSON 파트를 찾지 못했다');
  const metaHeaders = raw.subarray(open.length, h1End).toString('utf8');
  const meta = JSON.parse(raw.subarray(h1End + CRLF2.length, midAt).toString('utf8')) as UploadMetaBody;
  const h2Start = midAt + mid.length;
  const h2End = raw.indexOf(CRLF2, h2Start);
  if (h2End < 0) throw new Error('바이너리 파트 헤더를 찾지 못했다');
  const mediaHeaders = raw.subarray(h2Start, h2End).toString('utf8');
  const data = raw.subarray(h2End + CRLF2.length, raw.length - close.length);
  return { contentType, boundary, raw, metaHeaders, meta, mediaHeaders, data: Buffer.from(data) };
}

/** i 번째 바이트가 i % 251 인 시험용 데이터 */
function bytes(n: number, seed = 0): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);
}

// ── 도우미 ──────────────────────────────────────────────────────
function client(drive: FakeDrive, opts: { token?: string | null; chunk?: number } = {}): DriveClient {
  const token = opts.token === undefined ? 'tok' : opts.token;
  return new DriveClient({
    fetch: drive.fetch as typeof fetch,
    getToken: () => token,
    ...(opts.chunk ? { resumableChunkBytes: opts.chunk } : {}),
  });
}

const META = { name: '0001.jpg', mimeType: 'image/jpeg', appProperties: { bookscanBookId: 'b1', bookscanSeq: '1' } };
const isPut = (r: Req) => r.method === 'PUT';
const ranges = (d: FakeDrive) => d.requests(isPut).map((r) => r.headers.get('Content-Range'));

async function blobOf(n: number, seed = 0): Promise<{ blob: Blob; buf: Buffer }> {
  const u8 = bytes(n, seed);
  return { blob: new Blob([u8]), buf: Buffer.from(u8) };
}

// ── 이름 규칙 ───────────────────────────────────────────────────
describe('이름 규칙 (names.ts)', () => {
  it('금지 문자와 제어문자는 _ 로, 앞뒤 공백은 지운다', () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeTitle('  책 제목  ')).toBe('책 제목');
    expect(sanitizeTitle('a\u0001b\u007fc\nd')).toBe('a_b_c_d');
  });

  it('빈 제목은 "제목 없음", 최대 80자 (글자 단위)', () => {
    expect(sanitizeTitle('')).toBe('제목 없음');
    expect(sanitizeTitle('   ')).toBe('제목 없음');
    expect(sanitizeTitle('x'.repeat(200))).toHaveLength(80);
    expect(Array.from(sanitizeTitle('😀'.repeat(100)))).toHaveLength(80);
    // 자른 끝의 공백은 남기지 않는다
    expect(sanitizeTitle('a'.repeat(79) + ' ' + 'b')).toBe('a'.repeat(79));
  });

  it('책 폴더는 <제목>_<로컬 날짜 YYYYMMDD>, PDF 는 <제목>.pdf', () => {
    expect(bookFolderName('책/제목', new Date(2024, 2, 5, 23, 59).getTime())).toBe('책_제목_20240305');
    expect(bookFolderName('', new Date(2024, 0, 1, 0, 0, 5).getTime())).toBe('제목 없음_20240101');
    expect(pdfFileName('a:b')).toBe('a_b.pdf');
    expect(ROOT_FOLDER_NAME).toBe('BookScan');
    expect(ORIGINAL_FOLDER_NAME).toBe('original');
    expect(BOOK_JSON_NAME).toBe('book.json');
    expect(MULTIPART_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(originalName(1)).toBe('0001.jpg');
  });
});

// ── 검색·폴더 ───────────────────────────────────────────────────
describe('DriveClient 검색과 폴더', () => {
  it("검색 q 는 \\ 와 ' 를 이스케이프한다", async () => {
    expect(escapeQuery("a'b\\c")).toBe("a\\'b\\\\c");
    const d = new FakeDrive();
    const c = client(d);
    d.put("a'b\\c", 'P', Buffer.from('x'));
    const found = await c.findFile("a'b\\c", 'P');
    expect(found?.name).toBe("a'b\\c");
    const req = d.log.at(-1)!;
    expect(req.url.searchParams.get('q')).toBe(
      "name = 'a\\'b\\\\c' and 'P' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false",
    );
    expect(req.url.searchParams.get('spaces')).toBe('drive');
    expect(req.url.searchParams.get('fields')).toBe('nextPageToken,files(id,name,mimeType,parents,size,modifiedTime,appProperties)');
  });

  it('findFile 은 폴더와 휴지통 파일을 건너뛴다', async () => {
    const d = new FakeDrive();
    const c = client(d);
    const folderId = await c.ensureFolder('x', 'root');
    expect(await c.findFile('x', 'root')).toBeNull();
    const trashed = d.put('t.jpg', folderId, Buffer.from('1'));
    trashed.trashed = true;
    expect(await c.findFile('t.jpg', folderId)).toBeNull();
    d.put('t.jpg', folderId, Buffer.from('2'));
    expect((await c.findFile('t.jpg', folderId))?.id).toBeDefined();
  });

  it('ensureFolder: 없으면 만들고(parents 에 root 허용) 있으면 그대로 쓴다', async () => {
    const d = new FakeDrive();
    const c = client(d);
    const a = await c.ensureFolder('BookScan', 'root');
    const post = d.requests((r) => r.method === 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]!.url.origin + post[0]!.url.pathname).toBe('https://www.googleapis.com/drive/v3/files');
    expect(post[0]!.headers.get('Content-Type')).toBe('application/json; charset=UTF-8');
    expect(d.folders('BookScan')[0]!.parents).toEqual(['root']);
    const b = await c.ensureFolder('BookScan', 'root');
    expect(b).toBe(a);
    expect(d.requests((r) => r.method === 'POST')).toHaveLength(1);
    const sub = await c.ensureFolder('original', a);
    expect(d.tree()).toEqual(['BookScan/', 'BookScan/original/']);
    expect(sub).not.toBe(a);
  });

  it('listFiles 는 nextPageToken 을 끝까지 따라간다', async () => {
    const d = new FakeDrive();
    d.pageSize = 2;
    const c = client(d);
    for (let i = 1; i <= 5; i++) d.put(`${i}.jpg`, 'P', Buffer.from('x'));
    const list = await c.listFiles("trashed = false and 'P' in parents");
    expect(list.map((f) => f.name)).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg']);
    expect(d.requests((r) => r.method === 'GET')).toHaveLength(3);
    expect(d.log[1]!.url.searchParams.get('pageToken')).toBe('2');
  });

  it('download 는 파일 내용을 Blob 으로 돌려준다', async () => {
    const d = new FakeDrive();
    const f = d.put('a.jpg', 'root', Buffer.from('hello'));
    const blob = await client(d).download(f.id);
    expect(await blob.text()).toBe('hello');
    expect(d.log.at(-1)!.url.searchParams.get('alt')).toBe('media');
  });
});

// ── 토큰과 오류 분류 ────────────────────────────────────────────
describe('DriveClient 토큰과 오류', () => {
  it('요청마다 getToken() 을 읽고 Authorization: Bearer 를 붙인다', async () => {
    const d = new FakeDrive();
    let token: string | null = 'one';
    const c = new DriveClient({ fetch: d.fetch as typeof fetch, getToken: () => token });
    await c.findFile('a', 'P');
    token = 'two';
    await c.findFile('a', 'P');
    expect(d.log.map((r) => r.headers.get('Authorization'))).toEqual(['Bearer one', 'Bearer two']);
  });

  it('토큰이 없으면 요청하지 않고 AuthError', async () => {
    const d = new FakeDrive();
    const c = client(d, { token: null });
    const err = await c.findFile('a', 'P').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toBeInstanceOf(DriveError);
    expect((err as AuthError).status).toBe(401);
    expect((err as AuthError).retryable).toBe(false);
    expect(d.log).toHaveLength(0);
    await expect(c.upload(META, new Blob(['x']))).rejects.toBeInstanceOf(AuthError);
    expect(d.log).toHaveLength(0);
  });

  it('401 → AuthError (재시도 대상 아님)', async () => {
    const d = new FakeDrive();
    d.validToken = 'other';
    const err = await client(d).findFile('a', 'P').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).retryable).toBe(false);
  });

  it.each([
    [429, 'rateLimitExceeded', true],
    [500, 'backendError', true],
    [503, 'backendError', true],
    [403, 'rateLimitExceeded', true],
    [403, 'userRateLimitExceeded', true],
    [403, 'forbidden', false],
    [404, 'notFound', false],
    [400, 'invalid', false],
  ])('%i %s → retryable=%s', async (status, reason, retryable) => {
    const d = new FakeDrive();
    d.fail(() => true, 'status', 1, { status, reason, message: 'Backend Error' });
    const err = (await client(d).findFile('a', 'P').catch((e: unknown) => e)) as DriveError;
    expect(err).toBeInstanceOf(DriveError);
    expect(err).not.toBeInstanceOf(AuthError);
    expect(err.status).toBe(status);
    expect(err.reason).toBe(reason);
    expect(err.retryable).toBe(retryable);
    expect(err.message).toBe(`드라이브 응답 ${status}: Backend Error`);
  });

  it('fetch 가 TypeError 를 던지면 status 0, retryable', async () => {
    const d = new FakeDrive();
    d.fail(() => true, 'network');
    const err = (await client(d).findFile('a', 'P').catch((e: unknown) => e)) as DriveError;
    expect(err).toBeInstanceOf(DriveError);
    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('네트워크 오류');
  });
});

// ── multipart ───────────────────────────────────────────────────
describe('multipart 업로드', () => {
  it('5MB 이하: 경계·JSON 파트·바이너리 파트 형식', async () => {
    const d = new FakeDrive();
    const c = client(d);
    const parent = await c.ensureFolder('original', 'root');
    const { blob, buf } = await blobOf(3000);
    const f = await c.upload({ ...META, parents: [parent] }, blob);

    const req = d.log.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.url.origin + req.url.pathname).toBe('https://www.googleapis.com/upload/drive/v3/files');
    expect(req.url.searchParams.get('uploadType')).toBe('multipart');
    expect(req.url.searchParams.get('fields')).toBe('id,name,size');

    expect(d.multiparts).toHaveLength(1);
    const mp = d.multiparts[0]!;
    expect(mp.contentType).toBe(`multipart/related; boundary=${mp.boundary}`);
    expect(mp.metaHeaders).toBe('Content-Type: application/json; charset=UTF-8');
    expect(mp.meta).toEqual({ name: '0001.jpg', mimeType: 'image/jpeg', parents: [parent], appProperties: META.appProperties });
    expect(mp.mediaHeaders).toBe('Content-Type: image/jpeg');
    expect(mp.data.equals(buf)).toBe(true);
    // 경계가 데이터 안에 우연히 들어 있지 않다
    expect(buf.includes(mp.boundary)).toBe(false);

    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
    expect(f.id).toBe(d.byName('0001.jpg')[0]!.id);
    expect(f.name).toBe('0001.jpg');
  });

  it('정확히 5MB 는 multipart, 1바이트 넘으면 resumable', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: 8 * 1024 * 1024 });
    const at = await blobOf(MULTIPART_MAX_BYTES);
    await c.upload({ ...META, name: 'at.bin' }, at.blob);
    expect(d.multiparts).toHaveLength(1);
    expect(d.sessions.size).toBe(0);

    const over = await blobOf(MULTIPART_MAX_BYTES + 1, 7);
    await c.upload({ ...META, name: 'over.bin' }, over.blob);
    expect(d.multiparts).toHaveLength(1);
    expect(d.sessions.size).toBe(1);
    expect(d.byName('over.bin')[0]!.data.equals(over.buf)).toBe(true);
  });

  it('기존 파일 갱신은 PATCH 이고 메타데이터에 parents 를 넣지 않는다 (파일은 늘지 않는다)', async () => {
    const d = new FakeDrive();
    const c = client(d);
    const first = await c.upload({ ...META, parents: ['root'] }, new Blob(['v1']));
    const second = await c.upload({ ...META, parents: ['root'] }, new Blob(['v2-longer']), first.id);
    expect(second.id).toBe(first.id);
    const req = d.log.at(-1)!;
    expect(req.method).toBe('PATCH');
    expect(req.url.pathname).toBe(`/upload/drive/v3/files/${first.id}`);
    expect(req.url.searchParams.get('uploadType')).toBe('multipart');
    expect(d.multiparts.at(-1)!.meta).not.toHaveProperty('parents');
    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(d.byName('0001.jpg')[0]!.data.toString()).toBe('v2-longer');
  });

  it('빈 파일도 multipart 로 올라간다', async () => {
    const d = new FakeDrive();
    await client(d).upload(META, new Blob([]));
    expect(d.byName('0001.jpg')[0]!.data).toHaveLength(0);
  });
});

// ── resumable ───────────────────────────────────────────────────
describe('resumable 업로드', () => {
  const KIB = 1024;
  const CHUNK = 256 * KIB;
  const SIZE = 600 * KIB; // 조각 3개: 256 + 256 + 88 KiB
  const total = SIZE;

  it('시작 요청 헤더와 조각 Content-Range 형식 (5MB 초과는 resumable 경로)', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: 1024 * KIB });
    const n = MULTIPART_MAX_BYTES + 1;
    const { blob, buf } = await blobOf(n);
    const f = await c.upload({ ...META, parents: ['root'] }, blob);

    expect(d.multiparts).toHaveLength(0);
    const start = d.log[0]!;
    expect(start.method).toBe('POST');
    expect(start.url.searchParams.get('uploadType')).toBe('resumable');
    expect(start.headers.get('X-Upload-Content-Type')).toBe('image/jpeg');
    expect(start.headers.get('X-Upload-Content-Length')).toBe(String(n));
    expect(start.headers.get('Content-Type')).toBe('application/json; charset=UTF-8');

    const r = ranges(d);
    expect(r).toHaveLength(6);
    expect(r[0]).toBe(`bytes 0-${1024 * KIB - 1}/${n}`);
    expect(r[5]).toBe(`bytes ${5 * 1024 * KIB}-${n - 1}/${n}`);
    expect(d.requests(isPut).every((x) => x.headers.get('Authorization') === 'Bearer tok')).toBe(true);
    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
    expect(f.id).toBe(d.byName('0001.jpg')[0]!.id);
  });

  it('조각 크기는 256KiB 배수로 맞춘다', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: 300 * KIB });
    const { blob } = await blobOf(SIZE);
    await c.uploadResumable(META, blob);
    expect(ranges(d)).toEqual([`bytes 0-${CHUNK - 1}/${total}`, `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`, `bytes ${2 * CHUNK}-${total - 1}/${total}`]);
  });

  it('308 의 Range 를 읽어 받은 만큼 다음부터 이어 보낸다', async () => {
    const d = new FakeDrive();
    d.partialBytes = 100_000; // 서버가 조각마다 앞 100000바이트만 저장한다
    const c = client(d, { chunk: CHUNK });
    const { blob, buf } = await blobOf(SIZE);
    await c.uploadResumable(META, blob);
    const r = ranges(d);
    expect(r[0]).toBe(`bytes 0-${CHUNK - 1}/${total}`);
    expect(r[1]).toBe(`bytes 100000-${100_000 + CHUNK - 1}/${total}`);
    expect(r[2]!.startsWith('bytes 200000-')).toBe(true);
    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
  });

  it('308 에 Range 가 없으면 0부터 다시 보낸다', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail((r) => isPut(r) && r.headers.get('Content-Range')!.startsWith('bytes 0-'), 'status', 1, { status: 308 });
    const { blob, buf } = await blobOf(SIZE);
    await c.uploadResumable(META, blob);
    expect(ranges(d).slice(0, 2)).toEqual([`bytes 0-${CHUNK - 1}/${total}`, `bytes 0-${CHUNK - 1}/${total}`]);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
  });

  it('조각 도중 네트워크 오류 → bytes */total 로 물어 이어 보낸다', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail((r) => isPut(r) && r.headers.get('Content-Range')!.startsWith(`bytes ${CHUNK}-`), 'network');
    const { blob, buf } = await blobOf(SIZE);
    await c.uploadResumable(META, blob);
    expect(ranges(d)).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`, // 끊김 (서버는 못 받음)
      `bytes */${total}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`,
      `bytes ${2 * CHUNK}-${total - 1}/${total}`,
    ]);
    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
  });

  it('서버는 받았는데 응답이 끊기면 상태 조회의 Range 로 다음 조각부터 보낸다', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail((r) => isPut(r) && r.headers.get('Content-Range')!.startsWith(`bytes ${CHUNK}-`), 'after');
    const { blob, buf } = await blobOf(SIZE);
    await c.uploadResumable(META, blob);
    expect(ranges(d)).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes ${CHUNK}-${2 * CHUNK - 1}/${total}`, // 서버는 저장, 응답만 끊김
      `bytes */${total}`,
      `bytes ${2 * CHUNK}-${total - 1}/${total}`,
    ]);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
  });

  it('조각 5xx 도 같은 방식으로 이어 보낸다', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail((r) => isPut(r) && r.headers.get('Content-Range')!.startsWith('bytes 0-'), 'status', 2, { status: 503 });
    const { blob, buf } = await blobOf(SIZE);
    await c.uploadResumable(META, blob);
    expect(ranges(d).slice(0, 5)).toEqual([
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes */${total}`,
      `bytes 0-${CHUNK - 1}/${total}`,
      `bytes */${total}`,
      `bytes 0-${CHUNK - 1}/${total}`,
    ]);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
  });

  it('마지막 조각의 응답이 끊겨도 상태 조회가 200 이면 그 파일을 돌려준다 (파일은 하나)', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail((r) => isPut(r) && r.headers.get('Content-Range')!.startsWith(`bytes ${2 * CHUNK}-`), 'after');
    const { blob } = await blobOf(SIZE);
    const f = await c.uploadResumable(META, blob);
    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(f.id).toBe(d.byName('0001.jpg')[0]!.id);
  });

  it('한 조각이 4번 연속 끊기면 retryable DriveError (복구는 조각당 3번)', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail((r) => isPut(r) && r.headers.get('Content-Range')!.startsWith(`bytes ${CHUNK}-`), 'network', 10);
    const { blob } = await blobOf(SIZE);
    const err = (await c.uploadResumable(META, blob).catch((e: unknown) => e)) as DriveError;
    expect(err).toBeInstanceOf(DriveError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('업로드가 계속 끊겨');
    const chunk2 = ranges(d).filter((x) => x!.startsWith(`bytes ${CHUNK}-`));
    expect(chunk2).toHaveLength(4);
    expect(d.byName('0001.jpg')).toHaveLength(0);
  });

  it.each([404, 410])('세션 %i 은 만료로 보고 retryable DriveError', async (status) => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail(isPut, 'status', 1, { status, reason: 'notFound', message: 'gone' });
    const { blob } = await blobOf(SIZE);
    const err = (await c.uploadResumable(META, blob).catch((e: unknown) => e)) as DriveError;
    expect(err).toBeInstanceOf(DriveError);
    expect(err.retryable).toBe(true);
    expect(err.status).toBe(status);
    expect(err.message).toContain('세션이 만료');
  });

  it('조각 도중 401 은 AuthError 로 그대로 올라간다', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    d.fail(isPut, 'status', 1, { status: 401, reason: 'authError' });
    const { blob } = await blobOf(SIZE);
    await expect(c.uploadResumable(META, blob)).rejects.toBeInstanceOf(AuthError);
  });

  it('기존 파일 갱신은 PATCH ?uploadType=resumable', async () => {
    const d = new FakeDrive();
    const c = client(d, { chunk: CHUNK });
    const first = await c.upload({ ...META, parents: ['root'] }, new Blob(['v1']));
    const { blob, buf } = await blobOf(SIZE);
    const second = await c.uploadResumable({ ...META, parents: ['root'] }, blob, first.id);
    expect(second.id).toBe(first.id);
    const start = d.requests((r) => r.url.searchParams.get('uploadType') === 'resumable')[0]!;
    expect(start.method).toBe('PATCH');
    expect(start.url.pathname).toBe(`/upload/drive/v3/files/${first.id}`);
    expect(d.byName('0001.jpg')).toHaveLength(1);
    expect(d.byName('0001.jpg')[0]!.data.equals(buf)).toBe(true);
  });

  it('빈 파일을 resumable 로 보내면 bytes */0 으로 마무리한다', async () => {
    const d = new FakeDrive();
    await client(d).uploadResumable(META, new Blob([]));
    expect(ranges(d)).toEqual(['bytes */0']);
    expect(d.byName('0001.jpg')).toHaveLength(1);
  });
});

// ── 토큰 제공자 ─────────────────────────────────────────────────
type GisCallback = (resp: Record<string, unknown>) => void;
type GisErrorCallback = (err: Record<string, unknown>) => void;

function installGoogle(respond: (cb: GisCallback, ecb: GisErrorCallback) => void = (cb) => cb({ access_token: 'T1', expires_in: 3600, scope: DRIVE_SCOPE })) {
  const calls = {
    init: [] as Array<Record<string, unknown>>,
    request: [] as Array<unknown>,
    revoked: [] as string[],
  };
  (globalThis as unknown as { google: unknown }).google = {
    accounts: {
      oauth2: {
        initTokenClient: (cfg: { callback: GisCallback; error_callback: GisErrorCallback } & Record<string, unknown>) => {
          calls.init.push(cfg);
          return {
            requestAccessToken: (o: unknown) => {
              calls.request.push(o);
              respond(cfg.callback, cfg.error_callback);
            },
          };
        },
        hasGrantedAllScopes: (resp: { scope?: string }, ...scopes: string[]) => scopes.every((s) => (resp.scope ?? '').split(' ').includes(s)),
        revoke: (token: string, done?: () => void) => {
          calls.revoked.push(token);
          done?.();
        },
      },
    },
  };
  return calls;
}

describe('GisTokenProvider', () => {
  afterEach(() => {
    delete (globalThis as { google?: unknown }).google;
    vi.useRealTimers();
  });
  const loadScript = async () => {};

  it('토큰 클라이언트를 drive.file 범위로 만들고 응답을 메모리에 둔다', async () => {
    const calls = installGoogle();
    let t = 1_000_000;
    const p = new GisTokenProvider('cid', { loadScript, now: () => t });
    let changes = 0;
    p.onChange(() => changes++);
    expect(p.current()).toBeNull();
    await p.requestInteractive();
    expect(calls.init).toHaveLength(1);
    expect(calls.init[0]).toMatchObject({ client_id: 'cid', scope: 'https://www.googleapis.com/auth/drive.file' });
    expect(calls.request).toEqual([{ prompt: '' }]);
    expect(p.current()).toBe('T1');
    expect(changes).toBe(1);
    // 만료 60초 전부터 null
    t += 3600_000 - 60_001;
    expect(p.current()).toBe('T1');
    t += 1;
    expect(p.current()).toBeNull();
  });

  it('권한 범위가 빠지면 실패로 본다', async () => {
    installGoogle((cb) => cb({ access_token: 'T1', expires_in: 3600, scope: 'openid' }));
    const p = new GisTokenProvider('cid', { loadScript });
    await expect(p.requestInteractive()).rejects.toThrow('권한');
    expect(p.current()).toBeNull();
    expect(await p.silentRefresh()).toBe(false);
  });

  it('error 응답과 error_callback 은 reject / false', async () => {
    installGoogle((cb) => cb({ error: 'access_denied' }));
    const p = new GisTokenProvider('cid', { loadScript });
    await expect(p.requestInteractive()).rejects.toThrow('access_denied');

    delete (globalThis as { google?: unknown }).google;
    installGoogle((_cb, ecb) => ecb({ type: 'popup_closed' }));
    const q = new GisTokenProvider('cid', { loadScript });
    await expect(q.requestInteractive()).rejects.toThrow('popup_closed');
    expect(await q.silentRefresh()).toBe(false);
  });

  it('silentRefresh: 성공하면 true 이고 prompt: "" 로 요청한다', async () => {
    const calls = installGoogle();
    const p = new GisTokenProvider('cid', { loadScript });
    expect(await p.silentRefresh()).toBe(true);
    expect(calls.request).toEqual([{ prompt: '' }]);
    expect(p.current()).toBe('T1');
  });

  it('silentRefresh: 20초 안에 응답이 없으면 false', async () => {
    installGoogle(() => {});
    vi.useFakeTimers();
    const p = new GisTokenProvider('cid', { loadScript });
    const result = p.silentRefresh();
    await vi.advanceTimersByTimeAsync(19_999);
    let settled = false;
    void result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(false);
  });

  it('동시에 부르면 요청은 한 번만 보낸다', async () => {
    const calls = installGoogle();
    const p = new GisTokenProvider('cid', { loadScript });
    await Promise.all([p.silentRefresh(), p.silentRefresh(), p.requestInteractive()]);
    expect(calls.request).toHaveLength(1);
    expect(calls.init).toHaveLength(1);
  });

  it('revoke: 구글에 폐기를 알리고 토큰을 버린다', async () => {
    const calls = installGoogle();
    const p = new GisTokenProvider('cid', { loadScript });
    await p.requestInteractive();
    let changes = 0;
    p.onChange(() => changes++);
    await p.revoke();
    expect(calls.revoked).toEqual(['T1']);
    expect(p.current()).toBeNull();
    expect(changes).toBe(1);
  });

  it('브라우저가 아니면 스크립트를 못 불러와 reject / false (import 만으로는 오류가 없다)', async () => {
    await expect(loadGisScript()).rejects.toThrow('브라우저');
    const p = new GisTokenProvider('cid');
    expect(await p.silentRefresh()).toBe(false);
    await expect(p.requestInteractive()).rejects.toThrow();
  });
});

describe('MemoryTokenProvider', () => {
  it('만료 60초 전부터 null, 재발급 결과를 지정할 수 있다', async () => {
    let t = 0;
    const p = new MemoryTokenProvider({ now: () => t });
    let changes = 0;
    p.onChange(() => changes++);
    p.setToken('a', 100);
    expect(p.current()).toBe('a');
    t = 39_999;
    expect(p.current()).toBe('a');
    t = 40_000;
    expect(p.current()).toBeNull();

    expect(await p.silentRefresh()).toBe(false);
    expect(p.current()).toBeNull();
    p.silentResult = true;
    expect(await p.silentRefresh()).toBe(true);
    expect(p.current()).toBe('refreshed-token');
    expect(p.silentCalls).toBe(2);

    p.interactiveError = new Error('팝업 차단');
    await expect(p.requestInteractive()).rejects.toThrow('팝업 차단');
    p.interactiveError = null;
    await p.requestInteractive();
    expect(p.current()).toBe('interactive-token');
    await p.revoke();
    expect(p.current()).toBeNull();
    expect(changes).toBeGreaterThan(3);
  });
});

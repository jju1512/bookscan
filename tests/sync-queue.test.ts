/**
 * 업로드 대기열(queue.ts) 단위 테스트. 실제 Repo(fake-indexeddb + 메모리 파일 저장소)와
 * 가짜 fetch 드라이브, 주입한 가짜 시계·타이머로 돌린다.
 */
import 'fake-indexeddb/auto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { BookJson } from '../src/export/bookjson';
import { openBookscanDB } from '../src/storage/db';
import { MemoryFileStore } from '../src/storage/files';
import { Repo } from '../src/storage/repo';
import { paths, type Book, type Capture } from '../src/storage/types';
import { DriveClient } from '../src/sync/drive';
import { MULTIPART_MAX_BYTES, bookFolderName, pdfFileName } from '../src/sync/names';
import { UploadQueue, backoffMs, type QueueStatus } from '../src/sync/queue';
import { MemoryTokenProvider } from '../src/sync/token';

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

// ── 환경 ────────────────────────────────────────────────────────
/** 가짜 시계와 타이머. 대기열의 now / setTimer 로 주입한다 */
class FakeClock {
  t = 1_000_000;
  timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const e = { at: this.t + ms, fn, cancelled: false };
    this.timers.push(e);
    return () => {
      e.cancelled = true;
    };
  };
  live() {
    return this.timers.filter((x) => !x.cancelled);
  }
  nextAt(): number | undefined {
    const l = this.live();
    return l.length ? Math.min(...l.map((x) => x.at)) : undefined;
  }
  advance(ms: number): void {
    this.t += ms;
    for (const e of this.live().filter((x) => x.at <= this.t)) {
      e.cancelled = true;
      e.fn();
    }
  }
}

interface Env {
  repo: Repo;
  files: MemoryFileStore;
  drive: FakeDrive;
  tokens: MemoryTokenProvider;
  clock: FakeClock;
  queue: UploadQueue;
}

let dbSeq = 0;

async function setup(opts: { concurrency?: number; chunk?: number; latency?: number } = {}): Promise<Env> {
  const db = await openBookscanDB(`sync-queue-${++dbSeq}`);
  const files = new MemoryFileStore();
  let tick = 0;
  let n = 0;
  // 저장소 시계는 호출마다 1씩 늘린다 (updatedAt 이 바뀌었는지 가리려면 값이 달라야 한다)
  const repo = new Repo(db, files, () => 1_700_000_000_000 + ++tick, () => `id${++n}`);
  const drive = new FakeDrive();
  if (opts.latency !== undefined) drive.latencyMs = opts.latency;
  const tokens = new MemoryTokenProvider();
  tokens.setToken('tok');
  const clock = new FakeClock();
  const client = new DriveClient({
    fetch: drive.fetch as typeof fetch,
    getToken: () => tokens.current(),
    ...(opts.chunk ? { resumableChunkBytes: opts.chunk } : {}),
  });
  const queue = new UploadQueue(
    { repo, drive: client, token: tokens, now: clock.now, setTimer: clock.setTimer, appVersion: 'test' },
    opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
  );
  return { repo, files, drive, tokens, clock, queue };
}

const BOOK_CREATED = new Date(2024, 0, 15, 12).getTime();

async function newBook(env: Env, title = '테스트 책'): Promise<Book> {
  return env.repo.createBook({ title, captureMode: 'single', createdAt: BOOK_CREATED });
}

/** 촬영 n장을 저장소에 넣는다 (내용은 장마다 다르다) */
async function shoot(env: Env, bookId: string, count: number): Promise<Capture[]> {
  const out: Capture[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      await env.repo.addCapture(bookId, {
        jpeg: new Blob([bytes(300 + i, i)]),
        thumb: new Blob(['t']),
        width: 100,
        height: 100,
        sharpness: 1,
      }),
    );
  }
  return out;
}

const cap = async (env: Env, id: string): Promise<Capture> => (await env.repo.getCapture(id))!;
const folderPath = (title = '테스트 책') => `BookScan/${bookFolderName(title, BOOK_CREATED)}`;
/** 이 이름의 파일을 올리는 multipart 요청 (JSON 파트에 이름이 들어 있다) */
const uploadOf = (name: string) => (r: Req) => isUploadPost(r) && r.head.includes(`"name":"${name}"`);
const isUploadPost = (r: Req) => r.method === 'POST' && r.url.pathname === '/upload/drive/v3/files' && r.url.searchParams.get('uploadType') === 'multipart';

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: 시간 초과');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** 더 할 일이 없을 때까지 가짜 시계를 가장 가까운 타이머로 계속 넘긴다 */
async function settle(env: Env, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await env.queue.idle();
    const next = env.clock.nextAt();
    if (next === undefined) return;
    env.clock.advance(Math.max(0, next - env.clock.t));
  }
  throw new Error('settle: 끝나지 않는다');
}

// ── 테스트 ──────────────────────────────────────────────────────
describe('backoffMs', () => {
  it('2초, 4초, 8초 … 최대 5분', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000]);
    expect(backoffMs(9)).toBe(300_000);
    expect(backoffMs(1000)).toBe(300_000);
    expect(backoffMs(0)).toBe(2000);
  });
});

describe('업로드 대기열: 기본 동작', () => {
  it('촬영을 original/ 에 올리고 driveFileId·book.json 을 남긴다', async () => {
    const env = await setup();
    const book = await newBook(env);
    const caps = await shoot(env, book.id, 3);
    env.queue.start();
    await env.queue.idle();

    const base = folderPath();
    expect(env.drive.tree()).toEqual(
      [
        'BookScan/',
        `${base}/`,
        `${base}/book.json`,
        `${base}/original/`,
        `${base}/original/0001.jpg`,
        `${base}/original/0002.jpg`,
        `${base}/original/0003.jpg`,
      ].sort(),
    );
    for (const [i, c] of caps.entries()) {
      const now = await cap(env, c.id);
      const remote = env.drive.byName(`000${i + 1}.jpg`)[0]!;
      expect(now.upload).toMatchObject({ state: 'done', driveFileId: remote.id, attempts: 0, checkRemote: false });
      expect(now.upload.lastError).toBeUndefined();
      expect(now.upload.nextAttemptAt).toBeUndefined();
      expect(remote.mimeType).toBe('image/jpeg');
      expect(remote.appProperties).toEqual({ bookscanBookId: book.id, bookscanSeq: String(i + 1) });
      expect(remote.data.equals(Buffer.from(bytes(300 + i, i)))).toBe(true);
    }
    const saved = (await env.repo.getBook(book.id))!;
    expect(saved.driveFolderId).toBe(env.drive.folders(bookFolderName(book.title, BOOK_CREATED))[0]!.id);
    expect(saved.driveOriginalFolderId).toBe(env.drive.folders('original')[0]!.id);
    expect(await env.repo.getKv('drive.rootFolderId')).toBe(env.drive.folders('BookScan')[0]!.id);
    expect(env.queue.status()).toMatchObject({ pending: 0, running: 0, failed: 0, done: 3, needsReconnect: false, paused: null });
    expect(env.queue.status().lastError).toBeUndefined();
  });

  it('동시에 2개까지만 올린다', async () => {
    const env = await setup({ latency: 12 });
    const book = await newBook(env);
    await shoot(env, book.id, 6);
    env.queue.start();
    await env.queue.idle();
    expect(env.drive.byName('0001.jpg')).toHaveLength(1);
    expect(env.drive.maxInFlight).toBe(2);
    expect((await env.repo.allCaptures()).every((c) => c.upload.state === 'done')).toBe(true);
  });

  it('concurrency 옵션: 1이면 한 번에 하나', async () => {
    const env = await setup({ latency: 8, concurrency: 1 });
    const book = await newBook(env);
    await shoot(env, book.id, 3);
    env.queue.start();
    await env.queue.idle();
    expect(env.drive.maxInFlight).toBe(1);
    expect(env.queue.status().done).toBe(3);
  });

  it('폴더는 책마다 한 번만 만든다 (동시에 2개를 올려도)', async () => {
    const env = await setup({ latency: 10 });
    const a = await newBook(env, '책 A');
    const b = await newBook(env, '책 B');
    await shoot(env, a.id, 2);
    await shoot(env, b.id, 2);
    env.queue.start();
    await env.queue.idle();

    expect(env.drive.folders('BookScan')).toHaveLength(1);
    expect(env.drive.folders(bookFolderName('책 A', BOOK_CREATED))).toHaveLength(1);
    expect(env.drive.folders(bookFolderName('책 B', BOOK_CREATED))).toHaveLength(1);
    expect(env.drive.folders('original')).toHaveLength(2);
    // 폴더 만들기(POST /drive/v3/files)는 루트 1 + 책 2 + original 2
    expect(env.drive.requests((r) => r.method === 'POST' && r.url.pathname === '/drive/v3/files')).toHaveLength(5);
    expect(env.queue.status().done).toBe(4);
  });

  it('지운 촬영은 올리지 않는다', async () => {
    const env = await setup();
    const book = await newBook(env);
    const caps = await shoot(env, book.id, 3);
    await env.repo.deleteCapture(caps[1]!.id);
    env.queue.start();
    await env.queue.idle();
    expect(env.drive.byName('0001.jpg')).toHaveLength(1);
    expect(env.drive.byName('0002.jpg')).toHaveLength(0);
    expect(env.drive.byName('0003.jpg')).toHaveLength(1);
    expect((await cap(env, caps[1]!.id)).upload.state).toBe('pending');
    expect(env.queue.status()).toMatchObject({ pending: 0, done: 2, failed: 0 });
    const meta = JSON.parse(env.drive.byName('book.json')[0]!.data.toString()) as { captures: unknown[] };
    expect(meta.captures).toHaveLength(2);
  });

  it('stop() 하면 새 작업을 시작하지 않고, start() 하면 이어서 올린다', async () => {
    const env = await setup();
    const book = await newBook(env);
    env.queue.start();
    env.queue.stop();
    await shoot(env, book.id, 2);
    await env.queue.idle();
    expect(env.drive.log).toHaveLength(0);
    expect(env.queue.status()).toMatchObject({ paused: 'stopped', pending: 2 });
    env.queue.start();
    await env.queue.idle();
    expect(env.queue.status()).toMatchObject({ paused: null, done: 2, pending: 0 });
  });

  it('onStatus 로 바뀔 때마다 알린다 (구독 해제 가능)', async () => {
    const env = await setup();
    const book = await newBook(env);
    await shoot(env, book.id, 2);
    const seen: QueueStatus[] = [];
    const off = env.queue.onStatus((s) => seen.push(s));
    env.queue.start();
    await env.queue.idle();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.some((s) => s.pending === 2 && s.paused === null)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ done: 2, pending: 0, running: 0 });
    off();
    const count = seen.length;
    await shoot(env, book.id, 1);
    await env.queue.idle();
    expect(seen).toHaveLength(count);
  });

  it('로컬 원본이 없으면 failed + "로컬 원본 없음" 으로 기록하고 나머지는 계속 올린다', async () => {
    const env = await setup();
    const book = await newBook(env);
    const caps = await shoot(env, book.id, 2);
    await env.files.remove(caps[0]!.file);
    env.queue.start();
    await env.queue.idle();
    const first = await cap(env, caps[0]!.id);
    expect(first.upload).toMatchObject({ state: 'failed', attempts: 1, lastError: '로컬 원본 없음', nextAttemptAt: env.clock.t + 2000 });
    expect((await cap(env, caps[1]!.id)).upload.state).toBe('done');
    expect(env.queue.status()).toMatchObject({ failed: 1, done: 1, lastError: '로컬 원본 없음' });
  });
});

describe('업로드 대기열: 실패와 백오프', () => {
  it('실패하면 attempts·lastError·nextAttemptAt 을 2s, 4s, 8s … 최대 5분으로 남기고 시간이 지나면 다시 올린다', async () => {
    const env = await setup();
    const book = await newBook(env);
    const [c] = await shoot(env, book.id, 1);
    env.drive.fail(uploadOf('0001.jpg'), 'status', 10, { status: 500, message: 'Backend Error' });
    env.queue.start();
    await env.queue.idle();

    const delays = [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300_000, 300_000];
    for (const [i, delay] of delays.entries()) {
      const attempts = i + 1;
      const now = (await cap(env, c!.id)).upload;
      expect(now).toMatchObject({ state: 'failed', attempts, lastError: '드라이브 응답 500: Backend Error' });
      expect(now.nextAttemptAt).toBe(env.clock.t + delay);
      expect(env.queue.status()).toMatchObject({ failed: 1, pending: 0, running: 0, paused: null, lastError: '드라이브 응답 500: Backend Error' });
      // 가장 이른 nextAttemptAt 에 타이머가 하나 걸려 있다
      expect(env.clock.live().map((x) => x.at)).toEqual([now.nextAttemptAt]);

      env.clock.advance(delay - 1);
      await env.queue.idle();
      expect((await cap(env, c!.id)).upload.attempts).toBe(attempts); // 아직 시간이 안 됐다
      env.clock.advance(1);
      await env.queue.idle();
    }

    const done = (await cap(env, c!.id)).upload;
    expect(done).toMatchObject({ state: 'done', attempts: 10 });
    expect(done.lastError).toBeUndefined();
    expect(done.nextAttemptAt).toBeUndefined();
    expect(env.drive.byName('0001.jpg')).toHaveLength(1);
    expect(env.queue.status()).toMatchObject({ failed: 0, done: 1 });
    expect(env.queue.status().lastError).toBeUndefined();
  });

  it('드라이브가 안 되어도 촬영(저장소 쓰기)은 막히지 않는다', async () => {
    const env = await setup();
    const book = await newBook(env);
    env.drive.fail(() => true, 'network', 1000);
    env.queue.start();
    await shoot(env, book.id, 2);
    await env.queue.idle();
    const more = await shoot(env, book.id, 1); // 대기열이 실패 중이어도 그대로 저장된다
    expect(more).toHaveLength(1);
    await env.queue.idle();
    const all = await env.repo.allCaptures();
    expect(all).toHaveLength(3);
    expect(all.filter((c) => c.upload.state === 'failed').length).toBeGreaterThan(0);
    expect(env.queue.status().lastError).toContain('네트워크 오류');
  });

  it('업로드가 서버에 들어갔는데 응답이 끊기면, 다시 할 때 이름으로 찾아 done 으로 한다 (파일은 하나)', async () => {
    const env = await setup();
    const book = await newBook(env);
    const [c] = await shoot(env, book.id, 1);
    env.drive.fail(uploadOf('0001.jpg'), 'after', 1);
    env.queue.start();
    await env.queue.idle();

    const failed = (await cap(env, c!.id)).upload;
    expect(failed).toMatchObject({ state: 'failed', attempts: 1 });
    expect(failed.lastError).toContain('네트워크 오류');
    expect(env.drive.byName('0001.jpg')).toHaveLength(1); // 서버에는 올라가 있다

    env.clock.advance(2000);
    await env.queue.idle();
    const done = (await cap(env, c!.id)).upload;
    expect(done).toMatchObject({ state: 'done', driveFileId: env.drive.byName('0001.jpg')[0]!.id });
    expect(env.drive.byName('0001.jpg')).toHaveLength(1);
    // 재시도에서는 0001.jpg 를 다시 올리지 않았다
    expect(env.drive.multiparts.filter((m) => m.meta.name === '0001.jpg')).toHaveLength(1);
  });

  it('앱이 죽어 running 으로 남은 촬영은 recover() 뒤 checkRemote 로 드라이브를 먼저 확인한다', async () => {
    const env = await setup();
    const book = await newBook(env);
    const [c1] = await shoot(env, book.id, 1);
    env.queue.start();
    await env.queue.idle();
    env.queue.stop();
    expect((await cap(env, c1!.id)).upload.state).toBe('done');

    const [c2] = await shoot(env, book.id, 1);
    const saved = (await env.repo.getBook(book.id))!;
    // 서버에는 올라갔는데 앱이 done 을 적기 전에 죽은 상황
    const remote = env.drive.put('0002.jpg', saved.driveOriginalFolderId!, Buffer.from('server copy'));
    await env.repo.setUpload(c2!.id, { state: 'running' });
    expect(await env.repo.recover()).toMatchObject({ uploads: 1 });
    expect((await cap(env, c2!.id)).upload).toMatchObject({ state: 'pending', checkRemote: true, attempts: 0 });

    env.queue.start();
    await env.queue.idle();
    expect((await cap(env, c2!.id)).upload).toMatchObject({ state: 'done', driveFileId: remote.id, checkRemote: false });
    expect(env.drive.byName('0002.jpg')).toHaveLength(1);
    expect(env.drive.multiparts.filter((m) => m.meta.name === '0002.jpg')).toHaveLength(0);
    // book.json 은 두 장의 driveFileId 를 모두 담는다
    const meta = JSON.parse(env.drive.byName('book.json')[0]!.data.toString()) as { captures: Array<{ driveFileId?: string }> };
    expect(meta.captures.map((x) => x.driveFileId)).toEqual([env.drive.byName('0001.jpg')[0]!.id, remote.id]);
  });

  it('부모 폴더가 사라져 404 가 나면 캐시한 폴더 ID 를 버리고 다음 시도에서 다시 만든다', async () => {
    const env = await setup();
    const book = await newBook(env);
    await shoot(env, book.id, 1);
    env.queue.start();
    await env.queue.idle();
    const oldFolder = (await env.repo.getBook(book.id))!.driveFolderId!;
    env.drive.removeTree(oldFolder); // 사용자가 드라이브에서 책 폴더를 지웠다

    const [c2] = await shoot(env, book.id, 1);
    await env.queue.idle();
    const failed = (await cap(env, c2!.id)).upload;
    expect(failed).toMatchObject({ state: 'failed', attempts: 1 });
    expect(failed.lastError).toContain('드라이브 응답 404');

    await settle(env);
    const base = folderPath();
    expect(env.drive.tree()).toEqual(['BookScan/', `${base}/`, `${base}/book.json`, `${base}/original/`, `${base}/original/0002.jpg`].sort());
    // 지워진 폴더 ID 를 계속 쓰면 영원히 404 이므로, 끝났다는 것 자체가 캐시를 버렸다는 증거다
    expect((await cap(env, c2!.id)).upload.state).toBe('done');
    expect((await env.repo.getBook(book.id))!.driveFolderId).not.toBe(oldFolder);
    expect(env.drive.folders('BookScan')).toHaveLength(1);
  });
});

describe('업로드 대기열: 로그인 만료', () => {
  it('401 → 멈추고 silentRefresh 를 한 번만 부른다. 성공하면 재개해서 올린다 (attempts 증가 없음)', async () => {
    const env = await setup({ latency: 8 });
    env.tokens.setToken('stale');
    env.tokens.silentResult = true;
    env.drive.validToken = 'refreshed-token';
    const book = await newBook(env);
    const caps = await shoot(env, book.id, 2);
    env.queue.start();
    await env.queue.idle();

    expect(env.tokens.silentCalls).toBe(1);
    for (const c of caps) expect(await cap(env, c.id)).toMatchObject({ upload: { state: 'done', attempts: 0 } });
    expect(env.queue.status()).toMatchObject({ needsReconnect: false, paused: null, done: 2, failed: 0 });
    const auth = env.drive.log.map((r) => r.headers.get('Authorization'));
    expect(auth[0]).toBe('Bearer stale');
    expect(auth.at(-1)).toBe('Bearer refreshed-token');
    expect(env.drive.byName('0001.jpg')).toHaveLength(1);
  });

  it('새 토큰을 받기 전에 보낸 요청이 늦게 401 로 돌아와도 다시 멈추지 않는다', async () => {
    const env = await setup();
    env.tokens.setToken('stale');
    env.tokens.silentResult = true;
    env.drive.validToken = 'refreshed-token';
    // 책 B 의 첫 요청만 아주 느리다: 책 A 의 401 로 재발급이 끝난 뒤에야 책 B 의 401 이 돌아온다
    env.drive.slow = (r) => (r.url.searchParams.get('q')?.includes('책 B') ? 150 : undefined);
    await env.repo.setKv('drive.rootFolderId', 'root'); // 루트 폴더 찾기는 건너뛴다 (두 책이 잠금을 나누지 않게)
    const a = await newBook(env, '책 A');
    const b = await newBook(env, '책 B');
    const [ca] = await shoot(env, a.id, 1);
    const [cb] = await shoot(env, b.id, 1);
    env.queue.start();
    await env.queue.idle();

    expect(env.tokens.silentCalls).toBe(1);
    expect(env.queue.status()).toMatchObject({ needsReconnect: false, paused: null, done: 2, failed: 0 });
    expect((await cap(env, ca!.id)).upload).toMatchObject({ state: 'done', attempts: 0 });
    expect((await cap(env, cb!.id)).upload).toMatchObject({ state: 'done', attempts: 0 });
    // 옛 토큰으로 간 요청이 두 책에서 모두 있었다
    expect(env.drive.log.filter((r) => r.headers.get('Authorization') === 'Bearer stale').length).toBeGreaterThanOrEqual(2);
  });

  it('silentRefresh 가 실패하면 needsReconnect, 그동안 요청하지 않고, reconnected() 뒤에 올린다', async () => {
    const env = await setup();
    env.tokens.setToken('stale');
    env.drive.validToken = 'new-token';
    const book = await newBook(env);
    const caps = await shoot(env, book.id, 2);
    env.queue.start();
    await env.queue.idle();

    expect(env.tokens.silentCalls).toBe(1);
    expect(env.queue.status()).toMatchObject({ needsReconnect: true, paused: 'auth', pending: 2, failed: 0, done: 0 });
    expect(env.queue.status().lastError).toContain('로그인');
    for (const c of caps) expect(await cap(env, c.id)).toMatchObject({ upload: { state: 'pending', attempts: 0 } });
    expect(env.clock.live()).toHaveLength(0);

    // 멈춰 있는 동안에는 새 촬영이 생겨도 요청하지 않는다
    const sent = env.drive.log.length;
    await shoot(env, book.id, 1);
    await env.queue.idle();
    expect(env.drive.log).toHaveLength(sent);
    expect(env.tokens.silentCalls).toBe(1);

    // 사용자가 "드라이브 다시 연결" 을 눌러 토큰을 받았다
    env.tokens.setToken('new-token');
    env.queue.reconnected();
    expect(env.queue.status()).toMatchObject({ needsReconnect: false, paused: null });
    await env.queue.idle();
    expect(env.queue.status()).toMatchObject({ done: 3, pending: 0, failed: 0, needsReconnect: false });
    for (const c of await env.repo.allCaptures()) expect(c.upload.attempts).toBe(0);
    expect(env.tokens.silentCalls).toBe(1);
  });

  it('토큰이 없으면(null) 요청하지 않고 AuthError 경로로 간다', async () => {
    const env = await setup();
    env.tokens.setToken(null);
    const book = await newBook(env);
    await shoot(env, book.id, 1);
    env.queue.start();
    await env.queue.idle();
    expect(env.drive.log).toHaveLength(0);
    expect(env.tokens.silentCalls).toBe(1);
    expect(env.queue.status()).toMatchObject({ needsReconnect: true, paused: 'auth', pending: 1 });

    env.tokens.setToken('tok');
    env.queue.reconnected();
    await env.queue.idle();
    expect(env.queue.status()).toMatchObject({ done: 1, needsReconnect: false });
  });

  it('토큰이 만료 60초 전이면 current() 가 null 이라 같은 경로로 간다', async () => {
    const env = await setup();
    env.tokens.setToken('short', 30); // 30초짜리 = 이미 "만료 임박"
    env.tokens.silentResult = true;
    const book = await newBook(env);
    await shoot(env, book.id, 1);
    env.queue.start();
    await env.queue.idle();
    expect(env.tokens.silentCalls).toBe(1);
    expect(env.queue.status()).toMatchObject({ done: 1, needsReconnect: false });
    expect(env.drive.log.every((r) => r.headers.get('Authorization') === 'Bearer refreshed-token')).toBe(true);
  });
});

describe('업로드 대기열: 오프라인', () => {
  it('setOnline(false) 동안 시작하지 않고, true 가 되면 남은 것을 올린다 (비행기 모드 촬영)', async () => {
    const env = await setup();
    const book = await newBook(env);
    env.queue.setOnline(false);
    env.queue.start();
    await shoot(env, book.id, 3);
    await env.queue.idle();
    expect(env.drive.log).toHaveLength(0);
    expect(env.queue.status()).toMatchObject({ paused: 'offline', pending: 3, done: 0 });

    env.queue.setOnline(true);
    await env.queue.idle();
    expect(env.queue.status()).toMatchObject({ paused: null, pending: 0, done: 3 });
    expect(env.drive.byName('0003.jpg')).toHaveLength(1);
  });

  it('올리는 도중 오프라인이 되면 진행 중인 것만 끝내고 새로 시작하지 않는다', async () => {
    const env = await setup({ latency: 15 });
    const book = await newBook(env);
    await shoot(env, book.id, 6);
    env.queue.start();
    await until(() => env.drive.log.length > 0);
    env.queue.setOnline(false);
    await env.queue.idle();
    const mid = env.queue.status();
    expect(mid.paused).toBe('offline');
    expect(mid.done).toBeLessThan(6);
    expect(mid.pending).toBeGreaterThan(0);
    expect(mid.running).toBe(0);

    env.queue.setOnline(true);
    await env.queue.idle();
    expect(env.queue.status()).toMatchObject({ done: 6, pending: 0 });
    expect(env.drive.maxInFlight).toBeLessThanOrEqual(2);
  });
});

describe('업로드 대기열: book.json 과 PDF', () => {
  it('촬영 업로드가 끝난 뒤 올라가고 driveFileId 를 담는다. 다시 dirty 가 되면 같은 파일을 갱신한다', async () => {
    const env = await setup();
    const book = await newBook(env);
    await shoot(env, book.id, 2);
    env.queue.start();
    await env.queue.idle();

    // 업로드 순서: 사진 두 장이 모두 끝난 뒤 book.json
    expect(env.drive.multiparts.map((m) => m.meta.name).sort()).toEqual(['0001.jpg', '0002.jpg', 'book.json']);
    expect(env.drive.multiparts.at(-1)!.meta.name).toBe('book.json');
    const saved = (await env.repo.getBook(book.id))!;
    expect(saved.driveMetaDirty).toBe(false);
    const metaFile = env.drive.byName('book.json')[0]!;
    expect(saved.driveMetaFileId).toBe(metaFile.id);
    expect(metaFile.mimeType).toBe('application/json');
    const json = JSON.parse(metaFile.data.toString()) as BookJson;
    expect(json).toMatchObject({ format: 'bookscan-book', app: 'bookscan test', book: { id: book.id, title: '테스트 책' } });
    expect(json.captures.map((x) => [x.file, x.driveFileId])).toEqual([
      ['original/0001.jpg', env.drive.byName('0001.jpg')[0]!.id],
      ['original/0002.jpg', env.drive.byName('0002.jpg')[0]!.id],
    ]);

    // 한 장 더 찍으면 dirty → 같은 book.json 을 갱신 (PATCH)
    await shoot(env, book.id, 1);
    expect((await env.repo.getBook(book.id))!.driveMetaDirty).toBe(true);
    await env.queue.idle();
    expect(env.drive.byName('book.json')).toHaveLength(1);
    expect(env.drive.byName('book.json')[0]!.id).toBe(metaFile.id);
    const patch = env.drive.requests((r) => r.method === 'PATCH');
    expect(patch).toHaveLength(1);
    expect(patch[0]!.url.pathname).toBe(`/upload/drive/v3/files/${metaFile.id}`);
    const json2 = JSON.parse(env.drive.byName('book.json')[0]!.data.toString()) as BookJson;
    expect(json2.captures).toHaveLength(3);
    expect(json2.captures.every((x) => x.driveFileId)).toBe(true);
    expect((await env.repo.getBook(book.id))!.driveMetaDirty).toBe(false);
  });

  it('book.json 이 이미 드라이브에 있고 ID 를 모르면 이름으로 찾아 갱신한다', async () => {
    const env = await setup();
    const book = await newBook(env);
    await shoot(env, book.id, 1);
    env.queue.start();
    await env.queue.idle();
    const id = env.drive.byName('book.json')[0]!.id;
    // 앱 데이터에서 ID 가 사라진 상황
    await env.repo.updateBook(book.id, { driveMetaFileId: undefined, driveMetaDirty: true }, false);
    await env.queue.idle();
    expect(env.drive.byName('book.json')).toHaveLength(1);
    expect(env.drive.byName('book.json')[0]!.id).toBe(id);
    expect((await env.repo.getBook(book.id))!.driveMetaFileId).toBe(id);
  });

  it('백오프 대기 중인 촬영은 book.json 을 막지 않고, 그 촬영이 끝나면 book.json 을 다시 올린다', async () => {
    const env = await setup();
    const book = await newBook(env);
    await shoot(env, book.id, 2);
    env.drive.fail(isUploadPost, 'status', 1, { status: 500 });
    env.queue.start();
    await env.queue.idle();

    expect(env.queue.status()).toMatchObject({ failed: 1, done: 1 });
    const early = JSON.parse(env.drive.byName('book.json')[0]!.data.toString()) as BookJson;
    expect(early.captures.filter((x) => x.driveFileId)).toHaveLength(1);

    await settle(env);
    expect(env.queue.status()).toMatchObject({ failed: 0, done: 2 });
    expect(env.drive.byName('book.json')).toHaveLength(1);
    const final = JSON.parse(env.drive.byName('book.json')[0]!.data.toString()) as BookJson;
    expect(final.captures.filter((x) => x.driveFileId)).toHaveLength(2);
    expect((await env.repo.getBook(book.id))!.driveMetaDirty).toBe(false);
  });

  it('book.json 업로드가 실패하면 책별로 백오프하고 dirty 를 유지한다', async () => {
    const env = await setup();
    const book = await newBook(env);
    await shoot(env, book.id, 1);
    // 사진(첫 multipart)은 통과, book.json(두 번째)만 두 번 실패
    let posts = 0;
    env.drive.fail((r) => isUploadPost(r) && ++posts > 1, 'status', 2, { status: 503 });
    env.queue.start();
    await env.queue.idle();
    expect((await env.repo.getBook(book.id))!.driveMetaDirty).toBe(true);
    expect(env.drive.byName('book.json')).toHaveLength(0);
    expect(env.queue.status().lastError).toContain('503');
    expect(env.clock.live().map((x) => x.at)).toEqual([env.clock.t + 2000]);

    env.clock.advance(2000);
    await env.queue.idle();
    expect(env.clock.live().map((x) => x.at)).toEqual([env.clock.t + 4000]); // 두 번째 실패는 4초
    env.clock.advance(4000);
    await env.queue.idle();
    expect(env.drive.byName('book.json')).toHaveLength(1);
    expect((await env.repo.getBook(book.id))!.driveMetaDirty).toBe(false);
    expect(env.queue.status().lastError).toBeUndefined();
  });

  it('PDF 는 책 폴더에 올리고(5MB 초과는 resumable), 다시 올리면 같은 파일을 갱신한다', async () => {
    const env = await setup({ chunk: 1024 * 1024 });
    const book = await newBook(env);
    await shoot(env, book.id, 1);
    const pdfPath = paths.exportFile(book.id, 'out.pdf');
    const v1 = bytes(MULTIPART_MAX_BYTES + 1000, 3);
    await env.files.write(pdfPath, new Blob([v1]));
    await env.repo.putJob({
      id: 'job1',
      bookId: book.id,
      kind: 'pdf',
      file: pdfPath,
      name: pdfFileName(book.title),
      upload: { state: 'pending', attempts: 0 },
      createdAt: 1,
    });
    env.queue.start();
    await env.queue.idle();

    const pdfs = env.drive.byName('테스트 책.pdf');
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]!.parents).toEqual([(await env.repo.getBook(book.id))!.driveFolderId]);
    expect(pdfs[0]!.mimeType).toBe('application/pdf');
    expect(pdfs[0]!.data.equals(Buffer.from(v1))).toBe(true);
    expect(env.drive.sessions.size).toBe(1);
    const job = (await env.repo.allJobs())[0]!;
    expect(job.upload).toMatchObject({ state: 'done', driveFileId: pdfs[0]!.id, attempts: 0 });
    expect(env.queue.status()).toMatchObject({ done: 2, pending: 0, failed: 0 });

    // 같은 이름의 PDF 를 다시 올린다 → 새 파일을 만들지 않고 갱신
    const v2 = bytes(MULTIPART_MAX_BYTES + 2000, 9);
    await env.files.write(pdfPath, new Blob([v2]));
    await env.repo.setJobUpload('job1', { state: 'pending' });
    await env.queue.idle();
    expect(env.drive.byName('테스트 책.pdf')).toHaveLength(1);
    expect(env.drive.byName('테스트 책.pdf')[0]!.id).toBe(pdfs[0]!.id);
    expect(env.drive.byName('테스트 책.pdf')[0]!.data.equals(Buffer.from(v2))).toBe(true);
    const start = env.drive.requests((r) => r.method === 'PATCH' && r.url.searchParams.get('uploadType') === 'resumable');
    expect(start).toHaveLength(1);
  });

  it('PDF 업로드 실패도 촬영과 같은 백오프 규칙을 따른다', async () => {
    const env = await setup();
    const book = await newBook(env);
    const pdfPath = paths.exportFile(book.id, 'out.pdf');
    await env.files.write(pdfPath, new Blob(['%PDF-small']));
    await env.repo.updateBook(book.id, { driveMetaDirty: false }, false);
    await env.repo.putJob({ id: 'job1', bookId: book.id, kind: 'pdf', file: pdfPath, name: 'a.pdf', upload: { state: 'pending', attempts: 0 }, createdAt: 1 });
    env.drive.fail(isUploadPost, 'status', 1, { status: 500, message: 'Backend Error' });
    env.queue.start();
    await env.queue.idle();
    const failed = (await env.repo.allJobs())[0]!.upload;
    expect(failed).toMatchObject({ state: 'failed', attempts: 1, lastError: '드라이브 응답 500: Backend Error', nextAttemptAt: env.clock.t + 2000 });
    expect(env.queue.status().failed).toBe(1);
    await settle(env);
    expect((await env.repo.allJobs())[0]!.upload).toMatchObject({ state: 'done', attempts: 1 });
    expect(env.drive.byName('a.pdf')).toHaveLength(1);
  });
});

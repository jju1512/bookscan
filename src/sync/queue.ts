/**
 * 업로드 대기열 (SPEC 7장 "업로드 대기열", "로그인 만료 처리").
 *
 * - Capture.upload / BookJob.upload 의 state 를 기준으로 동작한다. 상태는 모두 저장소(IndexedDB)에 있고,
 *   이 클래스가 메모리에 따로 갖는 것은 "지금 돌고 있는 작업", 책별 폴더 잠금, book.json 백오프뿐이다.
 * - 동시에 최대 2개. 실패하면 2초·4초·8초… 최대 5분 간격으로 다시 한다.
 * - 어떤 오류도 밖으로 던지지 않는다. 오류는 lastError 에 남긴다 (촬영을 막지 않는다).
 */
import { buildBookJson, originalName } from '../export/bookjson';
import type { Repo } from '../storage/repo';
import type { BookJob, Capture, UploadInfo } from '../storage/types';
import { AuthError, DriveError, type DriveClient } from './drive';
import { BOOK_JSON_NAME, ORIGINAL_FOLDER_NAME, ROOT_FOLDER_NAME, bookFolderName } from './names';
import type { TokenProvider } from './token';

const ROOT_KV = 'drive.rootFolderId';
const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
/** 재로그인 직후 또 401 이면 팝업 없는 재발급을 돌리지 않고 바로 "다시 연결" 로 넘긴다 (무한 반복 방지) */
const AUTH_LOOP_GUARD_MS = 10_000;

export interface QueueDeps {
  repo: Repo;
  drive: DriveClient;
  token: Pick<TokenProvider, 'silentRefresh'>;
  now?: () => number;
  /** 기본 setTimeout. 반환값은 취소 함수 */
  setTimer?: (fn: () => void, ms: number) => () => void;
  appVersion?: string;
}

export type PauseReason = 'offline' | 'auth' | 'stopped' | null;

export interface QueueStatus {
  /** 올릴 차례를 기다리는 것 (백오프 대기 중인 실패 건은 failed 쪽) */
  pending: number;
  running: number;
  failed: number;
  done: number;
  needsReconnect: boolean;
  paused: PauseReason;
  lastError?: string;
}

/** attempts=1 → 2초, 2 → 4초, 3 → 8초 … 최대 5분 */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}

interface Task {
  key: string;
  run: () => Promise<void>;
}

interface Folders {
  bookFolderId: string;
  originalFolderId: string;
}

type Counts = Pick<QueueStatus, 'pending' | 'running' | 'failed' | 'done'>;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class UploadQueue {
  private readonly repo: Repo;
  private readonly drive: DriveClient;
  private readonly tokens: Pick<TokenProvider, 'silentRefresh'>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  private readonly appVersion: string | undefined;
  private readonly concurrency: number;

  private active = false;
  private online = true;
  private authPaused = false;
  private needsReconnect = false;
  /** reconnected() 가 불릴 때마다 올린다. 진행 중이던 재발급 결과를 버리는 데 쓴다 */
  private authGen = 0;
  /** 새 토큰을 받을 때마다(재발급 성공·다시 연결) 올린다. 옛 토큰으로 보낸 요청의 401 을 가려내는 데 쓴다 */
  private tokenEpoch = 0;
  private lastRefreshAt: number | undefined;
  private lastError: string | undefined;

  private counts: Counts = { pending: 0, running: 0, failed: 0, done: 0 };
  private lastPublished = '';
  private readonly listeners = new Set<(s: QueueStatus) => void>();

  /** 지금 도는 작업의 키 (cap:<id> / job:<id> / meta:<bookId>) */
  private readonly running = new Set<string>();
  private pumping = false;
  private pumpAgain = false;
  /** 마지막 훑기에서 시작할 수 있었던(아직 안 시작한 것 포함) 작업 수 */
  private startable = 0;
  private idleWaiters: Array<() => void> = [];
  private cancelTimer: (() => void) | null = null;

  private rootLock: Promise<string> | null = null;
  private readonly folderLocks = new Map<string, Promise<Folders>>();
  /** 저장소에 실패를 못 적었을 때와 book.json 실패 때 쓰는 메모리 백오프 */
  private readonly memBackoff = new Map<string, { attempts: number; nextAt: number }>();
  /** book.json 올리는 동안 대기열이 직접 dirty 로 만든 횟수 (책별) */
  private readonly metaGen = new Map<string, number>();

  constructor(deps: QueueDeps, opts: { concurrency?: number } = {}) {
    this.repo = deps.repo;
    this.drive = deps.drive;
    this.tokens = deps.token;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const h = setTimeout(fn, ms);
        return () => clearTimeout(h);
      });
    this.appVersion = deps.appVersion;
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.repo.subscribe((e) => {
      if (e.type === 'captures' || e.type === 'jobs' || e.type === 'book') this.kick();
    });
  }

  // ── 제어 ───────────────────────────────────────────────
  start(): void {
    this.active = true;
    this.publish();
    this.kick();
  }

  /** 새 작업을 시작하지 않는다. 진행 중인 것은 끝까지 가서 결과만 기록한다 */
  stop(): void {
    this.active = false;
    this.clearTimer();
    this.publish();
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.publish();
    if (online) this.kick();
  }

  /** 지금 다시 훑는다 */
  kick(): void {
    void this.pump();
  }

  /** 사용자가 "드라이브 다시 연결" 로 토큰을 받은 뒤 부른다 */
  reconnected(): void {
    this.authGen++;
    this.tokenEpoch++;
    this.lastRefreshAt = undefined;
    this.authPaused = false;
    this.needsReconnect = false;
    this.publish();
    this.kick();
  }

  status(): QueueStatus {
    return {
      ...this.counts,
      needsReconnect: this.needsReconnect,
      paused: this.pauseReason(),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  onStatus(fn: (s: QueueStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 시작할 수 있는 작업도, 진행 중인 것도 없을 때 resolve (백오프 대기·멈춤 상태는 "없음"으로 본다) */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      this.kick();
    });
  }

  private pauseReason(): PauseReason {
    if (!this.active) return 'stopped';
    if (this.authPaused) return 'auth';
    if (!this.online) return 'offline';
    return null;
  }

  private publish(): void {
    const s = this.status();
    const key = JSON.stringify(s);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    for (const fn of this.listeners) {
      try {
        fn(s);
      } catch {
        // 화면 갱신 오류가 업로드를 막지 않게 한다
      }
    }
  }

  private noteError(e: unknown): void {
    this.lastError = errorMessage(e);
    this.publish();
  }

  // ── 훑기 ───────────────────────────────────────────────
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        try {
          await this.scan();
        } catch (e) {
          this.startable = 0;
          this.noteError(e);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
    if (this.running.size === 0 && this.startable === 0 && this.idleWaiters.length > 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private async scan(): Promise<void> {
    const now = this.now();
    const [allCaps, allJobs, books] = await Promise.all([this.repo.allCaptures(), this.repo.allJobs(), this.repo.listBooks()]);
    const caps = allCaps.filter((c) => !c.deleted).sort((a, b) => a.capturedAt - b.capturedAt || a.seq - b.seq);
    const pdfJobs = allJobs.filter((j) => j.kind === 'pdf');

    this.counts = tally([...caps.map((c) => c.upload), ...pdfJobs.map((j) => j.upload)]);
    // 진행 중인 작업이 없을 때만 지운다 (실패를 적는 중에 지우면 방금 남긴 오류가 사라진다)
    if (this.counts.failed === 0 && this.running.size === 0 && this.memBackoff.size === 0 && !this.authPaused && this.lastError !== undefined) {
      this.lastError = undefined;
    }
    this.publish();

    this.startable = 0;
    if (this.pauseReason() !== null) {
      this.clearTimer();
      return;
    }

    const cooling = (key: string): boolean => (this.memBackoff.get(key)?.nextAt ?? 0) > now;
    const due = (u: UploadInfo): boolean =>
      (u.state === 'pending' || u.state === 'failed') && (u.nextAttemptAt === undefined || u.nextAttemptAt <= now);

    const tasks: Task[] = [];
    for (const c of caps) {
      const key = `cap:${c.id}`;
      if (!this.running.has(key) && !cooling(key) && due(c.upload)) tasks.push({ key, run: () => this.uploadCapture(c.id) });
    }
    for (const b of books) {
      const key = `meta:${b.id}`;
      if (!b.driveMetaDirty || this.running.has(key) || cooling(key)) continue;
      // 그 책에 지금 올릴 수 있는 촬영이 남아 있으면 기다린다 (driveFileId 가 다 모인 뒤에 한 번만 올린다)
      const blocked = caps.some((c) => c.bookId === b.id && (c.upload.state === 'running' || due(c.upload) || this.running.has(`cap:${c.id}`)));
      if (!blocked) tasks.push({ key, run: () => this.uploadBookJson(b.id) });
    }
    for (const j of pdfJobs) {
      const key = `job:${j.id}`;
      if (!this.running.has(key) && !cooling(key) && due(j.upload)) tasks.push({ key, run: () => this.uploadPdf(j.id) });
    }

    this.startable = tasks.length;
    for (const t of tasks.slice(0, Math.max(0, this.concurrency - this.running.size))) this.launch(t);

    // 가장 이른 재시도 시각에 다시 훑는다
    let next = Infinity;
    for (const u of [...caps.map((c) => c.upload), ...pdfJobs.map((j) => j.upload)]) {
      if ((u.state === 'pending' || u.state === 'failed') && u.nextAttemptAt !== undefined && u.nextAttemptAt > now) {
        next = Math.min(next, u.nextAttemptAt);
      }
    }
    for (const m of this.memBackoff.values()) if (m.nextAt > now) next = Math.min(next, m.nextAt);
    this.clearTimer();
    if (next !== Infinity) this.cancelTimer = this.setTimer(() => this.kick(), Math.max(0, next - now));
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  private launch(t: Task): void {
    this.running.add(t.key);
    void t
      .run()
      .catch((e: unknown) => this.noteError(e))
      .finally(() => {
        this.running.delete(t.key);
        this.kick();
      });
  }

  // ── 촬영 업로드 ────────────────────────────────────────
  private async uploadCapture(id: string): Promise<void> {
    const key = `cap:${id}`;
    const epoch = this.tokenEpoch;
    let cap: Capture | undefined;
    try {
      cap = await this.repo.getCapture(id);
      if (!cap || cap.deleted || (cap.upload.state !== 'pending' && cap.upload.state !== 'failed')) return;
      await this.repo.setUpload(id, { state: 'running' });
      const { originalFolderId } = await this.ensureBookFolders(cap.bookId);
      const name = originalName(cap.seq);

      // 이전에 끊겼거나(attempts>0) 앱이 죽었다면(checkRemote) 서버에는 이미 올라갔을 수 있다
      let fileId: string | undefined;
      if (cap.upload.attempts > 0 || cap.upload.checkRemote) {
        fileId = (await this.drive.findFile(name, originalFolderId))?.id;
      }
      if (!fileId) {
        const blob = await this.repo.files.read(cap.file);
        if (!blob) throw new Error('로컬 원본 없음');
        const f = await this.drive.upload(
          {
            name,
            parents: [originalFolderId],
            mimeType: 'image/jpeg',
            appProperties: { bookscanBookId: cap.bookId, bookscanSeq: String(cap.seq) },
          },
          blob,
        );
        fileId = f.id;
      }
      await this.repo.setUpload(id, { state: 'done', driveFileId: fileId, checkRemote: false, lastError: undefined, nextAttemptAt: undefined });
      this.memBackoff.delete(key);
      this.metaGen.set(cap.bookId, (this.metaGen.get(cap.bookId) ?? 0) + 1);
      await this.repo.updateBook(cap.bookId, { driveMetaDirty: true }, false).catch(() => {});
    } catch (e) {
      await this.failItem('cap', id, epoch, cap?.bookId, cap?.upload, e);
    }
  }

  // ── PDF 업로드 ─────────────────────────────────────────
  private async uploadPdf(id: string): Promise<void> {
    const key = `job:${id}`;
    const epoch = this.tokenEpoch;
    let job: BookJob | undefined;
    try {
      job = (await this.repo.allJobs()).find((j) => j.id === id);
      if (!job || (job.upload.state !== 'pending' && job.upload.state !== 'failed')) return;
      await this.repo.setJobUpload(id, { state: 'running' });
      const { bookFolderId } = await this.ensureBookFolders(job.bookId);
      const blob = job.file ? await this.repo.files.read(job.file) : null;
      if (!blob) throw new Error('로컬 파일 없음');
      // 같은 이름 파일이 이미 있으면 그 파일을 갱신한다 (중복 파일을 만들지 않는다)
      const existing = await this.drive.findFile(job.name, bookFolderId);
      const f = await this.drive.upload(
        { name: job.name, parents: [bookFolderId], mimeType: 'application/pdf', appProperties: { bookscanBookId: job.bookId } },
        blob,
        existing?.id,
      );
      await this.repo.setJobUpload(id, { state: 'done', driveFileId: f.id, checkRemote: false, lastError: undefined, nextAttemptAt: undefined });
      this.memBackoff.delete(key);
    } catch (e) {
      await this.failItem('job', id, epoch, job?.bookId, job?.upload, e);
    }
  }

  // ── book.json 업로드 ───────────────────────────────────
  private async uploadBookJson(bookId: string): Promise<void> {
    const key = `meta:${bookId}`;
    const epoch = this.tokenEpoch;
    try {
      const { bookFolderId } = await this.ensureBookFolders(bookId);
      const book = await this.repo.getBook(bookId);
      if (!book || !book.driveMetaDirty) return;
      // 올리는 동안 책이 바뀌었는지 알아보려고 시작할 때의 값을 적어 둔다
      const seenUpdatedAt = book.updatedAt;
      const seenGen = this.metaGen.get(bookId) ?? 0;
      const json = buildBookJson(book, await this.repo.listCaptures(bookId), await this.repo.listPages(bookId), this.appVersion, this.now());
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });

      let fileId = book.driveMetaFileId;
      if (!fileId) fileId = (await this.drive.findFile(BOOK_JSON_NAME, bookFolderId))?.id;
      const f = await this.drive.upload(
        { name: BOOK_JSON_NAME, parents: [bookFolderId], mimeType: 'application/json', appProperties: { bookscanBookId: bookId } },
        blob,
        fileId,
      );
      this.memBackoff.delete(key);

      await this.repo.updateBook(bookId, { driveMetaFileId: f.id }, false);
      const cur = await this.repo.getBook(bookId);
      if (cur && cur.updatedAt === seenUpdatedAt && (this.metaGen.get(bookId) ?? 0) === seenGen) {
        const after = await this.repo.updateBook(bookId, { driveMetaDirty: false }, false);
        // 확인과 쓰기 사이에 책이 또 바뀌었다면 다시 올리도록 되돌린다
        if (after.updatedAt !== seenUpdatedAt) await this.repo.updateBook(bookId, { driveMetaDirty: true }, false);
      }
    } catch (e) {
      await this.failBookJson(bookId, epoch, e);
    }
  }

  private async failBookJson(bookId: string, epoch: number, e: unknown): Promise<void> {
    const key = `meta:${bookId}`;
    if (e instanceof AuthError) {
      await this.onAuthError(epoch, async () => {});
      return;
    }
    this.noteError(e);
    if (e instanceof DriveError && e.status === 404) await this.forgetCached(bookId, true);
    const attempts = (this.memBackoff.get(key)?.attempts ?? 0) + 1;
    this.memBackoff.set(key, { attempts, nextAt: this.now() + backoffMs(attempts) });
  }

  // ── 실패 처리 (촬영·PDF) ───────────────────────────────
  private async failItem(
    kind: 'cap' | 'job',
    id: string,
    epoch: number,
    bookId: string | undefined,
    info: UploadInfo | undefined,
    e: unknown,
  ): Promise<void> {
    const key = `${kind}:${id}`;
    const write = (patch: Partial<UploadInfo>) => (kind === 'cap' ? this.repo.setUpload(id, patch) : this.repo.setJobUpload(id, patch));

    if (e instanceof AuthError) {
      // 인증 문제는 파일 탓이 아니다. attempts 를 올리지 않고 대기 상태로 되돌린다
      await this.onAuthError(epoch, async () => {
        await write({ state: 'pending' });
      });
      return;
    }

    this.noteError(e);
    if (e instanceof DriveError && e.status === 404 && bookId) await this.forgetCached(bookId, false);
    const attempts = (info?.attempts ?? 0) + 1;
    const nextAt = this.now() + backoffMs(attempts);
    try {
      await write({ state: 'failed', attempts, lastError: errorMessage(e), nextAttemptAt: nextAt });
    } catch {
      // 저장소에 못 적으면 메모리에서라도 쉬었다가 다시 한다 (바로 다시 돌면 오류만 반복된다)
      this.memBackoff.set(key, { attempts, nextAt });
    }
  }

  /** 404: 폴더가 지워졌을 수 있다. 캐시한 ID 를 버리면 다음 시도에서 이름으로 찾거나 다시 만든다 */
  private async forgetCached(bookId: string, includeMetaFile: boolean): Promise<void> {
    try {
      await this.repo.setKv(ROOT_KV, undefined);
      await this.repo.updateBook(
        bookId,
        { driveFolderId: undefined, driveOriginalFolderId: undefined, ...(includeMetaFile ? { driveMetaFileId: undefined } : {}) },
        false,
      );
    } catch {
      // 저장소 오류는 다음 훑기에서 다시 드러난다
    }
  }

  // ── 로그인 만료 ────────────────────────────────────────
  /**
   * 대기열을 멈추고 팝업 없는 재발급을 한 번 시도한다. 이미 멈춘 상태에서 온 401 은 상태만 되돌린다.
   * revert 는 멈춘 "뒤에" 부른다 (그 쓰기가 일으키는 훑기가 같은 작업을 곧바로 다시 시작하면 안 된다).
   */
  private async onAuthError(epoch: number, revert: () => Promise<void>): Promise<void> {
    if (epoch !== this.tokenEpoch) {
      // 새 토큰을 받기 전에 보낸 요청의 401 이다. 멈추지 않고 상태만 되돌려 새 토큰으로 다시 한다
      try {
        await revert();
      } catch (e) {
        this.noteError(e);
      }
      return;
    }
    const first = !this.authPaused;
    const gen = this.authGen;
    this.authPaused = true;
    if (first) this.lastError = '드라이브 로그인이 만료됐습니다';
    this.publish();
    try {
      await revert();
    } catch (e) {
      this.noteError(e);
    }
    if (!first) return;

    let ok = false;
    const justRefreshed = this.lastRefreshAt !== undefined && this.now() - this.lastRefreshAt < AUTH_LOOP_GUARD_MS;
    if (!justRefreshed) {
      try {
        ok = await this.tokens.silentRefresh();
      } catch {
        ok = false;
      }
    }
    if (gen !== this.authGen) return; // 그 사이에 사용자가 다시 연결했다
    if (ok) {
      this.tokenEpoch++;
      this.lastRefreshAt = this.now();
      this.authPaused = false;
      this.needsReconnect = false;
      this.publish();
      this.kick();
    } else {
      this.needsReconnect = true;
      this.publish();
    }
  }

  // ── 폴더 ───────────────────────────────────────────────
  private ensureRoot(): Promise<string> {
    if (!this.rootLock) {
      const p = (async () => {
        const cached = await this.repo.getKv<string>(ROOT_KV);
        if (cached) return cached;
        const id = await this.drive.ensureFolder(ROOT_FOLDER_NAME, 'root');
        await this.repo.setKv(ROOT_KV, id);
        return id;
      })();
      this.rootLock = p.finally(() => {
        this.rootLock = null;
      });
    }
    return this.rootLock;
  }

  /** 같은 책의 폴더는 동시에 한 번만 만든다 (책별 Promise 잠금) */
  private ensureBookFolders(bookId: string): Promise<Folders> {
    let p = this.folderLocks.get(bookId);
    if (!p) {
      p = this.doEnsureBookFolders(bookId).finally(() => {
        this.folderLocks.delete(bookId);
      });
      this.folderLocks.set(bookId, p);
    }
    return p;
  }

  private async doEnsureBookFolders(bookId: string): Promise<Folders> {
    const book = await this.repo.getBook(bookId);
    if (!book) throw new Error('책이 없습니다');
    if (book.driveFolderId && book.driveOriginalFolderId) {
      return { bookFolderId: book.driveFolderId, originalFolderId: book.driveOriginalFolderId };
    }
    const root = await this.ensureRoot();
    let bookFolderId = book.driveFolderId;
    const createdBookFolder = !bookFolderId;
    if (!bookFolderId) {
      bookFolderId = await this.drive.ensureFolder(bookFolderName(book.title, book.createdAt), root);
      await this.repo.updateBook(bookId, { driveFolderId: bookFolderId }, false);
    }
    let originalFolderId = book.driveOriginalFolderId;
    if (createdBookFolder || !originalFolderId) {
      originalFolderId = await this.drive.ensureFolder(ORIGINAL_FOLDER_NAME, bookFolderId);
      await this.repo.updateBook(bookId, { driveOriginalFolderId: originalFolderId }, false);
    }
    return { bookFolderId, originalFolderId };
  }
}

function tally(list: UploadInfo[]): Counts {
  const c: Counts = { pending: 0, running: 0, failed: 0, done: 0 };
  for (const u of list) {
    if (u.state === 'pending') c.pending++;
    else if (u.state === 'running') c.running++;
    else if (u.state === 'failed') c.failed++;
    else if (u.state === 'done') c.done++;
  }
  return c;
}

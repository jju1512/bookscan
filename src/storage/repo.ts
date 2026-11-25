/**
 * 저장소의 유일한 쓰기 창구. 화면·대기열·후처리는 이 클래스로만 데이터를 바꾼다.
 *
 * 저장 규칙 (SPEC 4장)
 * 1. 촬영본은 OPFS 에 파일을 다 쓴 뒤 IndexedDB 트랜잭션을 커밋한다. addCapture 가 끝나야 "촬영됨" 피드백을 준다.
 * 2. 업로드·후처리 상태는 IndexedDB 에 둔다. recover() 가 running → pending 으로 되돌린다.
 * 7. 원본은 사용자가 지우기 전에는 지우지 않는다. cleanupLocal() 은 업로드·후처리가 모두 끝난 원본만 지운다.
 */
import type { DB } from './db';
import type { FileStore } from './files';
import {
  emptySteps,
  paths,
  PROCESS_STEPS,
  type Book,
  type BookJob,
  type Capture,
  type CaptureMode,
  type Page,
  type ProcessStepName,
  type StepState,
  type UploadInfo,
} from './types';

export type RepoEvent =
  | { type: 'books' }
  | { type: 'book'; bookId: string }
  | { type: 'captures'; bookId: string }
  | { type: 'pages'; bookId: string }
  | { type: 'jobs'; bookId: string };

export interface NewCapture {
  jpeg: Blob;
  thumb: Blob;
  width: number;
  height: number;
  sharpness: number;
  manual?: boolean;
  /** 재촬영: 이 촬영을 대신한다 (같은 순서 자리에 들어가고, 옛 촬영은 지운다) */
  replaceCaptureId?: string;
  capturedAt?: number;
}

export interface RecoverResult {
  uploads: number;
  steps: number;
  jobs: number;
}

export class Repo {
  private listeners = new Set<(e: RepoEvent) => void>();

  constructor(
    readonly db: DB,
    readonly files: FileStore,
    private readonly now: () => number = () => Date.now(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  // ── 이벤트 ─────────────────────────────────────────────
  subscribe(fn: (e: RepoEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: RepoEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // 화면 갱신 오류가 저장을 막지 않게 한다
      }
    }
  }

  // ── 책 ─────────────────────────────────────────────────
  async createBook(input: { title: string; captureMode: CaptureMode; id?: string; createdAt?: number }): Promise<Book> {
    const t = this.now();
    const book: Book = {
      id: input.id ?? this.newId(),
      title: input.title.trim() || '제목 없음',
      createdAt: input.createdAt ?? t,
      updatedAt: t,
      captureMode: input.captureMode,
      scanState: 'scanning',
      nextSeq: 1,
      processState: 'idle',
      driveMetaDirty: true,
    };
    await this.db.add('books', book);
    this.emit({ type: 'books' });
    return book;
  }

  listBooks(): Promise<Book[]> {
    return this.db.getAll('books').then((b) => b.sort((x, y) => y.updatedAt - x.updatedAt));
  }

  getBook(id: string): Promise<Book | undefined> {
    return this.db.get('books', id);
  }

  async updateBook(id: string, patch: Partial<Omit<Book, 'id'>>, touch = true): Promise<Book> {
    const tx = this.db.transaction('books', 'readwrite');
    const book = await tx.store.get(id);
    if (!book) throw new Error(`책이 없습니다: ${id}`);
    const next: Book = { ...book, ...patch, id, updatedAt: touch ? this.now() : book.updatedAt };
    await tx.store.put(next);
    await tx.done;
    this.emit({ type: 'book', bookId: id });
    this.emit({ type: 'books' });
    return next;
  }

  /** 책과 그 책의 모든 로컬 파일을 지운다. 드라이브 파일은 그대로 둔다 */
  async deleteBook(id: string): Promise<void> {
    const tx = this.db.transaction(['books', 'captures', 'pages', 'jobs'], 'readwrite');
    await tx.objectStore('books').delete(id);
    for (const store of ['captures', 'pages', 'jobs'] as const) {
      const keys = await tx.objectStore(store).index('bookId').getAllKeys(id);
      for (const k of keys) await tx.objectStore(store).delete(k);
    }
    await tx.done;
    await this.files.removeDir(paths.bookDir(id));
    this.emit({ type: 'books' });
  }

  // ── 촬영 ───────────────────────────────────────────────
  /**
   * 촬영본 한 장을 저장한다. 순서: seq 예약 → OPFS 원본·썸네일 쓰기 → IndexedDB 커밋.
   * 이 함수가 끝난 뒤에만 촬영 완료 피드백을 준다 (규칙 1).
   */
  async addCapture(bookId: string, input: NewCapture): Promise<Capture> {
    // seq 를 먼저 예약한다. 파일 쓰기가 실패하면 그 번호는 건너뛴다(다시 쓰지 않는다).
    const seq = await this.reserveSeq(bookId);
    const file = paths.original(bookId, seq);
    const thumb = paths.thumb(bookId, seq);
    await this.files.write(file, input.jpeg);
    await this.files.write(thumb, input.thumb);

    const tx = this.db.transaction(['books', 'captures'], 'readwrite');
    const caps = tx.objectStore('captures');
    const existing = await caps.index('bookId').getAll(bookId);
    let order = existing.filter((c) => !c.deleted).reduce((m, c) => Math.max(m, c.order), 0) + 1;
    let replaced: Capture | undefined;
    if (input.replaceCaptureId) {
      replaced = existing.find((c) => c.id === input.replaceCaptureId && !c.deleted);
      if (replaced) {
        order = replaced.order;
        await caps.put({ ...replaced, deleted: true });
      }
    }
    const cap: Capture = {
      id: this.newId(),
      bookId,
      seq,
      order,
      capturedAt: input.capturedAt ?? this.now(),
      file,
      width: input.width,
      height: input.height,
      bytes: input.jpeg.size,
      sharpness: input.sharpness,
      thumb,
      upload: { state: 'pending', attempts: 0 },
      ...(input.manual ? { manual: true } : {}),
    };
    await caps.add(cap);
    const books = tx.objectStore('books');
    const book = await books.get(bookId);
    if (book) await books.put({ ...book, updatedAt: this.now(), driveMetaDirty: true });
    await tx.done;

    if (replaced) await this.removeCaptureFiles(replaced);
    this.emit({ type: 'captures', bookId });
    this.emit({ type: 'books' });
    return cap;
  }

  private async reserveSeq(bookId: string): Promise<number> {
    const tx = this.db.transaction('books', 'readwrite');
    const book = await tx.store.get(bookId);
    if (!book) throw new Error(`책이 없습니다: ${bookId}`);
    const seq = book.nextSeq;
    await tx.store.put({ ...book, nextSeq: seq + 1 });
    await tx.done;
    return seq;
  }

  /**
   * 다른 곳(ZIP, 드라이브)에서 읽은 책을 한 번에 넣는다. 원본 파일은 이미 OPFS 에 써 둔 상태여야 한다.
   * 책과 촬영을 한 트랜잭션으로 커밋하므로 중간에 끊기면 아무것도 생기지 않는다 (파일만 남고 다음 가져오기 때 덮어쓴다).
   */
  async importBook(book: Book, captures: Capture[]): Promise<void> {
    const tx = this.db.transaction(['books', 'captures'], 'readwrite');
    await tx.objectStore('books').add(book);
    for (const c of captures) await tx.objectStore('captures').add(c);
    await tx.done;
    this.emit({ type: 'books' });
    this.emit({ type: 'captures', bookId: book.id });
  }

  newIdValue(): string {
    return this.newId();
  }

  nowValue(): number {
    return this.now();
  }

  /** 지우지 않은 촬영을 순서대로 */
  async listCaptures(bookId: string, includeDeleted = false): Promise<Capture[]> {
    const all = await this.db.getAllFromIndex('captures', 'bookId', bookId);
    return all.filter((c) => includeDeleted || !c.deleted).sort((a, b) => a.order - b.order || a.seq - b.seq);
  }

  getCapture(id: string): Promise<Capture | undefined> {
    return this.db.get('captures', id);
  }

  /** 사용자가 직접 지운다. 기록은 deleted 로 남기고(드라이브 중복 확인용) 로컬 파일과 후처리 결과는 지운다 */
  async deleteCapture(id: string): Promise<void> {
    const tx = this.db.transaction(['captures', 'pages', 'books'], 'readwrite');
    const cap = await tx.objectStore('captures').get(id);
    if (!cap || cap.deleted) {
      await tx.done;
      return;
    }
    await tx.objectStore('captures').put({ ...cap, deleted: true });
    const pages = await tx.objectStore('pages').index('captureId').getAll(id);
    for (const p of pages) await tx.objectStore('pages').delete(p.id);
    const book = await tx.objectStore('books').get(cap.bookId);
    if (book) await tx.objectStore('books').put({ ...book, updatedAt: this.now(), driveMetaDirty: true });
    await tx.done;
    await this.removeCaptureFiles(cap);
    for (const p of pages) await this.files.removeDir(paths.pageDir(p.bookId, p.id));
    this.emit({ type: 'captures', bookId: cap.bookId });
    this.emit({ type: 'pages', bookId: cap.bookId });
  }

  private async removeCaptureFiles(cap: Capture): Promise<void> {
    await this.files.remove(cap.file).catch(() => {});
    await this.files.remove(cap.thumb).catch(() => {});
  }

  /** 순서를 한 칸 옮긴다 (delta = -1 앞으로, +1 뒤로) */
  async moveCapture(id: string, delta: number): Promise<void> {
    const cap = await this.getCapture(id);
    if (!cap) return;
    const list = await this.listCaptures(cap.bookId);
    const i = list.findIndex((c) => c.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const [moved] = list.splice(i, 1);
    list.splice(j, 0, moved!);
    await this.reorder(cap.bookId, list.map((c) => c.id));
  }

  /** 주어진 순서대로 order 를 1부터 다시 매긴다 */
  async reorder(bookId: string, orderedIds: string[]): Promise<void> {
    const tx = this.db.transaction(['captures', 'pages', 'books'], 'readwrite');
    const caps = tx.objectStore('captures');
    let n = 1;
    const orderOf = new Map<string, number>();
    for (const id of orderedIds) {
      const c = await caps.get(id);
      if (!c || c.bookId !== bookId || c.deleted) continue;
      orderOf.set(id, n);
      if (c.order !== n) await caps.put({ ...c, order: n });
      n++;
    }
    const pages = await tx.objectStore('pages').index('bookId').getAll(bookId);
    for (const p of pages) {
      const o = orderOf.get(p.captureId);
      if (o === undefined) continue;
      const po = pageOrder(o, p.side);
      if (p.order !== po) await tx.objectStore('pages').put({ ...p, order: po });
    }
    const book = await tx.objectStore('books').get(bookId);
    if (book) await tx.objectStore('books').put({ ...book, updatedAt: this.now(), driveMetaDirty: true });
    await tx.done;
    this.emit({ type: 'captures', bookId });
    this.emit({ type: 'pages', bookId });
  }

  async setUpload(captureId: string, patch: Partial<UploadInfo>): Promise<Capture | undefined> {
    const tx = this.db.transaction('captures', 'readwrite');
    const cap = await tx.store.get(captureId);
    if (!cap) {
      await tx.done;
      return undefined;
    }
    const next = { ...cap, upload: { ...cap.upload, ...patch } };
    await tx.store.put(next);
    await tx.done;
    this.emit({ type: 'captures', bookId: cap.bookId });
    return next;
  }

  /** 모든 책의 촬영 (업로드 대기열용) */
  allCaptures(): Promise<Capture[]> {
    return this.db.getAll('captures');
  }

  // ── 후처리 페이지 ─────────────────────────────────────
  /**
   * 촬영마다 페이지를 맞춘다. 펼침 책은 left/right 두 장, 한 페이지 책은 single 한 장.
   * 지운 촬영의 페이지는 없애고, 순서는 촬영 순서를 따른다.
   */
  async ensurePages(bookId: string): Promise<Page[]> {
    const book = await this.getBook(bookId);
    if (!book) throw new Error(`책이 없습니다: ${bookId}`);
    const caps = await this.listCaptures(bookId);
    const tx = this.db.transaction('pages', 'readwrite');
    const existing = await tx.store.index('bookId').getAll(bookId);
    const byCap = new Map<string, Page[]>();
    for (const p of existing) byCap.set(p.captureId, [...(byCap.get(p.captureId) ?? []), p]);
    const sides: Page['side'][] = book.captureMode === 'spread' ? ['left', 'right'] : ['single'];
    const keep = new Set<string>();
    let changed = false;
    for (const c of caps) {
      const have = byCap.get(c.id) ?? [];
      for (const side of sides) {
        let p = have.find((x) => x.side === side);
        if (!p) {
          p = { id: this.newId(), bookId, captureId: c.id, side, order: pageOrder(c.order, side), steps: emptySteps(), files: {} };
          await tx.store.add(p);
          changed = true;
        } else if (p.order !== pageOrder(c.order, side)) {
          p = { ...p, order: pageOrder(c.order, side) };
          await tx.store.put(p);
          changed = true;
        }
        keep.add(p.id);
      }
    }
    const removed: Page[] = [];
    for (const p of existing) {
      if (!keep.has(p.id)) {
        await tx.store.delete(p.id);
        removed.push(p);
      }
    }
    await tx.done;
    for (const p of removed) await this.files.removeDir(paths.pageDir(bookId, p.id));
    // 바뀐 것이 없으면 알리지 않는다 (화면이 이 이벤트로 다시 ensurePages 를 부르면 끝없이 돈다)
    if (changed || removed.length) this.emit({ type: 'pages', bookId });
    return this.listPages(bookId);
  }

  async listPages(bookId: string): Promise<Page[]> {
    const all = await this.db.getAllFromIndex('pages', 'bookId', bookId);
    return all.sort((a, b) => a.order - b.order);
  }

  getPage(id: string): Promise<Page | undefined> {
    return this.db.get('pages', id);
  }

  async updatePage(id: string, fn: (p: Page) => Page): Promise<Page> {
    const tx = this.db.transaction('pages', 'readwrite');
    const p = await tx.store.get(id);
    if (!p) throw new Error(`페이지가 없습니다: ${id}`);
    const next = fn(p);
    await tx.store.put(next);
    await tx.done;
    this.emit({ type: 'pages', bookId: p.bookId });
    return next;
  }

  /** 단계 결과를 저장하고 상태를 바꾼다. 파일을 먼저 쓰고 상태를 커밋한다 (규칙 1과 같은 순서) */
  async saveStepResult(
    pageId: string,
    step: ProcessStepName,
    state: StepState,
    result: { image?: Blob; note?: string; durationMs?: number; patch?: Partial<Page> },
  ): Promise<Page> {
    const page = await this.getPage(pageId);
    if (!page) throw new Error(`페이지가 없습니다: ${pageId}`);
    let file: string | undefined;
    if (result.image && step !== 'ocr') {
      file = paths.pageStep(page.bookId, page.id, step);
      await this.files.write(file, result.image);
    }
    return this.updatePage(pageId, (p) => {
      const next: Page = { ...p, ...result.patch, steps: { ...p.steps, [step]: state } };
      if (step !== 'ocr') {
        const files = { ...p.files };
        if (file) files[step] = file;
        else delete files[step];
        next.files = files;
      }
      const notes = { ...p.notes };
      if (result.note) notes[step] = result.note;
      else delete notes[step];
      next.notes = notes;
      if (result.durationMs !== undefined) next.durations = { ...p.durations, [step]: result.durationMs };
      return next;
    });
  }

  /** 페이지의 단계를 from 부터 다시 처리하도록 되돌린다. 결과 파일도 지운다 */
  async resetPageSteps(pageId: string, from: ProcessStepName = 'crop'): Promise<Page> {
    const idx = PROCESS_STEPS.indexOf(from);
    const page = await this.updatePage(pageId, (p) => {
      const steps = { ...p.steps };
      const files = { ...p.files };
      const notes = { ...p.notes };
      for (const s of PROCESS_STEPS.slice(idx)) {
        steps[s] = 'pending';
        if (s !== 'ocr') delete files[s];
        delete notes[s];
      }
      const next: Page = { ...p, steps, files, notes };
      if (idx <= PROCESS_STEPS.indexOf('ocr')) delete next.ocr;
      if (idx <= PROCESS_STEPS.indexOf('finger')) delete next.fingerOverText;
      if (idx === 0) delete next.needsManual;
      return next;
    });
    for (const s of PROCESS_STEPS.slice(idx)) {
      if (s !== 'ocr') await this.files.remove(paths.pageStep(page.bookId, page.id, s)).catch(() => {});
    }
    return page;
  }

  // ── 책 단위 드라이브 작업 ────────────────────────────
  async putJob(job: BookJob): Promise<void> {
    await this.db.put('jobs', job);
    this.emit({ type: 'jobs', bookId: job.bookId });
  }
  allJobs(): Promise<BookJob[]> {
    return this.db.getAll('jobs');
  }
  async setJobUpload(id: string, patch: Partial<UploadInfo>): Promise<BookJob | undefined> {
    const tx = this.db.transaction('jobs', 'readwrite');
    const job = await tx.store.get(id);
    if (!job) {
      await tx.done;
      return undefined;
    }
    const next = { ...job, upload: { ...job.upload, ...patch } };
    await tx.store.put(next);
    await tx.done;
    this.emit({ type: 'jobs', bookId: job.bookId });
    return next;
  }

  // ── 설정값 (kv) ─────────────────────────────────────
  getKv<T>(key: string): Promise<T | undefined> {
    return this.db.get('kv', key) as Promise<T | undefined>;
  }
  async setKv(key: string, value: unknown): Promise<void> {
    if (value === undefined) await this.db.delete('kv', key);
    else await this.db.put('kv', value, key);
  }

  // ── 복구 (규칙 2) ───────────────────────────────────
  /** 앱 시작 때 부른다. running 으로 남은 업로드·후처리 단계·책 작업을 pending 으로 되돌린다 */
  async recover(): Promise<RecoverResult> {
    const out: RecoverResult = { uploads: 0, steps: 0, jobs: 0 };
    const tx = this.db.transaction(['captures', 'pages', 'jobs'], 'readwrite');
    let cursor = await tx.objectStore('captures').openCursor();
    while (cursor) {
      const c = cursor.value;
      if (c.upload.state === 'running') {
        await cursor.update({ ...c, upload: { ...c.upload, state: 'pending', checkRemote: true } });
        out.uploads++;
      }
      cursor = await cursor.continue();
    }
    let pc = await tx.objectStore('pages').openCursor();
    while (pc) {
      const p = pc.value;
      const running = PROCESS_STEPS.filter((s) => p.steps[s] === 'running');
      if (running.length) {
        const steps = { ...p.steps };
        for (const s of running) steps[s] = 'pending';
        await pc.update({ ...p, steps });
        out.steps += running.length;
      }
      pc = await pc.continue();
    }
    let jc = await tx.objectStore('jobs').openCursor();
    while (jc) {
      const j = jc.value;
      if (j.upload.state === 'running') {
        await jc.update({ ...j, upload: { ...j.upload, state: 'pending', checkRemote: true } });
        out.jobs++;
      }
      jc = await jc.continue();
    }
    await tx.done;
    return out;
  }

  /**
   * 로컬 정리 (규칙 7): 드라이브 업로드와 후처리가 모두 끝난 원본만 지운다.
   * 촬영 기록과 썸네일, 후처리 결과는 남긴다. 지운 원본은 필요하면 드라이브에서 다시 받는다.
   */
  async cleanupLocal(bookId: string): Promise<number> {
    const caps = await this.listCaptures(bookId);
    const pages = await this.listPages(bookId);
    let removed = 0;
    for (const c of caps) {
      if (c.upload.state !== 'done' || !c.upload.driveFileId) continue;
      const mine = pages.filter((p) => p.captureId === c.id);
      const processed = mine.length > 0 && mine.every((p) => PROCESS_STEPS.every((s) => p.steps[s] === 'done' || p.steps[s] === 'skipped'));
      if (!processed) continue;
      if (await this.files.exists(c.file)) {
        await this.files.remove(c.file);
        removed++;
      }
    }
    this.emit({ type: 'captures', bookId });
    return removed;
  }
}

export function pageOrder(captureOrder: number, side: Page['side']): number {
  return captureOrder * 2 + (side === 'right' ? 1 : 0);
}

/**
 * 책 단위 ZIP 내보내기·가져오기 (SPEC 4장 규칙 8). ZIP 에는 원본 이미지와 book.json 을 넣는다.
 *
 * 300장 책이면 1GB 가까이 되므로 메모리에 다 올리지 않는다.
 * - 내보내기: fflate 스트리밍 Zip 으로 조각을 OPFS 파일에 바로 쓰고, 다 쓴 파일(디스크에 있는 File)을 내려받게 한다.
 * - 가져오기: File.stream() 을 조각으로 읽어 fflate Unzip 에 넣고, 끝난 항목부터 OPFS 에 쓴다.
 * JPEG 는 이미 압축돼 있으므로 원본은 무압축(stored), book.json 만 deflate.
 */
import { strFromU8, strToU8, Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { bookFolderName } from '../sync/names';
import type { Repo } from '../storage/repo';
import { paths, type Book, type Capture } from '../storage/types';
import { buildBookJson, originalName, parseBookJson, type BookJson } from './bookjson';

export type Progress = (done: number, total: number) => void;

export function zipFileName(book: Pick<Book, 'title' | 'createdAt'>): string {
  return `${bookFolderName(book.title, book.createdAt)}.zip`;
}

export async function exportBookZip(repo: Repo, bookId: string, onProgress?: Progress, appVersion = 'dev'): Promise<{ file: Blob; name: string; path: string; skipped: number }> {
  const book = await repo.getBook(bookId);
  if (!book) throw new Error('책이 없습니다');
  const caps = await repo.listCaptures(bookId);
  const pages = await repo.listPages(bookId);
  const name = zipFileName(book);
  const path = paths.exportFile(bookId, name);
  await repo.files.removeDir(`${paths.bookDir(bookId)}/export`).catch(() => {});
  const writer = await repo.files.openWriter(path);

  let chain: Promise<void> = Promise.resolve();
  let failed: unknown = null;
  let finished!: () => void;
  const finalWritten = new Promise<void>((r) => (finished = r));
  const zip = new Zip((err, data, final) => {
    if (err) {
      failed = err;
      finished();
      return;
    }
    chain = chain.then(() => writer.write(data)).catch((e) => {
      failed = e;
    });
    if (final) void chain.then(() => finished());
  });

  try {
    const json = buildBookJson(book, caps, pages, appVersion);
    // 로컬 정리로 원본이 없는 촬영은 ZIP 에서 뺀다 (book.json 에도 넣지 않는다)
    const present: Capture[] = [];
    for (const c of caps) if (await repo.files.exists(c.file)) present.push(c);
    const skipped = caps.length - present.length;
    json.captures = json.captures.filter((jc) => present.some((c) => c.id === jc.id));
    const meta = new ZipDeflate('book.json', { level: 6 });
    zip.add(meta);
    meta.push(strToU8(JSON.stringify(json, null, 2)), true);
    await chain;

    let done = 0;
    for (const c of present) {
      const blob = await repo.files.read(c.file);
      if (!blob) continue;
      const entry = new ZipPassThrough(`original/${originalName(c.seq)}`);
      entry.mtime = c.capturedAt;
      zip.add(entry);
      entry.push(new Uint8Array(await blob.arrayBuffer()), true);
      // 조각이 파일에 다 써질 때까지 기다려 메모리에 쌓이지 않게 한다
      await chain;
      if (failed) throw failed;
      onProgress?.(++done, present.length);
    }
    zip.end();
    await finalWritten;
    await chain;
    if (failed) throw failed;
    await writer.close();
    const file = await repo.files.read(path);
    if (!file) throw new Error('ZIP 파일을 다시 읽을 수 없습니다');
    return { file, name, path, skipped };
  } catch (e) {
    zip.terminate();
    await writer.abort().catch(() => {});
    throw e;
  }
}

export interface ImportOptions {
  onProgress?: Progress;
  /** 썸네일 만들기 (브라우저 기본값: camera/shoot 의 makeThumbnail). 테스트에서 바꾼다 */
  makeThumb?: (jpeg: Blob) => Promise<Blob>;
}

/** ZIP 을 새 책으로 가져온다. 같은 책이 이미 있어도 새 ID 로 따로 만든다 (덮어쓰지 않는다) */
export async function importBookZip(repo: Repo, file: Blob, opts: ImportOptions | Progress = {}): Promise<Book> {
  const o: ImportOptions = typeof opts === 'function' ? { onProgress: opts } : opts;
  const makeThumb = o.makeThumb ?? (async (b: Blob) => (await (await import('../camera/shoot')).makeThumbnail(b)).thumb);
  const bookId = repo.newIdValue();
  const stagedSeqs = new Set<number>();
  let meta: BookJson | null = null;
  let writes: Promise<void> = Promise.resolve();
  let writeError: unknown = null;
  let entryError: unknown = null;

  const unzip = new Unzip((f) => {
    const isMeta = f.name === 'book.json';
    const m = /^original\/(\d{4,})\.jpg$/.exec(f.name);
    if (!isMeta && !m) return; // 모르는 항목은 무시
    const chunks: Uint8Array[] = [];
    f.ondata = (err, data, final) => {
      if (err) {
        entryError = err;
        return;
      }
      chunks.push(data);
      if (!final) return;
      if (isMeta) {
        try {
          meta = parseBookJson(strFromU8(concat(chunks)));
        } catch (e) {
          entryError = e;
        }
        return;
      }
      const seq = Number(m![1]);
      const blob = new Blob(chunks as BlobPart[], { type: 'image/jpeg' });
      writes = writes
        .then(() => repo.files.write(paths.original(bookId, seq), blob))
        .then(() => void stagedSeqs.add(seq))
        .catch((e) => {
          writeError = e;
        });
    };
    f.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);

  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      unzip.push(value, false);
      // 쓰기가 밀리지 않게 조각마다 기다린다
      await writes;
      if (entryError) throw entryError;
      if (writeError) throw writeError;
    }
    unzip.push(new Uint8Array(0), true);
    await writes;
    if (entryError) throw entryError;
    if (writeError) throw writeError;
    const json = meta as BookJson | null;
    if (!json) throw new Error('ZIP 안에 book.json 이 없습니다');

    const now = repo.nowValue();
    const captures: Capture[] = [];
    const sorted = [...json.captures].sort((a, b) => a.order - b.order);
    let done = 0;
    for (const jc of sorted) {
      if (!stagedSeqs.has(jc.seq)) continue; // 원본이 없는 항목은 건너뛴다
      const jpeg = await repo.files.read(paths.original(bookId, jc.seq));
      if (!jpeg) continue;
      const thumbPath = paths.thumb(bookId, jc.seq);
      await repo.files.write(thumbPath, await makeThumb(jpeg));
      captures.push({
        id: repo.newIdValue(),
        bookId,
        seq: jc.seq,
        order: captures.length + 1,
        capturedAt: jc.capturedAt,
        file: paths.original(bookId, jc.seq),
        width: jc.width,
        height: jc.height,
        bytes: jpeg.size,
        sharpness: jc.sharpness,
        thumb: thumbPath,
        upload: { state: 'pending', attempts: 0 },
        ...(jc.manual ? { manual: true } : {}),
      });
      o.onProgress?.(++done, sorted.length);
    }
    if (captures.length === 0) throw new Error('ZIP 안에 원본 이미지가 없습니다');
    const existing = await repo.getBook(json.book.id);
    const book: Book = {
      id: bookId,
      title: existing ? `${json.book.title} (가져옴)` : json.book.title,
      createdAt: json.book.createdAt,
      updatedAt: now,
      captureMode: json.book.captureMode,
      scanState: 'finished',
      nextSeq: Math.max(...captures.map((c) => c.seq)) + 1,
      processState: 'idle',
      driveMetaDirty: true,
      importedFrom: json.book.id,
    };
    await repo.importBook(book, captures);
    return book;
  } catch (e) {
    await repo.files.removeDir(paths.bookDir(bookId)).catch(() => {});
    throw e;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

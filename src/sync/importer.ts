/**
 * 다른 기기에서 불러오기 (SPEC 7장). BookScan/ 아래 book.json 을 찾아 책 목록을 보여 주고,
 * 고른 책의 원본을 내려받아 로컬 책으로 만든다. 주 용도: 휴대폰으로 촬영 → PC 크롬에서 후처리.
 *
 * drive.file 범위에서는 이 앱(같은 OAuth 클라이언트)이 만든 파일만 보인다.
 * 불러온 촬영은 이미 드라이브에 있으므로 upload.state='done' + driveFileId 로 두고 다시 올리지 않는다.
 * 책 폴더 ID 도 그대로 이어 받아, PC 에서 만든 PDF 가 같은 폴더에 올라가게 한다.
 */
import { parseBookJson, type BookJson } from '../export/bookjson';
import type { Repo } from '../storage/repo';
import { paths, type Book, type Capture } from '../storage/types';
import type { DriveClient, DriveFile } from './drive';
import { BOOK_JSON_NAME, ORIGINAL_FOLDER_NAME, ROOT_FOLDER_NAME } from './names';

export type ImportDrive = Pick<DriveClient, 'findFolder' | 'listFiles' | 'download'>;

export interface RemoteBook {
  metaFileId: string;
  folderId: string;
  json: BookJson;
  /** 이 기기에 이미 같은 책(같은 ID 또는 그 책에서 불러온 책)이 있다 */
  localBookId?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export async function listRemoteBooks(drive: ImportDrive, repo: Repo): Promise<RemoteBook[]> {
  const root = await drive.findFolder(ROOT_FOLDER_NAME, 'root');
  if (!root) return [];
  const folders = await drive.listFiles(`'${root.id}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`);
  const local = await repo.listBooks();
  const out: RemoteBook[] = [];
  for (const f of folders) {
    const metas = await drive.listFiles(`name = '${BOOK_JSON_NAME}' and '${f.id}' in parents and trashed = false`);
    const meta = metas[0];
    if (!meta) continue;
    try {
      const json = parseBookJson(await (await drive.download(meta.id)).text());
      const same = local.find((b) => b.id === json.book.id || b.importedFrom === json.book.id);
      out.push({ metaFileId: meta.id, folderId: f.id, json, ...(same ? { localBookId: same.id } : {}) });
    } catch {
      // 깨진 book.json 은 목록에서 뺀다
    }
  }
  return out.sort((a, b) => b.json.book.updatedAt - a.json.book.updatedAt);
}

export interface RemoteImportOptions {
  onProgress?: (done: number, total: number) => void;
  makeThumb?: (jpeg: Blob) => Promise<Blob>;
  signal?: AbortSignal;
}

export async function importRemoteBook(drive: ImportDrive, repo: Repo, remote: RemoteBook, opts: RemoteImportOptions = {}): Promise<Book> {
  const makeThumb = opts.makeThumb ?? (async (b: Blob) => (await (await import('../camera/shoot')).makeThumbnail(b)).thumb);
  const json = remote.json;
  // 같은 책 ID 를 그대로 쓴다: 두 기기가 같은 book.json 을 갱신해도 같은 책으로 남는다.
  // 이 기기에 이미 그 ID 가 있으면(같은 기기에서 촬영한 책) 새 ID 로 따로 만든다.
  const bookId = (await repo.getBook(json.book.id)) ? repo.newIdValue() : json.book.id;
  // 원본 폴더의 파일 목록 (book.json 에 ID 가 없는 촬영은 이름으로 찾는다)
  const origFolder = await drive.findFolder(ORIGINAL_FOLDER_NAME, remote.folderId);
  const byName = new Map<string, DriveFile>();
  if (origFolder) {
    for (const f of await drive.listFiles(`'${origFolder.id}' in parents and trashed = false`)) byName.set(f.name, f);
  }
  const sorted = [...json.captures].sort((a, b) => a.order - b.order);
  const captures: Capture[] = [];
  let missing = 0;
  try {
    for (const jc of sorted) {
      if (opts.signal?.aborted) throw new DOMException('중단', 'AbortError');
      const name = jc.file.split('/').pop()!;
      const fileId = jc.driveFileId ?? byName.get(name)?.id;
      if (!fileId) {
        missing++;
        continue;
      }
      const jpeg = await drive.download(fileId);
      const file = paths.original(bookId, jc.seq);
      const thumb = paths.thumb(bookId, jc.seq);
      await repo.files.write(file, jpeg);
      await repo.files.write(thumb, await makeThumb(jpeg));
      captures.push({
        id: repo.newIdValue(),
        bookId,
        seq: jc.seq,
        order: captures.length + 1,
        capturedAt: jc.capturedAt,
        file,
        width: jc.width,
        height: jc.height,
        bytes: jpeg.size,
        sharpness: jc.sharpness,
        thumb,
        upload: { state: 'done', driveFileId: fileId, attempts: 0 },
        ...(jc.manual ? { manual: true } : {}),
      });
      opts.onProgress?.(captures.length + missing, sorted.length);
    }
    if (captures.length === 0) throw new Error('내려받을 원본이 없습니다 (드라이브에 원본이 아직 올라가지 않았을 수 있습니다)');
    const book: Book = {
      id: bookId,
      title: json.book.title,
      createdAt: json.book.createdAt,
      updatedAt: repo.nowValue(),
      captureMode: json.book.captureMode,
      scanState: json.book.scanState,
      nextSeq: Math.max(...json.captures.map((c) => c.seq)) + 1,
      processState: 'idle',
      ...(bookId !== json.book.id ? { importedFrom: json.book.id } : {}),
      driveFolderId: remote.folderId,
      ...(origFolder ? { driveOriginalFolderId: origFolder.id } : {}),
      driveMetaFileId: remote.metaFileId,
      driveMetaDirty: false,
    };
    await repo.importBook(book, captures);
    return book;
  } catch (e) {
    await repo.files.removeDir(paths.bookDir(bookId)).catch(() => {});
    throw e;
  }
}

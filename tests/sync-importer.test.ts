import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildBookJson } from '../src/export/bookjson';
import { openBookscanDB } from '../src/storage/db';
import { MemoryFileStore } from '../src/storage/files';
import { Repo } from '../src/storage/repo';
import type { DriveFile } from '../src/sync/drive';
import { importRemoteBook, listRemoteBooks, type ImportDrive } from '../src/sync/importer';

let n = 0;
async function repo() {
  let id = 0;
  return new Repo(await openBookscanDB(`test-import-${++n}`), new MemoryFileStore(), () => 5_000, () => `r${n}-${++id}`);
}

/** 휴대폰에서 촬영·업로드한 책 하나가 있는 가짜 드라이브 */
function fakeDrive(json: string, originals: Record<string, Uint8Array>) {
  const files: (DriveFile & { body?: Blob })[] = [
    { id: 'root1', name: 'BookScan', parents: ['root'], mimeType: 'application/vnd.google-apps.folder' },
    { id: 'bf', name: '책_20261125', parents: ['root1'], mimeType: 'application/vnd.google-apps.folder' },
    { id: 'of', name: 'original', parents: ['bf'], mimeType: 'application/vnd.google-apps.folder' },
    { id: 'meta', name: 'book.json', parents: ['bf'], body: new Blob([json]) },
    ...Object.entries(originals).map(([name, b], i) => ({ id: `o${i}`, name, parents: ['of'], body: new Blob([b as BlobPart]) })),
  ];
  const queries: string[] = [];
  const drive: ImportDrive = {
    async findFolder(name, parent) {
      return files.find((f) => f.name === name && f.parents?.includes(parent) && f.mimeType?.includes('folder')) ?? null;
    },
    async listFiles(q) {
      queries.push(q);
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const folderOnly = q.includes("mimeType = 'application/vnd.google-apps.folder'");
      return files.filter((f) => f.parents?.includes(parent!) && (!name || f.name === name) && (!folderOnly || f.mimeType?.includes('folder')));
    },
    async download(id) {
      const f = files.find((x) => x.id === id);
      if (!f?.body) throw new Error('없음');
      return f.body;
    },
  };
  return { drive, queries };
}

describe('다른 기기에서 불러오기', () => {
  it('book.json 으로 목록을 만들고, 원본을 내려받아 업로드 완료 상태로 넣는다', async () => {
    // 휴대폰 쪽 책
    const phone = await repo();
    const b = await phone.createBook({ title: '책', captureMode: 'spread' });
    const c1 = await phone.addCapture(b.id, { jpeg: new Blob(['a']), thumb: new Blob(['t']), width: 4000, height: 3000, sharpness: 1 });
    await phone.addCapture(b.id, { jpeg: new Blob(['b']), thumb: new Blob(['t']), width: 4000, height: 3000, sharpness: 2 });
    await phone.setUpload(c1.id, { state: 'done', driveFileId: 'o0' }); // 둘째 장은 ID 없이 이름으로 찾는다
    const json = buildBookJson((await phone.getBook(b.id))!, await phone.listCaptures(b.id));
    const { drive } = fakeDrive(JSON.stringify(json), { '0001.jpg': new Uint8Array([1]), '0002.jpg': new Uint8Array([2, 2]) });

    // PC 쪽
    const pc = await repo();
    const list = await listRemoteBooks(drive, pc);
    expect(list).toHaveLength(1);
    expect(list[0]!.json.book.title).toBe('책');
    expect(list[0]!.localBookId).toBeUndefined();
    const progress: number[] = [];
    const book = await importRemoteBook(drive, pc, list[0]!, { makeThumb: async () => new Blob(['t']), onProgress: (d) => progress.push(d) });
    expect(book.id).toBe(b.id); // 같은 책 ID 를 이어 쓴다
    expect(book.driveFolderId).toBe('bf');
    expect(book.driveOriginalFolderId).toBe('of');
    expect(book.driveMetaFileId).toBe('meta');
    expect(book.driveMetaDirty).toBe(false);
    const caps = await pc.listCaptures(book.id);
    expect(caps.map((c) => [c.seq, c.upload.state, c.upload.driveFileId])).toEqual([
      [1, 'done', 'o0'],
      [2, 'done', 'o1'],
    ]);
    expect(new Uint8Array(await (await pc.files.read(caps[1]!.file))!.arrayBuffer())).toEqual(new Uint8Array([2, 2]));
    expect(progress).toEqual([1, 2]);

    // 다시 목록을 보면 이 기기에 있다고 알려 준다
    expect((await listRemoteBooks(drive, pc))[0]!.localBookId).toBe(b.id);
  });

  it('BookScan 폴더가 없으면 빈 목록', async () => {
    const r = await repo();
    const drive: ImportDrive = { findFolder: async () => null, listFiles: async () => [], download: async () => new Blob() };
    expect(await listRemoteBooks(drive, r)).toEqual([]);
  });

  it('원본이 하나도 없으면 오류이고 책을 만들지 않는다', async () => {
    const phone = await repo();
    const b = await phone.createBook({ title: '빈 책', captureMode: 'single' });
    await phone.addCapture(b.id, { jpeg: new Blob(['a']), thumb: new Blob(['t']), width: 1, height: 1, sharpness: 1 });
    const json = buildBookJson((await phone.getBook(b.id))!, await phone.listCaptures(b.id));
    const { drive } = fakeDrive(JSON.stringify(json), {});
    const pc = await repo();
    const [rb] = await listRemoteBooks(drive, pc);
    await expect(importRemoteBook(drive, pc, rb!, { makeThumb: async () => new Blob() })).rejects.toThrow('원본이 없습니다');
    expect(await pc.listBooks()).toHaveLength(0);
  });
});

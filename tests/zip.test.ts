import 'fake-indexeddb/auto';
import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildBookJson, parseBookJson } from '../src/export/bookjson';
import { exportBookZip, importBookZip, zipFileName } from '../src/export/zip';
import { openBookscanDB } from '../src/storage/db';
import { MemoryFileStore } from '../src/storage/files';
import { Repo } from '../src/storage/repo';

let n = 0;
async function setup() {
  const db = await openBookscanDB(`test-zip-${++n}`);
  let id = 0;
  return new Repo(db, new MemoryFileStore(), () => 1_700_000_000_000, () => `z${n}-${++id}`);
}

function bytes(len: number, seed: number): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + seed * 7) & 0xff;
  b[0] = 0xff;
  b[1] = 0xd8;
  return b;
}

describe('ZIP 내보내기·가져오기 (규칙 8)', () => {
  it('원본과 book.json 이 들어가고, 가져오면 순서·메타데이터가 같다', async () => {
    const repo = await setup();
    const book = await repo.createBook({ title: '테스트/책: 1', captureMode: 'spread' });
    const originals = [bytes(300_000, 1), bytes(150_000, 2), bytes(200_000, 3)];
    const caps = [];
    for (const [i, o] of originals.entries()) {
      caps.push(await repo.addCapture(book.id, { jpeg: new Blob([o as BlobPart]), thumb: new Blob(['t']), width: 4000, height: 3000, sharpness: 10 + i, manual: i === 1 }));
    }
    await repo.moveCapture(caps[2]!.id, -2); // 순서: 3, 1, 2

    const progress: number[] = [];
    const out = await exportBookZip(repo, book.id, (d) => progress.push(d));
    expect(out.name).toBe(zipFileName(book));
    expect(out.name).toMatch(/^테스트_책_ 1_\d{8}\.zip$/);
    expect(progress).toEqual([1, 2, 3]);

    // 일반 unzip 으로도 열린다
    const entries = unzipSync(new Uint8Array(await out.file.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(['book.json', 'original/0001.jpg', 'original/0002.jpg', 'original/0003.jpg']);
    expect(entries['original/0002.jpg']).toEqual(originals[1]);
    const json = parseBookJson(strFromU8(entries['book.json']!));
    expect(json.captures.map((c) => c.seq)).toEqual([3, 1, 2]);

    // 가져오기 (같은 DB: 새 ID, 제목에 "(가져옴)")
    const imported = await importBookZip(repo, out.file, { makeThumb: async () => new Blob(['thumb']) });
    expect(imported.id).not.toBe(book.id);
    expect(imported.title).toBe('테스트/책: 1 (가져옴)');
    expect(imported.importedFrom).toBe(book.id);
    expect(imported.captureMode).toBe('spread');
    const icaps = await repo.listCaptures(imported.id);
    expect(icaps.map((c) => c.seq)).toEqual([3, 1, 2]);
    expect(icaps.map((c) => c.order)).toEqual([1, 2, 3]);
    expect(icaps[2]!.manual).toBe(true);
    const back = new Uint8Array(await (await repo.files.read(icaps[0]!.file))!.arrayBuffer());
    expect(back).toEqual(originals[2]);
    expect(imported.nextSeq).toBe(4);
  });

  it('다른 기기(빈 DB)로 가져오면 제목이 그대로다', async () => {
    const a = await setup();
    const book = await a.createBook({ title: '원래 제목', captureMode: 'single' });
    await a.addCapture(book.id, { jpeg: new Blob([bytes(1000, 9) as BlobPart]), thumb: new Blob(['t']), width: 1, height: 1, sharpness: 1 });
    const out = await exportBookZip(a, book.id);
    const b = await setup();
    const imported = await importBookZip(b, out.file, { makeThumb: async () => new Blob(['t']) });
    expect(imported.title).toBe('원래 제목');
  });

  it('book.json 이 없거나 형식이 틀리면 알아들을 수 있는 오류', async () => {
    const repo = await setup();
    const { zipSync, strToU8 } = await import('fflate');
    const noMeta = new Blob([zipSync({ 'original/0001.jpg': bytes(10, 1) }) as BlobPart]);
    await expect(importBookZip(repo, noMeta, { makeThumb: async () => new Blob() })).rejects.toThrow('book.json 이 없습니다');
    const bad = new Blob([zipSync({ 'book.json': strToU8('{"format":"other"}') }) as BlobPart]);
    await expect(importBookZip(repo, bad, { makeThumb: async () => new Blob() })).rejects.toThrow('북스캔 book.json 이 아닙니다');
    expect(await repo.listBooks()).toHaveLength(0);
  });

  it('buildBookJson 은 지운 촬영을 빼고 순서대로 쓴다', () => {
    const base = { bookId: 'b', capturedAt: 0, width: 1, height: 1, bytes: 1, sharpness: 1, thumb: '', file: '', upload: { state: 'done' as const, attempts: 0, driveFileId: 'D' } };
    const j = buildBookJson(
      { id: 'b', title: 't', createdAt: 0, updatedAt: 0, captureMode: 'spread', scanState: 'finished', nextSeq: 4 },
      [
        { ...base, id: 'a', seq: 1, order: 2 },
        { ...base, id: 'c', seq: 2, order: 1 },
        { ...base, id: 'd', seq: 3, order: 3, deleted: true },
      ],
    );
    expect(j.captures.map((c) => [c.seq, c.file, c.driveFileId])).toEqual([
      [2, 'original/0002.jpg', 'D'],
      [1, 'original/0001.jpg', 'D'],
    ]);
  });
});

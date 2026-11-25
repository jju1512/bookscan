import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openBookscanDB } from '../src/storage/db';
import { MemoryFileStore } from '../src/storage/files';
import { BusyTracker } from '../src/storage/busy';
import { formatBytes, isLowSpace, looksEphemeral } from '../src/storage/persist';
import { Repo, pageOrder } from '../src/storage/repo';
import { paths } from '../src/storage/types';

let dbn = 0;
async function setup(files = new MemoryFileStore()) {
  const name = `test-storage-${++dbn}`;
  const db = await openBookscanDB(name);
  let t = 1_000;
  let id = 0;
  const repo = new Repo(db, files, () => ++t, () => `id${++id}`);
  return { repo, db, files, name, reopen: async () => new Repo(await openBookscanDB(name), files, () => ++t, () => `id${++id}`) };
}

const jpeg = (n: number) => new Blob([new Uint8Array([0xff, 0xd8, n, 0xff, 0xd9])], { type: 'image/jpeg' });
const shot = (n: number, extra = {}) => ({ jpeg: jpeg(n), thumb: jpeg(100 + n), width: 4000, height: 3000, sharpness: 50 + n, ...extra });

describe('촬영 저장 (규칙 1)', () => {
  it('원본·썸네일을 OPFS 경로 규칙대로 쓰고, seq·order 를 1부터 매긴다', async () => {
    const { repo, files } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'spread' });
    const c1 = await repo.addCapture(b.id, shot(1));
    const c2 = await repo.addCapture(b.id, shot(2));
    expect([c1.seq, c2.seq]).toEqual([1, 2]);
    expect([c1.order, c2.order]).toEqual([1, 2]);
    expect(c1.file).toBe(`books/${b.id}/original/0001.jpg`);
    expect(await files.exists(c1.file)).toBe(true);
    expect(await files.exists(c1.thumb)).toBe(true);
    expect(c1.upload).toEqual({ state: 'pending', attempts: 0 });
  });

  it('파일 쓰기가 실패하면 IndexedDB 에 기록하지 않는다 (반쪽 기록 없음)', async () => {
    const files = new MemoryFileStore();
    const { repo } = await setup(files);
    const b = await repo.createBook({ title: '책', captureMode: 'single' });
    const orig = files.write.bind(files);
    files.write = async () => {
      throw new Error('디스크 가득');
    };
    await expect(repo.addCapture(b.id, shot(1))).rejects.toThrow('디스크 가득');
    expect(await repo.listCaptures(b.id)).toHaveLength(0);
    files.write = orig;
    const c = await repo.addCapture(b.id, shot(2));
    expect(c.seq).toBe(2); // 실패한 번호는 다시 쓰지 않는다
  });

  it('촬영 직후 새로고침: 저장이 끝난 촬영은 DB 를 다시 열어도 모두 남는다', async () => {
    const { repo, reopen, db } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'spread' });
    for (let i = 1; i <= 5; i++) await repo.addCapture(b.id, shot(i));
    db.close(); // 탭이 닫힘
    const repo2 = await reopen();
    const caps = await repo2.listCaptures(b.id);
    expect(caps.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    for (const c of caps) expect(await repo2.files.read(c.file)).not.toBeNull();
    const c6 = await repo2.addCapture(b.id, shot(6));
    expect(c6.seq).toBe(6);
  });
});

describe('복구 (규칙 2)', () => {
  it('running 으로 남은 업로드·후처리 단계·책 작업을 pending 으로 되돌린다', async () => {
    const { repo, reopen, db } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'spread' });
    const c = await repo.addCapture(b.id, shot(1));
    await repo.setUpload(c.id, { state: 'running' });
    const [left] = await repo.ensurePages(b.id);
    await repo.updatePage(left!.id, (p) => ({ ...p, steps: { ...p.steps, crop: 'done', finger: 'running' } }));
    await repo.putJob({ id: 'j1', bookId: b.id, kind: 'pdf', name: 'a.pdf', file: 'x', upload: { state: 'running', attempts: 1 }, createdAt: 0 });
    db.close();
    const repo2 = await reopen();
    const r = await repo2.recover();
    expect(r).toEqual({ uploads: 1, steps: 1, jobs: 1 });
    const c2 = await repo2.getCapture(c.id);
    expect(c2!.upload.state).toBe('pending');
    expect(c2!.upload.checkRemote).toBe(true); // 올라갔는지 확인하고 다시 올린다
    const p2 = await repo2.getPage(left!.id);
    expect(p2!.steps.crop).toBe('done');
    expect(p2!.steps.finger).toBe('pending');
    expect((await repo2.allJobs())[0]!.upload.state).toBe('pending');
  });
});

describe('목록 조작: 삭제·재촬영·순서 변경', () => {
  it('삭제는 deleted 로 남기고 로컬 파일과 페이지를 지운다', async () => {
    const { repo, files } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'spread' });
    const c1 = await repo.addCapture(b.id, shot(1));
    await repo.addCapture(b.id, shot(2));
    await repo.ensurePages(b.id);
    await repo.deleteCapture(c1.id);
    expect((await repo.listCaptures(b.id)).map((c) => c.seq)).toEqual([2]);
    expect((await repo.listCaptures(b.id, true)).find((c) => c.id === c1.id)!.deleted).toBe(true);
    expect(await files.exists(c1.file)).toBe(false);
    expect((await repo.listPages(b.id)).every((p) => p.captureId !== c1.id)).toBe(true);
  });

  it('재촬영은 같은 순서 자리에 새 촬영을 넣고 옛 촬영을 지운다', async () => {
    const { repo } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'single' });
    await repo.addCapture(b.id, shot(1));
    const c2 = await repo.addCapture(b.id, shot(2));
    await repo.addCapture(b.id, shot(3));
    const re = await repo.addCapture(b.id, shot(9, { replaceCaptureId: c2.id }));
    expect(re.seq).toBe(4);
    expect(re.order).toBe(c2.order);
    expect((await repo.listCaptures(b.id)).map((c) => c.seq)).toEqual([1, 4, 3]);
  });

  it('순서 바꾸기: moveCapture 와 reorder, 페이지 순서도 따라간다', async () => {
    const { repo } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'spread' });
    const a = await repo.addCapture(b.id, shot(1));
    const c = await repo.addCapture(b.id, shot(2));
    const d = await repo.addCapture(b.id, shot(3));
    await repo.ensurePages(b.id);
    await repo.moveCapture(d.id, -1);
    expect((await repo.listCaptures(b.id)).map((x) => x.seq)).toEqual([1, 3, 2]);
    await repo.reorder(b.id, [c.id, a.id, d.id]);
    expect((await repo.listCaptures(b.id)).map((x) => x.seq)).toEqual([2, 1, 3]);
    const pages = await repo.listPages(b.id);
    expect(pages.map((p) => `${p.captureId}:${p.side}`)).toEqual([`${c.id}:left`, `${c.id}:right`, `${a.id}:left`, `${a.id}:right`, `${d.id}:left`, `${d.id}:right`]);
    expect(pageOrder(2, 'right')).toBe(5);
  });

  it('책 삭제는 메타데이터와 파일을 모두 지운다', async () => {
    const { repo, files } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'spread' });
    await repo.addCapture(b.id, shot(1));
    await repo.deleteBook(b.id);
    expect(await repo.getBook(b.id)).toBeUndefined();
    expect([...files.files.keys()].some((k) => k.startsWith(paths.bookDir(b.id)))).toBe(false);
  });
});

describe('후처리 페이지 상태', () => {
  it('펼침은 촬영마다 left/right, 한 페이지는 single', async () => {
    const { repo } = await setup();
    const s = await repo.createBook({ title: '펼침', captureMode: 'spread' });
    await repo.addCapture(s.id, shot(1));
    expect((await repo.ensurePages(s.id)).map((p) => p.side)).toEqual(['left', 'right']);
    const one = await repo.createBook({ title: '한쪽', captureMode: 'single' });
    await repo.addCapture(one.id, shot(1));
    expect((await repo.ensurePages(one.id)).map((p) => p.side)).toEqual(['single']);
    // 두 번 불러도 늘어나지 않는다
    expect(await repo.ensurePages(one.id)).toHaveLength(1);
  });

  it('단계 결과는 파일을 쓴 뒤 상태를 바꾸고, resetPageSteps 는 그 단계부터 되돌린다', async () => {
    const { repo, files } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'single' });
    await repo.addCapture(b.id, shot(1));
    const [p] = await repo.ensurePages(b.id);
    await repo.saveStepResult(p!.id, 'crop', 'done', { image: jpeg(5), durationMs: 120 });
    await repo.saveStepResult(p!.id, 'finger', 'done', { image: jpeg(6), patch: { fingerOverText: true } });
    await repo.saveStepResult(p!.id, 'dewarp', 'skipped', { note: '글자 줄 적음' });
    let q = (await repo.getPage(p!.id))!;
    expect(q.steps).toMatchObject({ crop: 'done', finger: 'done', dewarp: 'skipped', enhance: 'pending' });
    expect(q.files.crop).toBe(paths.pageStep(b.id, p!.id, 'crop'));
    expect(q.notes?.dewarp).toBe('글자 줄 적음');
    expect(q.durations?.crop).toBe(120);
    expect(await files.exists(q.files.finger!)).toBe(true);
    q = await repo.resetPageSteps(p!.id, 'finger');
    expect(q.steps).toMatchObject({ crop: 'done', finger: 'pending', dewarp: 'pending' });
    expect(q.files.finger).toBeUndefined();
    expect(q.fingerOverText).toBeUndefined();
    expect(await files.exists(paths.pageStep(b.id, p!.id, 'finger'))).toBe(false);
  });
});

describe('로컬 정리 (규칙 7)', () => {
  it('업로드와 후처리가 모두 끝난 원본만 지운다', async () => {
    const { repo, files } = await setup();
    const b = await repo.createBook({ title: '책', captureMode: 'single' });
    const c1 = await repo.addCapture(b.id, shot(1));
    const c2 = await repo.addCapture(b.id, shot(2));
    const c3 = await repo.addCapture(b.id, shot(3));
    const pages = await repo.ensurePages(b.id);
    const done = { crop: 'done', finger: 'done', dewarp: 'skipped', enhance: 'done', ocr: 'done' } as const;
    await repo.updatePage(pages[0]!.id, (p) => ({ ...p, steps: { ...done } }));
    await repo.updatePage(pages[1]!.id, (p) => ({ ...p, steps: { ...done } }));
    await repo.setUpload(c1.id, { state: 'done', driveFileId: 'f1' });
    await repo.setUpload(c3.id, { state: 'done', driveFileId: 'f3' }); // 후처리 안 됨
    expect(await repo.cleanupLocal(b.id)).toBe(1);
    expect(await files.exists(c1.file)).toBe(false);
    expect(await files.exists(c2.file)).toBe(true); // 업로드 안 됨
    expect(await files.exists(c3.file)).toBe(true);
    expect(await files.exists(c1.thumb)).toBe(true);
  });
});

describe('저장 공간 판단 (규칙 4·5·6)', () => {
  it('여유 공간 부족·시크릿 모드 판단', () => {
    expect(isLowSpace({ usage: 0, quota: 100 * 1024 * 1024 })).toBe(true);
    expect(isLowSpace({ usage: 0, quota: 10 * 1024 ** 3 })).toBe(false);
    expect(isLowSpace({})).toBe(false);
    expect(looksEphemeral({ quota: 100 * 1024 * 1024, opfsOk: true, idbOk: true })).toMatch('시크릿');
    expect(looksEphemeral({ quota: 10 * 1024 ** 3, opfsOk: false, idbOk: true })).toMatch('OPFS');
    expect(looksEphemeral({ quota: 10 * 1024 ** 3, opfsOk: true, idbOk: true })).toBeUndefined();
    expect(formatBytes(1536)).toBe('1.5KB');
  });

  it('BusyTracker: 저장 중이거나 등록된 작업이 바쁘면 떠나기 경고 사유가 있다 (규칙 3)', async () => {
    const b = new BusyTracker();
    expect(b.reasons()).toEqual([]);
    let release!: () => void;
    const p = b.track(new Promise<void>((r) => (release = r)));
    expect(b.reasons()).toEqual(['저장 중 1건']);
    release();
    await p;
    expect(b.reasons()).toEqual([]);
    let n = 2;
    b.register('upload', () => (n ? `업로드 대기 ${n}장` : null));
    expect(b.reasons()).toEqual(['업로드 대기 2장']);
    n = 0;
    expect(b.reasons()).toEqual([]);
  });
});

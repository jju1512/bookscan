/**
 * 책 화면: 촬영 목록(썸네일)·미리보기·삭제·재촬영·순서 변경, ZIP 내보내기, 촬영 시작, 후처리로 가기.
 */
import { getSettings } from '../../config/settings';
import { log } from '../../debug/log';
import { formatBytes } from '../../storage/persist';
import type { Book, Capture, Page } from '../../storage/types';
import type { Screen } from '../context';
import { append, clear, h } from '../dom';
import { blobImg, confirmDialog, downloadBlob, modal, promptDialog, toast } from '../ui';
import { syncStatusLine } from './common';

export const bookScreen: Screen = (ctx, route, root) => {
  if (route.name !== 'book') return;
  const bookId = route.bookId;
  const head = h('header', { class: 'page-head' });
  const actions = h('div', { class: 'head-actions' });
  const info = h('p', { class: 'muted small' });
  const syncLine = h('p', { class: 'muted small' });
  const grid = h('div', { class: 'cap-grid' });
  root.append(h('section', { class: 'page' }, head, actions, info, syncLine, grid));

  let urls: string[] = [];
  let book: Book | undefined;
  let caps: Capture[] = [];
  let pages: Page[] = [];

  const render = async () => {
    book = await ctx.repo.getBook(bookId);
    if (!book) {
      clear(head);
      head.append(h('h1', {}, '책을 찾을 수 없습니다'), h('a', { href: '#/', class: 'btn' }, '목록으로'));
      return;
    }
    caps = await ctx.repo.listCaptures(bookId);
    pages = await ctx.repo.listPages(bookId);
    renderHead(book);
    renderActions(book);
    const bytes = caps.reduce((s, c) => s + c.bytes, 0);
    const uploaded = caps.filter((c) => c.upload.state === 'done').length;
    info.textContent = `${caps.length}장 · ${formatBytes(bytes)} · ${book.captureMode === 'spread' ? '양쪽 펼침' : '한 페이지'}${ctx.sync.configured && getSettings().driveEnabled ? ` · 드라이브 ${uploaded}/${caps.length}` : ''}`;
    await renderGrid();
  };

  const renderHead = (b: Book) => {
    clear(head);
    head.append(
      h('a', { href: '#/', class: 'btn btn-quiet', 'aria-label': '책 목록으로' }, '← 목록'),
      h('h1', {}, b.title),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-quiet btn-small',
          onclick: async () => {
            const t = await promptDialog('책 제목', b.title);
            if (t !== null && t.trim()) await ctx.repo.updateBook(b.id, { title: t.trim(), driveMetaDirty: true });
          },
        },
        '제목 바꾸기',
      ),
    );
  };

  const renderActions = (b: Book) => {
    clear(actions);
    append(
      actions,
      h('button', { type: 'button', class: 'btn btn-primary btn-big', onclick: () => ctx.go({ name: 'scan', bookId }) }, caps.length ? '이어서 촬영' : '촬영 시작'),
      b.scanState === 'scanning'
        ? h('button', { type: 'button', class: 'btn', disabled: caps.length === 0, onclick: () => void ctx.repo.updateBook(bookId, { scanState: 'finished', driveMetaDirty: true }) }, '촬영 끝내기')
        : h('button', { type: 'button', class: 'btn', onclick: () => void ctx.repo.updateBook(bookId, { scanState: 'scanning' }) }, '촬영 다시 열기'),
      h('button', { type: 'button', class: 'btn', disabled: caps.length === 0, onclick: () => ctx.go({ name: 'process', bookId }) }, '후처리'),
      h('button', { type: 'button', class: 'btn', disabled: caps.length === 0, onclick: () => void exportZip() }, 'ZIP 내보내기'),
      getSettings().localCleanup ? h('button', { type: 'button', class: 'btn', onclick: () => void cleanup() }, '로컬 정리') : null,
      h('button', { type: 'button', class: 'btn btn-quiet btn-danger-text', onclick: () => void removeBook() }, '책 삭제'),
    );
  };

  const exportZip = async () => {
    if (!book) return;
    const { exportBookZip } = await import('../../export/zip');
    const progress = h('p', {}, '준비 중…');
    const m = modal(h('div', { class: 'confirm' }, h('h2', {}, 'ZIP 내보내기'), progress));
    try {
      const { file, name } = await exportBookZip(ctx.repo, bookId, (done, total) => (progress.textContent = `${done}/${total}장 넣는 중…`));
      m.close();
      downloadBlob(name, file);
      toast(`${name} 을(를) 만들었습니다`, 'ok');
    } catch (e) {
      m.close();
      log.error('ZIP 내보내기 실패', e);
      toast(`내보내기 실패: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
    }
  };

  const cleanup = async () => {
    const ok = await confirmDialog('드라이브 업로드와 후처리가 모두 끝난 원본만 이 기기에서 지웁니다.', {
      detail: '촬영 기록·썸네일·후처리 결과는 남고, 원본은 드라이브에 있습니다. 되돌릴 수 없습니다.',
      ok: '로컬 정리',
      danger: true,
    });
    if (!ok) return;
    const n = await ctx.repo.cleanupLocal(bookId);
    toast(`원본 ${n}장을 지웠습니다`, 'ok');
  };

  const removeBook = async () => {
    const ok = await confirmDialog(`"${book?.title}" 을(를) 이 기기에서 지울까요?`, {
      detail: '원본과 후처리 결과가 모두 지워집니다. 드라이브에 올라간 파일은 그대로 둡니다. 먼저 ZIP 으로 내보내 두는 것을 권합니다.',
      ok: '지우기',
      danger: true,
    });
    if (!ok) return;
    await ctx.repo.deleteBook(bookId);
    ctx.go({ name: 'books' });
  };

  const renderGrid = async () => {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    clear(grid);
    if (caps.length === 0) {
      grid.append(h('p', { class: 'muted' }, '아직 찍은 페이지가 없습니다.'));
      return;
    }
    for (const [i, c] of caps.entries()) {
      const blob = await ctx.repo.files.read(c.thumb);
      const { img } = blobImg(blob, { alt: `${i + 1}번째 촬영`, loading: 'lazy' });
      if (img.src) urls.push(img.src);
      const myPages = pages.filter((p) => p.captureId === c.id);
      const flags: string[] = [];
      if (myPages.some((p) => p.fingerOverText)) flags.push('손가락이 글자를 덮음');
      if (myPages.some((p) => p.needsManual)) flags.push('수동 보정 필요');
      if (c.manual) flags.push('수동');
      const up = uploadBadge(c);
      grid.append(
        h(
          'div',
          { class: `cap-card${flags.length > (c.manual ? 1 : 0) ? ' cap-warn' : ''}` },
          h('button', { type: 'button', class: 'cap-open', onclick: () => void openPreview(i), 'aria-label': `${i + 1}번째 촬영 크게 보기` }, img),
          h(
            'div',
            { class: 'cap-meta' },
            h('strong', {}, String(i + 1)),
            up ? h('span', { class: `badge badge-${c.upload.state}`, title: c.upload.lastError ?? '' }, up) : null,
            ...flags.map((f) => h('span', { class: 'badge badge-warn' }, f)),
          ),
          h(
            'div',
            { class: 'cap-move' },
            h('button', { type: 'button', class: 'btn btn-small', disabled: i === 0, 'aria-label': '앞으로', onclick: () => void ctx.repo.moveCapture(c.id, -1) }, '◀'),
            h('button', { type: 'button', class: 'btn btn-small', disabled: i === caps.length - 1, 'aria-label': '뒤로', onclick: () => void ctx.repo.moveCapture(c.id, 1) }, '▶'),
          ),
        ),
      );
    }
  };

  const uploadBadge = (c: Capture): string | null => {
    if (!ctx.sync.configured || !getSettings().driveEnabled) return null;
    switch (c.upload.state) {
      case 'done': return '올림';
      case 'running': return '올리는 중';
      case 'failed': return `실패 ${c.upload.attempts}회`;
      default: return '대기';
    }
  };

  const openPreview = async (index: number) => {
    let i = index;
    const imgBox = h('div', { class: 'preview-img' });
    const caption = h('p', { class: 'muted small' });
    let revoke = () => {};
    const show = async () => {
      const c = caps[i];
      if (!c) return;
      revoke();
      clear(imgBox);
      const blob = await ctx.repo.files.read(c.file);
      const r = blobImg(blob ?? (await ctx.repo.files.read(c.thumb)), { alt: `${i + 1}번째 촬영 원본` });
      revoke = r.revoke;
      imgBox.append(r.img);
      caption.textContent = `${i + 1}/${caps.length} · #${c.seq} · ${c.width}×${c.height} · ${formatBytes(c.bytes)} · 선명도 ${Math.round(c.sharpness)}${c.manual ? ' · 수동 촬영' : ''}${blob ? '' : ' · 원본이 이 기기에 없음 (로컬 정리됨)'}`;
    };
    const m = modal(
      h(
        'div',
        { class: 'preview' },
        imgBox,
        caption,
        h(
          'div',
          { class: 'row-actions wrap' },
          h('button', { type: 'button', class: 'btn', onclick: () => { if (i > 0) { i--; void show(); } } }, '← 이전'),
          h('button', { type: 'button', class: 'btn', onclick: () => { if (i < caps.length - 1) { i++; void show(); } } }, '다음 →'),
          h('button', { type: 'button', class: 'btn', onclick: () => { const c = caps[i]; if (c) { m.close(); ctx.go({ name: 'scan', bookId, retake: c.id }); } } }, '재촬영'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-danger',
              onclick: async () => {
                const c = caps[i];
                if (!c) return;
                if (!(await confirmDialog(`${i + 1}번째 촬영을 지울까요?`, { ok: '지우기', danger: true, detail: '이 기기의 원본과 후처리 결과가 지워집니다. 드라이브에 올라간 파일은 그대로 둡니다.' }))) return;
                await ctx.repo.deleteCapture(c.id);
                m.close();
              },
            },
            '삭제',
          ),
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => m.close() }, '닫기'),
        ),
      ),
      { wide: true, onClose: () => revoke() },
    );
    await show();
  };

  void render();
  let pendingRender: ReturnType<typeof setTimeout> | null = null;
  const unsub = ctx.repo.subscribe((e) => {
    if (('bookId' in e && e.bookId === bookId) || e.type === 'books') {
      if (pendingRender) clearTimeout(pendingRender);
      pendingRender = setTimeout(() => void render(), 150);
    }
  });
  const renderSync = () => syncStatusLine(ctx, syncLine);
  renderSync();
  const unsubSync = ctx.sync.onChange(renderSync);
  return () => {
    unsub();
    unsubSync();
    if (pendingRender) clearTimeout(pendingRender);
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
};

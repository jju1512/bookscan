/** 책 목록 (첫 화면): 새 책 만들기, ZIP 가져오기, 드라이브에서 불러오기, 저장 공간 표시 */
import { getSettings } from '../../config/settings';
import { log } from '../../debug/log';
import { formatBytes, freeBytes } from '../../storage/persist';
import type { Book, CaptureMode } from '../../storage/types';
import type { Screen } from '../context';
import { clear, h } from '../dom';
import { formatDate, modal, pickFile, toast } from '../ui';
import { syncStatusLine } from './common';

export const booksScreen: Screen = (ctx, _route, root) => {
  const list = h('div', { class: 'book-list' }, h('p', { class: 'muted' }, '불러오는 중…'));
  const storageLine = h('p', { class: 'muted small' });
  const syncLine = h('p', { class: 'muted small' });

  const newBook = () => {
    const title = h('input', { type: 'text', class: 'input', placeholder: '예: 자바 프로그래밍', maxlength: 80, 'aria-label': '책 제목' });
    const mode = getSettings().defaultCaptureMode;
    const radio = (value: CaptureMode, label: string, help: string) =>
      h(
        'label',
        { class: 'radio' },
        h('input', { type: 'radio', name: 'captureMode', value, checked: value === mode }),
        h('span', {}, h('strong', {}, label), h('small', {}, help)),
      );
    const create = async () => {
      const picked = (m.el.querySelector('input[name=captureMode]:checked') as HTMLInputElement | null)?.value as CaptureMode | undefined;
      const book = await ctx.repo.createBook({ title: title.value, captureMode: picked ?? 'spread' });
      m.close();
      log.info('책 만듦', { id: book.id, title: book.title, mode: book.captureMode });
      ctx.go({ name: 'book', bookId: book.id });
    };
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void create();
    });
    const m = modal(
      h(
        'form',
        { class: 'form', onsubmit: (e: Event) => { e.preventDefault(); void create(); } },
        h('h2', {}, '새 책'),
        h('label', { class: 'field' }, '제목', title),
        h(
          'fieldset',
          { class: 'field' },
          h('legend', {}, '촬영 단위'),
          radio('spread', '양쪽 펼침', '펼친 두 페이지를 한 장으로 찍고, 후처리에서 좌우로 나눕니다 (기본)'),
          radio('single', '한 페이지', '한 번에 한 페이지만 찍습니다'),
        ),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn', onclick: () => m.close() }, '취소'), h('button', { type: 'submit', class: 'btn btn-primary' }, '만들기')),
      ),
    );
    setTimeout(() => title.focus(), 0);
  };

  const importZip = async () => {
    const file = await pickFile('.zip,application/zip');
    if (!file) return;
    const { importBookZip } = await import('../../export/zip');
    const progress = h('p', {}, 'ZIP 을 읽는 중…');
    const m = modal(h('div', { class: 'confirm' }, h('h2', {}, '가져오기'), progress));
    try {
      const book = await importBookZip(ctx.repo, file, (done, total) => (progress.textContent = `원본 ${done}/${total}장 저장 중…`));
      m.close();
      toast(`"${book.title}" 을(를) 가져왔습니다`, 'ok');
      ctx.go({ name: 'book', bookId: book.id });
    } catch (e) {
      m.close();
      log.error('ZIP 가져오기 실패', e);
      toast(`가져오기 실패: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
    }
  };

  const header = h(
    'header',
    { class: 'page-head' },
    h('h1', {}, '북스캔'),
    h(
      'div',
      { class: 'head-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-big', onclick: newBook }, '+ 새 책'),
      h('button', { type: 'button', class: 'btn', onclick: () => void importZip() }, 'ZIP 가져오기'),
      ctx.sync.configured ? h('button', { type: 'button', class: 'btn', onclick: () => ctx.go({ name: 'driveImport' }) }, '드라이브에서 불러오기') : null,
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => ctx.go({ name: 'settings' }) }, '설정'),
    ),
  );
  root.append(h('section', { class: 'page' }, header, storageLine, syncLine, list));

  const renderStorage = async () => {
    const s = await ctx.refreshStorage();
    storageLine.textContent = `저장 공간: ${formatBytes(s.usage)} 사용 · 여유 ${formatBytes(freeBytes(s))}${s.persisted ? ' · 영구 저장 허용됨' : ''}`;
  };

  const renderBooks = async () => {
    const books = await ctx.repo.listBooks();
    clear(list);
    if (books.length === 0) {
      list.append(h('div', { class: 'empty' }, h('p', {}, '아직 책이 없습니다.'), h('p', { class: 'muted' }, '"+ 새 책" 을 누르고, 휴대폰을 거치대에 고정한 뒤 페이지를 넘기면 자동으로 찍힙니다.')));
      return;
    }
    for (const b of books) list.append(await bookCard(b));
  };

  const bookCard = async (b: Book) => {
    const caps = await ctx.repo.listCaptures(b.id);
    const first = caps[0];
    const thumb = h('div', { class: 'book-thumb' });
    if (first) {
      const blob = await ctx.repo.files.read(first.thumb);
      if (blob) {
        const url = URL.createObjectURL(blob);
        thumb.append(h('img', { src: url, alt: '', decoding: 'async' }));
        urls.push(url);
      }
    }
    const status = b.processState === 'done' ? '후처리 완료' : b.processState === 'running' ? '후처리 중' : b.scanState === 'finished' ? '촬영 끝' : '촬영 중';
    return h(
      'a',
      { class: 'book-card', href: `#/book/${encodeURIComponent(b.id)}` },
      thumb,
      h('div', { class: 'book-meta' }, h('strong', {}, b.title), h('span', {}, `${caps.length}장 · ${b.captureMode === 'spread' ? '양쪽 펼침' : '한 페이지'} · ${status}`), h('small', { class: 'muted' }, formatDate(b.updatedAt))),
    );
  };

  const urls: string[] = [];
  const refresh = () => {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    void renderBooks();
  };
  refresh();
  void renderStorage();
  const unsubRepo = ctx.repo.subscribe((e) => {
    if (e.type === 'books') refresh();
  });
  const renderSync = () => syncStatusLine(ctx, syncLine);
  renderSync();
  const unsubSync = ctx.sync.onChange(renderSync);
  return () => {
    unsubRepo();
    unsubSync();
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
};

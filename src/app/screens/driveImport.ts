/** 다른 기기에서 불러오기 (SPEC 7장): BookScan/ 아래 book.json 으로 책 목록 → 고른 책의 원본을 내려받는다 */
import { getSettings } from '../../config/settings';
import { log } from '../../debug/log';
import type { Screen } from '../context';
import { clear, h } from '../dom';
import { formatDate, toast } from '../ui';

export const driveImportScreen: Screen = (ctx, _route, root) => {
  const body = h('div', {});
  root.append(
    h(
      'section',
      { class: 'page' },
      h('header', { class: 'page-head' }, h('a', { href: '#/', class: 'btn btn-quiet' }, '← 목록'), h('h1', {}, '드라이브에서 불러오기')),
      h(
        'p',
        { class: 'notice notice-warn' },
        '이 앱이 만든 파일만 보입니다 (drive.file 권한). 드라이브에 직접 올린 사진이나 다른 앱으로 만든 폴더는 보이지 않습니다.',
      ),
      body,
    ),
  );
  let aborted = false;

  const render = async () => {
    clear(body);
    if (!ctx.sync.configured) {
      body.append(h('p', {}, '설정 필요 — 이 배포에는 구글 클라이언트 ID 가 없습니다.'));
      return;
    }
    if (!getSettings().driveEnabled || !ctx.sync.connected()) {
      body.append(
        h('p', {}, '먼저 드라이브에 연결해야 합니다.'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-big',
            onclick: async () => {
              try {
                await ctx.sync.connect();
                void render();
              } catch (e) {
                toast(`연결 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
              }
            },
          },
          getSettings().driveEnabled ? '드라이브 다시 연결' : '연동하기',
        ),
      );
      return;
    }
    body.append(h('p', { class: 'muted' }, '드라이브에서 책 목록을 읽는 중…'));
    const { currentDrive } = await import('../../sync');
    const { listRemoteBooks, importRemoteBook } = await import('../../sync/importer');
    const drive = currentDrive();
    if (!drive) return;
    let list;
    try {
      list = await listRemoteBooks(drive, ctx.repo);
    } catch (e) {
      log.error('드라이브 목록 실패', e);
      clear(body);
      body.append(h('p', { class: 'notice notice-error' }, `목록을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`), h('button', { type: 'button', class: 'btn', onclick: () => void render() }, '다시 시도'));
      return;
    }
    if (aborted) return;
    clear(body);
    if (list.length === 0) {
      body.append(h('p', {}, '드라이브의 BookScan/ 폴더에 불러올 책이 없습니다. 휴대폰에서 연동한 뒤 원본이 올라가면 여기에 보입니다.'));
      return;
    }
    for (const rb of list) {
      const progress = h('span', { class: 'muted small' });
      const btn = h('button', { type: 'button', class: 'btn btn-primary' }, rb.localBookId ? '이 기기에 있음 · 열기' : '불러오기');
      btn.addEventListener('click', async () => {
        if (rb.localBookId) {
          ctx.go({ name: 'book', bookId: rb.localBookId });
          return;
        }
        btn.disabled = true;
        try {
          const book = await importRemoteBook(drive, ctx.repo, rb, { onProgress: (d, t) => (progress.textContent = `${d}/${t}장 받는 중…`) });
          toast(`"${book.title}" 을(를) 불러왔습니다`, 'ok');
          ctx.go({ name: 'book', bookId: book.id });
        } catch (e) {
          log.error('불러오기 실패', e);
          progress.textContent = `실패: ${e instanceof Error ? e.message : String(e)}`;
          btn.disabled = false;
        }
      });
      body.append(
        h(
          'div',
          { class: 'book-card' },
          h(
            'div',
            { class: 'book-meta' },
            h('strong', {}, rb.json.book.title),
            h('span', {}, `${rb.json.captures.length}장 · ${rb.json.book.captureMode === 'spread' ? '양쪽 펼침' : '한 페이지'}`),
            h('small', { class: 'muted' }, `갱신 ${formatDate(rb.json.book.updatedAt)}`),
            progress,
          ),
          btn,
        ),
      );
    }
  };
  void render();
  return () => {
    aborted = true;
  };
};

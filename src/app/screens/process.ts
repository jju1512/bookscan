/**
 * 후처리 화면 (SPEC 8장): 단계 켜고 끄기, 처리 시작·멈춤·이어서, 진행률·남은 시간, 페이지별 상태,
 * 페이지별 건너뛰기, 손가락이 글자를 덮은 페이지·수동 보정이 필요한 페이지 표시, PDF 만들기·내려받기.
 */
import { getSettings, updateSettings } from '../../config/settings';
import { processService } from '../../process/service';
import { finalImagePath, needsWork } from '../../process/runner';
import { pdfFileName } from '../../sync/names';
import { paths, PROCESS_STEPS, type Page, type ProcessStepName, type StepState } from '../../storage/types';
import type { Screen } from '../context';
import { append, clear, h } from '../dom';
import { downloadBlob, formatDuration, toast } from '../ui';
import { STEP_LABELS } from './settings';

const STATE_LABEL: Record<StepState, string> = { pending: '대기', running: '처리 중', done: '완료', failed: '실패', skipped: '건너뜀' };

export const processScreen: Screen = (ctx, route, root) => {
  if (route.name !== 'process') return;
  const { bookId } = route;
  const svc = processService(ctx.repo);
  svc.afterPdf = async (id, path, name) => {
    if (ctx.sync.configured && getSettings().driveEnabled) {
      await ctx.sync.enqueuePdf(id, path, name);
      toast('PDF 를 드라이브 업로드 대기열에 넣었습니다', 'ok');
    }
  };

  const head = h('header', { class: 'page-head' });
  const toggles = h('div', { class: 'set-group' });
  const controls = h('div', { class: 'head-actions' });
  const status = h('div', { class: 'proc-status', 'aria-live': 'polite' });
  const bar = h('progress', { class: 'proc-bar', max: 1, value: 0 });
  const list = h('div', { class: 'page-list' });
  root.append(h('section', { class: 'page' }, head, toggles, controls, bar, status, h('h2', {}, '페이지'), list));

  const urls: string[] = [];
  let pages: Page[] = [];

  const renderToggles = () => {
    const s = getSettings();
    clear(toggles);
    toggles.append(h('h2', {}, '단계'));
    const row = h('div', { class: 'toggle-row' });
    for (const step of PROCESS_STEPS) {
      const input = h('input', { type: 'checkbox', checked: s.steps[step], disabled: svc.state.running });
      input.addEventListener('change', () => updateSettings({ steps: { ...getSettings().steps, [step]: input.checked } }));
      row.append(h('label', { class: 'check' }, input, h('span', {}, STEP_LABELS[step])));
    }
    const bin = h('input', { type: 'checkbox', checked: s.enhanceBinarize, disabled: svc.state.running });
    bin.addEventListener('change', () => updateSettings({ enhanceBinarize: bin.checked }));
    row.append(h('label', { class: 'check' }, bin, h('span', {}, '보정: 흑백으로')));
    toggles.append(row, h('p', { class: 'muted small' }, '끈 단계는 건너뛰고 앞 단계 결과를 씁니다. 이미 끝난 단계에는 영향이 없습니다 — 다시 하려면 페이지의 "다시 처리".'));
  };

  const renderControls = async () => {
    const book = await ctx.repo.getBook(bookId);
    clear(head);
    head.append(h('a', { href: `#/book/${encodeURIComponent(bookId)}`, class: 'btn btn-quiet' }, '← 책'), h('h1', {}, `후처리 · ${book?.title ?? ''}`));
    clear(controls);
    const running = svc.state.running && svc.state.bookId === bookId;
    const otherRunning = svc.state.running && svc.state.bookId !== bookId;
    const remaining = pages.filter(needsWork).length;
    const started = pages.some((p) => PROCESS_STEPS.some((s) => p.steps[s] !== 'pending'));
    const pdfName = book ? pdfFileName(book.title) : '';
    const pdfPath = paths.exportFile(bookId, pdfName);
    const hasPdf = !!book && (await ctx.repo.files.exists(pdfPath));
    append(
      controls,
      running
        ? h('button', { type: 'button', class: 'btn btn-big', onclick: () => svc.stop() }, '멈춤')
        : h(
            'button',
            { type: 'button', class: 'btn btn-primary btn-big', disabled: otherRunning || (remaining === 0 && pages.length > 0), onclick: () => void svc.start(bookId) },
            pages.length === 0 || !started ? '처리 시작' : remaining ? `이어서 처리 (${remaining}쪽 남음)` : '모두 처리됨',
          ),
      h('button', { type: 'button', class: 'btn', disabled: running, onclick: () => void makePdf() }, 'PDF 만들기'),
      hasPdf ? h('button', { type: 'button', class: 'btn', onclick: () => void downloadPdf(pdfPath, pdfName) }, 'PDF 내려받기') : null,
      h('button', { type: 'button', class: 'btn', onclick: () => ctx.go({ name: 'compare', bookId }) }, '전후 비교'),
    );
    if (otherRunning) controls.append(h('p', { class: 'muted small' }, '다른 책을 처리하는 중입니다.'));
  };

  const makePdf = async () => {
    try {
      await svc.makePdf(bookId);
      await renderControls();
    } catch (e) {
      toast(`PDF 실패: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
    }
  };

  const downloadPdf = async (path: string, name: string) => {
    const blob = await ctx.repo.files.read(path);
    if (blob) downloadBlob(name, blob);
  };

  const renderStatus = () => {
    const s = svc.state;
    const p = s.bookId === bookId ? s.progress : null;
    clear(status);
    if (p) {
      bar.max = Math.max(1, p.stepsTotal);
      bar.value = p.stepsDone;
      status.append(
        h('strong', {}, `${p.pagesDone}/${p.pagesTotal}쪽`),
        p.current ? ` · ${Math.floor(p.current.order / 2)}번째 촬영 ${STEP_LABELS[p.current.step]}` : '',
        ` · 남은 시간 ${p.etaMs === undefined ? '계산 중' : formatDuration(p.etaMs)}`,
      );
    } else {
      const total = pages.length * PROCESS_STEPS.length;
      const done = pages.reduce((n, pg) => n + PROCESS_STEPS.filter((st) => pg.steps[st] !== 'pending' && pg.steps[st] !== 'running').length, 0);
      bar.max = Math.max(1, total);
      bar.value = done;
      status.append(`${pages.filter((pg) => !needsWork(pg)).length}/${pages.length}쪽 처리됨`);
    }
    if (s.running && s.bookId === bookId) status.append(h('p', { class: 'muted small' }, '화면이 켜져 있을 때만 진행됩니다 (화면 꺼짐 방지 켜짐). 새로고침하거나 앱을 닫아도 다음에 이어서 합니다.'));
    if (s.message && s.bookId === bookId) status.append(h('p', {}, s.message));
    if (s.pdf?.bookId === bookId && s.pdf.textError) status.append(h('p', { class: 'notice notice-warn' }, s.pdf.textError));
  };

  const renderPages = async () => {
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    clear(list);
    const caps = new Map((await ctx.repo.listCaptures(bookId)).map((c, i) => [c.id, { c, n: i + 1 }]));
    for (const p of pages) {
      const cap = caps.get(p.captureId);
      const imgPath = finalImagePath(p) ?? cap?.c.thumb;
      const blob = imgPath ? await ctx.repo.files.read(imgPath) : null;
      const img = h('img', { alt: '', loading: 'lazy' });
      if (blob) {
        const u = URL.createObjectURL(blob);
        urls.push(u);
        img.src = u;
      }
      const label = `${cap?.n ?? '?'}번째 촬영${p.side === 'single' ? '' : p.side === 'left' ? ' 왼쪽' : ' 오른쪽'}`;
      const chips = PROCESS_STEPS.map((s) => h('span', { class: `badge badge-${p.steps[s]}`, title: p.notes?.[s] ?? '' }, `${STEP_LABELS[s].split(' ')[0]} ${STATE_LABEL[p.steps[s]]}`));
      const skipBox = h('details', { class: 'skip-box' }, h('summary', {}, '이 페이지 건너뛸 단계'));
      for (const s of PROCESS_STEPS) {
        const cb = h('input', { type: 'checkbox', checked: p.skip?.includes(s) ?? false });
        cb.addEventListener('change', async () => {
          const skip = new Set(p.skip ?? []);
          if (cb.checked) skip.add(s);
          else skip.delete(s);
          await ctx.repo.updatePage(p.id, (x) => ({ ...x, skip: [...skip] as ProcessStepName[] }));
          // 이미 처리한 단계를 바꾸면 그 단계부터 다시
          if (p.steps[s] !== 'pending') await ctx.repo.resetPageSteps(p.id, s);
        });
        skipBox.append(h('label', { class: 'check' }, cb, h('span', {}, STEP_LABELS[s])));
      }
      const notes = PROCESS_STEPS.filter((s) => p.notes?.[s]).map((s) => h('li', {}, `${STEP_LABELS[s]}: ${p.notes![s]}`));
      list.append(
        h(
          'div',
          { class: `page-row${p.fingerOverText || p.needsManual ? ' cap-warn' : ''}` },
          h('a', { class: 'page-thumb', href: `#/compare/${encodeURIComponent(bookId)}?page=${encodeURIComponent(p.id)}` }, img),
          h(
            'div',
            { class: 'page-info' },
            h('strong', {}, label),
            h('div', { class: 'chips' }, ...chips),
            p.fingerOverText ? h('p', { class: 'badge badge-warn' }, '손가락이 글자를 덮고 있습니다 — 다시 찍기를 권합니다') : null,
            p.needsManual ? h('p', { class: 'badge badge-warn' }, '책 외곽을 찾지 못했습니다 — 수동 보정하세요') : null,
            notes.length ? h('ul', { class: 'notes muted small' }, ...notes) : null,
            h(
              'div',
              { class: 'row-actions wrap' },
              h('button', { type: 'button', class: 'btn btn-small', onclick: () => ctx.go({ name: 'manual', pageId: p.id }) }, '수동 보정'),
              h('button', { type: 'button', class: 'btn btn-small', disabled: svc.state.running, onclick: () => void redo(p) }, '다시 처리'),
              p.fingerOverText ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => ctx.go({ name: 'scan', bookId, retake: p.captureId }) }, '다시 찍기') : null,
              skipBox,
            ),
          ),
        ),
      );
    }
  };

  const redo = async (p: Page) => {
    await ctx.repo.resetPageSteps(p.id, 'crop');
    void svc.start(bookId, { pageIds: [p.id], makePdf: false });
  };

  let ensured = false;
  const refresh = async () => {
    // ensurePages 는 처음 한 번만 (촬영이 바뀌면 처리 시작 때 runner 가 다시 맞춘다)
    pages = ensured ? await ctx.repo.listPages(bookId) : await ctx.repo.ensurePages(bookId);
    ensured = true;
    renderToggles();
    await renderControls();
    renderStatus();
    await renderPages();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 300);
  };
  const unsubRepo = ctx.repo.subscribe((e) => {
    if ('bookId' in e && e.bookId === bookId && e.type !== 'jobs') later();
  });
  const unsubSvc = svc.onChange(() => {
    renderStatus();
    void renderControls();
  });

  void (async () => {
    await refresh();
    // 새로고침 전에 처리 중이었으면 이어서 한다 (SPEC 5장 Phase 3: 중간에 새로고침해도 이어서 처리)
    const book = await ctx.repo.getBook(bookId);
    if (book?.processState === 'running' && !svc.state.running && pages.some(needsWork)) {
      toast('중단된 후처리를 이어서 합니다', 'info');
      void svc.start(bookId);
    }
  })();

  return () => {
    unsubRepo();
    unsubSvc();
    if (timer) clearTimeout(timer);
    urls.forEach((u) => URL.revokeObjectURL(u));
  };
};

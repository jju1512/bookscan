/**
 * 전후 비교 (SPEC 8장): 원본과 결과를 나란히 본다. 결과가 나쁜 페이지만 골라 다시 처리한다.
 * - 목록: 페이지마다 원본 썸네일 | 최종 결과, "다시 처리" 표시 → [표시한 페이지 다시 처리]
 * - 한 페이지(?page=): 원본 | 고른 단계 결과, 이전·다음, 단계를 골라 그 단계부터 다시, 수동 보정, OCR 텍스트
 */
import { finalImagePath } from '../../process/runner';
import { processService } from '../../process/service';
import { PROCESS_STEPS, type Page, type ProcessStepName } from '../../storage/types';
import type { Screen } from '../context';
import { clear, h } from '../dom';
import { toast } from '../ui';
import { STEP_LABELS } from './settings';

export const compareScreen: Screen = (ctx, route, root) => {
  if (route.name !== 'compare') return;
  const { bookId } = route;
  const svc = processService(ctx.repo);
  const body = h('div', {});
  root.append(
    h(
      'section',
      { class: 'page' },
      h('header', { class: 'page-head' }, h('a', { href: `#/process/${encodeURIComponent(bookId)}`, class: 'btn btn-quiet' }, '← 후처리'), h('h1', {}, '전후 비교')),
      body,
    ),
  );
  const urls: string[] = [];
  const img = async (path: string | null | undefined, alt: string) => {
    const el = h('img', { alt, loading: 'lazy' });
    const b = path ? await ctx.repo.files.read(path) : null;
    if (b) {
      const u = URL.createObjectURL(b);
      urls.push(u);
      el.src = u;
    }
    return el;
  };
  const freeUrls = () => urls.splice(0).forEach((u) => URL.revokeObjectURL(u));

  const renderList = async (pages: Page[]) => {
    const caps = new Map((await ctx.repo.listCaptures(bookId)).map((c, i) => [c.id, { c, n: i + 1 }]));
    const marked = new Set<string>();
    const redoBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true }, '표시한 페이지 다시 처리');
    const stepSel = h('select', { class: 'input input-inline', 'aria-label': '어느 단계부터' }, ...PROCESS_STEPS.map((s) => h('option', { value: s }, `${STEP_LABELS[s]}부터`)));
    redoBtn.addEventListener('click', async () => {
      if (svc.state.running) return toast('처리 중에는 다시 처리를 시작할 수 없습니다', 'error');
      for (const id of marked) await ctx.repo.resetPageSteps(id, stepSel.value as ProcessStepName);
      toast(`${marked.size}쪽을 다시 처리합니다`, 'ok');
      void svc.start(bookId, { pageIds: [...marked] });
      ctx.go({ name: 'process', bookId });
    });
    const grid = h('div', { class: 'cmp-grid' });
    body.append(h('div', { class: 'row-actions' }, stepSel, redoBtn), grid);
    for (const p of pages) {
      const cap = caps.get(p.captureId);
      const cb = h('input', { type: 'checkbox', 'aria-label': '다시 처리할 페이지로 표시' });
      cb.addEventListener('change', () => {
        if (cb.checked) marked.add(p.id);
        else marked.delete(p.id);
        redoBtn.disabled = marked.size === 0;
      });
      const label = `${cap?.n ?? '?'}${p.side === 'left' ? ' 왼쪽' : p.side === 'right' ? ' 오른쪽' : ''}`;
      grid.append(
        h(
          'div',
          { class: `cmp-card${p.fingerOverText || p.needsManual ? ' cap-warn' : ''}` },
          h(
            'a',
            { class: 'cmp-pair', href: `#/compare/${encodeURIComponent(bookId)}?page=${encodeURIComponent(p.id)}` },
            await img(cap?.c.thumb, '원본'),
            await img(finalImagePath(p), '결과'),
          ),
          h('label', { class: 'check' }, cb, h('span', {}, `${label} · 다시 처리`)),
        ),
      );
    }
  };

  const renderOne = async (pages: Page[], pageId: string) => {
    const i = pages.findIndex((p) => p.id === pageId);
    const p = pages[i];
    if (!p) {
      body.append(h('p', {}, '페이지를 찾을 수 없습니다.'));
      return;
    }
    const cap = await ctx.repo.getCapture(p.captureId);
    const avail = (['crop', 'finger', 'dewarp', 'enhance'] as const).filter((s) => p.files[s]);
    let shown: string | null = finalImagePath(p);
    const right = h('div', { class: 'cmp-side' });
    const showStep = async (path: string | null) => {
      shown = path;
      clear(right);
      right.append(h('h3', {}, '결과'), await img(shown, '결과'));
    };
    const tabs = h(
      'div',
      { class: 'row-actions wrap' },
      ...avail.map((s) => h('button', { type: 'button', class: 'btn btn-small', onclick: () => void showStep(p.files[s] ?? null) }, STEP_LABELS[s])),
    );
    const go = (j: number) => {
      const q = pages[j];
      if (q) ctx.go({ name: 'compare', bookId, pageId: q.id });
    };
    const fromSel = h('select', { class: 'input input-inline', 'aria-label': '어느 단계부터' }, ...PROCESS_STEPS.map((s) => h('option', { value: s }, `${STEP_LABELS[s]}부터`)));
    body.append(
      h(
        'div',
        { class: 'row-actions wrap' },
        h('button', { type: 'button', class: 'btn', disabled: i <= 0, onclick: () => go(i - 1) }, '← 이전'),
        h('span', {}, `${i + 1} / ${pages.length}`),
        h('button', { type: 'button', class: 'btn', disabled: i >= pages.length - 1, onclick: () => go(i + 1) }, '다음 →'),
        h('a', { class: 'btn', href: `#/compare/${encodeURIComponent(bookId)}` }, '전체 목록'),
      ),
      tabs,
      h('div', { class: 'cmp-split' }, h('div', { class: 'cmp-side' }, h('h3', {}, '원본'), await img(cap && (await ctx.repo.files.exists(cap.file)) ? cap.file : cap?.thumb, '원본')), right),
      h(
        'ul',
        { class: 'notes muted small' },
        ...PROCESS_STEPS.map((s) => h('li', {}, `${STEP_LABELS[s]}: ${p.steps[s]}${p.notes?.[s] ? ` — ${p.notes[s]}` : ''}`)),
      ),
      p.fingerOverText ? h('p', { class: 'badge badge-warn' }, '손가락이 글자를 덮고 있습니다 — 다시 찍기를 권합니다') : '',
      h(
        'div',
        { class: 'row-actions wrap' },
        fromSel,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            onclick: async () => {
              if (svc.state.running) return toast('처리 중입니다', 'error');
              await ctx.repo.resetPageSteps(p.id, fromSel.value as ProcessStepName);
              await svc.start(bookId, { pageIds: [p.id], makePdf: false });
              toast('다시 처리했습니다', 'ok');
              void render();
            },
          },
          '이 페이지 다시 처리',
        ),
        h('button', { type: 'button', class: 'btn', onclick: () => ctx.go({ name: 'manual', pageId: p.id }) }, '수동 보정'),
        h('button', { type: 'button', class: 'btn', onclick: () => ctx.go({ name: 'scan', bookId, retake: p.captureId }) }, '다시 찍기'),
      ),
      p.ocr?.text ? h('details', { class: 'ocr-text' }, h('summary', {}, `OCR 텍스트 (${p.ocr.words.length}단어)`), h('pre', {}, p.ocr.text)) : '',
    );
    await showStep(shown);
  };

  const render = async () => {
    freeUrls();
    clear(body);
    const pages = await ctx.repo.listPages(bookId);
    if (pages.length === 0) {
      body.append(h('p', {}, '아직 후처리한 페이지가 없습니다.'));
      return;
    }
    if (route.pageId) await renderOne(pages, route.pageId);
    else await renderList(pages);
  };
  void render();
  return () => freeUrls();
};

/**
 * /debug/compare/ — 후처리 비교 페이지 (SPEC 8장 "품질 비교 방법").
 * 같은 샘플 세트를 지금 구현으로 단계별로 처리해 한 화면에 모아 본다. 구현을 바꿀 때마다 열어 비교한다.
 * 출처: ① 내장 합성 샘플(vendor/samples) ② 직접 고른 이미지 ③ 이 기기의 책(저장된 단계 결과를 그대로 보여 줌)
 * 이미지는 기기 밖으로 나가지 않는다.
 */
import '../app/styles.css';
import { h, clear } from '../app/dom';
import { getParams, initParams } from '../config';
import { getSettings, initSettings } from '../config/settings';
import { WorkerExecutor } from '../process/client';
import { TesseractEngine } from '../process/ocr/ocr';
import type { ImageStepName } from '../process/steps';
import { openStorage } from '../storage';
import { PROCESS_STEPS } from '../storage/types';

initParams();
initSettings();

const STEPS: ImageStepName[] = ['crop', 'finger', 'dewarp', 'enhance'];
const LABEL: Record<string, string> = { input: '입력', crop: '자르기·분할', finger: '손가락', dewarp: '펴기', enhance: '보정', ocr: 'OCR' };
const base = import.meta.env.BASE_URL;

const app = document.getElementById('app')!;
const table = h('div', { class: 'dbg-cmp' });
const status = h('p', { class: 'muted' });
const ocrBox = h('input', { type: 'checkbox' });
const modeSel = h('select', { class: 'input input-inline' }, h('option', { value: 'auto' }, '촬영 단위: 이름으로 (spread-*)'), h('option', { value: 'spread' }, '양쪽 펼침'), h('option', { value: 'single' }, '한 페이지'));
const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true });
const bookSel = h('select', { class: 'input input-inline' }, h('option', { value: '' }, '이 기기의 책 고르기…'));
app.append(
  h(
    'section',
    { class: 'page' },
    h('header', { class: 'page-head' }, h('h1', {}, '후처리 비교'), h('a', { class: 'btn btn-quiet', href: `${base}` }, '앱으로')),
    h('p', { class: 'muted small' }, `지금 구현(오픈소스 단계)으로 처리한 단계별 결과를 모아 봅니다. 긴 변 최대 ${getParams().PROCESS_MAX_EDGE}px, 흑백 보정 ${getSettings().enhanceBinarize ? '켬' : '끔'}. 사용자 샘플은 tests/fixtures/ 에 넣고 "이미지 고르기"로 엽니다.`),
    h(
      'div',
      { class: 'row-actions wrap' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void runSamples() }, '내장 샘플 처리'),
      fileInput,
      modeSel,
      h('label', { class: 'check' }, ocrBox, h('span', {}, 'OCR 도 (느림)')),
      bookSel,
    ),
    status,
    table,
  ),
);

let exec: WorkerExecutor | null = null;
let ocr: TesseractEngine | null = null;

function cell(blob: Blob | null, caption: string): HTMLElement {
  const box = h('figure', { class: 'dbg-cmp-cell' });
  if (blob) {
    const u = URL.createObjectURL(blob);
    box.append(h('a', { href: u, target: '_blank' }, h('img', { src: u, alt: caption, loading: 'lazy' })));
  } else box.append(h('div', { class: 'dbg-cmp-empty' }, '(바뀌지 않음)'));
  box.append(h('figcaption', {}, caption));
  return box;
}

async function processOne(name: string, blob: Blob, side: 'left' | 'right' | 'single') {
  exec ??= new WorkerExecutor();
  const row = h('div', { class: 'dbg-cmp-row' }, h('h3', {}, `${name}${side === 'single' ? '' : ` · ${side === 'left' ? '왼쪽' : '오른쪽'}`}`));
  const cells = h('div', { class: 'dbg-cmp-cells' }, cell(blob, LABEL.input!));
  row.append(cells);
  table.append(row);
  let cur = blob;
  for (const step of STEPS) {
    try {
      const r = await exec.runImageStep(step, cur, { bookId: 'debug', pageId: name, side, binarize: getSettings().enhanceBinarize }, getParams().PROCESS_MAX_EDGE);
      const o = r.meta.outcome;
      cells.append(cell(r.image, `${LABEL[step]} · ${o?.state ?? 'done'} · ${Math.round(r.ms)}ms${o?.note ? ` · ${o.note}` : ''}`));
      if (r.image) cur = r.image;
    } catch (e) {
      cells.append(cell(null, `${LABEL[step]} · 오류: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (ocrBox.checked) {
    ocr ??= new TesseractEngine();
    const t0 = performance.now();
    try {
      const r = await ocr.recognize(cur);
      row.append(h('details', { open: true }, h('summary', {}, `OCR · ${r.words.length}단어 · 신뢰도 ${Math.round(r.confidence)} · ${Math.round(performance.now() - t0)}ms`), h('pre', {}, r.text)));
    } catch (e) {
      row.append(h('p', {}, `OCR 오류: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

function sidesFor(name: string): ('left' | 'right' | 'single')[] {
  const m = modeSel.value;
  const spread = m === 'spread' || (m === 'auto' && name.startsWith('spread'));
  return spread ? ['left', 'right'] : ['single'];
}

async function runSet(items: { name: string; blob: Blob }[]) {
  clear(table);
  const t0 = performance.now();
  let n = 0;
  const total = items.reduce((s, it) => s + sidesFor(it.name).length, 0);
  for (const it of items) {
    for (const side of sidesFor(it.name)) {
      status.textContent = `처리 중… ${++n}/${total} (${it.name})`;
      await processOne(it.name, it.blob, side);
    }
  }
  status.textContent = `${total}쪽 처리 · ${Math.round((performance.now() - t0) / 1000)}초`;
}

async function runSamples() {
  status.textContent = '샘플 목록을 받는 중…';
  const list = (await (await fetch(`${base}vendor/samples/index.json`)).json()) as string[];
  const items = [];
  for (const name of list) items.push({ name: name.replace(/\.png$/, ''), blob: await (await fetch(`${base}vendor/samples/${name}`)).blob() });
  await runSet(items);
}

fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  if (files.length) void runSet(files.map((f) => ({ name: f.name, blob: f })));
});

// 이 기기의 책: 저장된 단계 결과를 그대로 보여 준다 (다시 처리하지 않는다)
void (async () => {
  try {
    const { repo } = await openStorage();
    for (const b of await repo.listBooks()) bookSel.append(h('option', { value: b.id }, b.title));
    bookSel.addEventListener('change', async () => {
      if (!bookSel.value) return;
      clear(table);
      const caps = new Map((await repo.listCaptures(bookSel.value)).map((c) => [c.id, c]));
      for (const p of await repo.listPages(bookSel.value)) {
        const cap = caps.get(p.captureId);
        const cells = h('div', { class: 'dbg-cmp-cells' }, cell(cap ? await repo.files.read(cap.thumb) : null, '원본(썸네일)'));
        for (const s of STEPS) cells.append(cell(p.files[s] ? await repo.files.read(p.files[s]!) : null, `${LABEL[s]} · ${p.steps[s]}${p.notes?.[s] ? ` · ${p.notes[s]}` : ''}${p.durations?.[s] ? ` · ${Math.round(p.durations[s]!)}ms` : ''}`));
        table.append(h('div', { class: 'dbg-cmp-row' }, h('h3', {}, `${p.order}쪽 (${p.side})`), cells, p.ocr?.text ? h('details', {}, h('summary', {}, `OCR ${PROCESS_STEPS.includes('ocr') ? p.steps.ocr : ''}`), h('pre', {}, p.ocr.text)) : ''));
      }
    });
  } catch {
    bookSel.disabled = true;
  }
})();

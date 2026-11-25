/**
 * 디버그 패널 틀 (Phase 0).
 *
 * 지금 있는 것: 환경 정보, 카메라가 실제로 준 해상도, 파라미터 편집·저장, 로그 보기·내보내기.
 * Phase 1 에서 채울 자리: motion/change/sharpness 실시간 그래프, 상태 머신 상태와 전환 로그, 세션 녹화.
 */
import { append, clear, h } from '../app/dom';
import { cameraRows, type CameraSnapshot, type InfoRow } from '../camera/info';
import {
  GROUP_LABELS,
  PARAM_DEFS,
  PARAM_KEYS,
  fromDisplay,
  getParams,
  onParamsChange,
  resetAllParams,
  setParams,
  toDisplay,
  unitSuffix,
  type ParamGroup,
  type ParamKey,
} from '../config';
import { formatEntry, log, type LogEntry } from './log';

export interface DebugPanel {
  el: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  setCamera(snapshot: CameraSnapshot | null): void;
  setEnv(rows: InfoRow[]): void;
}

export function createDebugPanel(): DebugPanel {
  const envBody = h('tbody');
  const camBody = h('tbody');
  const logList = h('ol', { class: 'dbg-log', 'aria-live': 'off' });
  const paramStatus = h('span', { class: 'dbg-status' });

  const inputs = new Map<ParamKey, HTMLInputElement>();
  const paramSection = h('section', { class: 'dbg-section' }, h('h3', {}, '파라미터'));
  for (const group of Object.keys(GROUP_LABELS) as ParamGroup[]) {
    const tbody = h('tbody');
    for (const key of PARAM_KEYS.filter((k) => PARAM_DEFS[k].group === group)) {
      const def = PARAM_DEFS[key];
      const input = h('input', {
        type: 'number',
        inputmode: 'decimal',
        id: `param-${key}`,
        step: String(toDisplay(key, def.step)),
        min: String(toDisplay(key, def.min)),
        max: String(toDisplay(key, def.max)),
      });
      inputs.set(key, input);
      tbody.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, h('label', { for: `param-${key}` }, key), h('small', {}, def.help)),
          h('td', {}, input, h('span', { class: 'dbg-unit' }, unitSuffix(key))),
        ),
      );
    }
    paramSection.append(h('h4', {}, GROUP_LABELS[group]), h('table', { class: 'dbg-table' }, tbody));
  }

  const fillInputs = () => {
    const p = getParams();
    for (const [key, input] of inputs) input.value = String(toDisplay(key, p[key]));
  };

  const saveBtn = h('button', {
    type: 'button',
    class: 'btn',
    onclick: () => {
      const next: Partial<Record<ParamKey, number>> = {};
      for (const [key, input] of inputs) {
        const v = input.valueAsNumber;
        if (Number.isFinite(v)) next[key] = fromDisplay(key, v);
      }
      const ok = setParams(next);
      paramStatus.textContent = ok ? '저장했습니다' : '저장소를 쓸 수 없어 이번 세션에만 적용됩니다';
      log.info('파라미터 저장', next);
    },
  }, '저장');
  const resetBtn = h('button', {
    type: 'button',
    class: 'btn btn-quiet',
    onclick: () => {
      resetAllParams();
      paramStatus.textContent = '기본값으로 되돌렸습니다';
      log.info('파라미터 기본값 복원');
    },
  }, '기본값으로');
  paramSection.append(
    h('p', { class: 'dbg-note' }, '카메라 값은 카메라를 다시 켜면 적용됩니다.'),
    h('div', { class: 'dbg-actions' }, saveBtn, resetBtn, paramStatus),
  );
  onParamsChange(fillInputs);
  fillInputs();

  const renderLogEntry = (e: LogEntry) => {
    logList.append(h('li', { class: `lvl-${e.level}` }, formatEntry(e)));
    while (logList.childElementCount > 200) logList.firstElementChild?.remove();
  };
  log.all().forEach(renderLogEntry);
  log.subscribe(renderLogEntry);

  const closeBtn = h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': '디버그 패널 닫기', onclick: () => api.close() }, '닫기');

  const el = h(
    'aside',
    { class: 'debug-panel', 'aria-label': '디버그 패널', hidden: true },
    h('header', { class: 'dbg-header' }, h('h2', {}, '디버그'), closeBtn),
    h('section', { class: 'dbg-section' }, h('h3', {}, '환경'), h('table', { class: 'dbg-table' }, envBody)),
    h('section', { class: 'dbg-section' }, h('h3', {}, '카메라'), h('table', { class: 'dbg-table' }, camBody)),
    h(
      'section',
      { class: 'dbg-section' },
      h('h3', {}, '자동 촬영'),
      h('p', { class: 'dbg-note' }, 'Phase 1에서 연결: 현재 상태, 상태 전환 로그, motion · change · sharpness 실시간 그래프, 세션 녹화.'),
      h('canvas', { class: 'dbg-graph', width: 600, height: 120, 'aria-label': '분석 값 그래프 (Phase 1)' }),
    ),
    paramSection,
    h(
      'section',
      { class: 'dbg-section' },
      h('h3', {}, '로그'),
      h(
        'div',
        { class: 'dbg-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => downloadText(`bookscan-log-${Date.now()}.txt`, log.toText()) }, '내보내기'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { log.clear(); clear(logList); } }, '지우기'),
      ),
      logList,
    ),
  );

  const renderRows = (tbody: HTMLElement, rows: InfoRow[]) => {
    clear(tbody);
    for (const r of rows) append(tbody, h('tr', {}, h('th', { scope: 'row' }, r.name), h('td', {}, r.value)));
  };

  const api: DebugPanel = {
    el,
    isOpen: () => !el.hidden,
    open: () => {
      el.hidden = false;
    },
    close: () => {
      el.hidden = true;
    },
    toggle: () => {
      el.hidden = !el.hidden;
    },
    setCamera: (snap) => renderRows(camBody, snap ? cameraRows(snap) : [{ name: '상태', value: '카메라 꺼짐' }]),
    setEnv: (rows) => renderRows(envBody, rows),
  };
  api.setCamera(null);
  return api;
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

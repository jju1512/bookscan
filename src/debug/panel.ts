/**
 * 디버그 패널 (SPEC 6장 "디버그 패널과 튜닝 도구").
 *
 * 환경 정보, 카메라가 실제로 준 해상도, motion/change/sharpness 실시간 그래프와 상태·전환 로그,
 * 세션 녹화(MediaRecorder)와 녹화 영상으로 상태 머신 재생, 파라미터 편집·저장, 로그 보기·내보내기.
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
import { drawGraph, type GraphSample } from './graph';
import { SessionRecorder } from './recorder';
import type { Transition } from '../capture/machine';
import type { ReplayResult } from '../capture/replay';

export interface DebugPanel {
  el: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  setCamera(snapshot: CameraSnapshot | null): void;
  setEnv(rows: InfoRow[]): void;
  capture: CaptureDebug;
}

export interface CaptureDebug {
  sample(s: GraphSample & { ms?: number }): void;
  transition(t: Transition): void;
  /** 녹화할 미리보기. 촬영 화면을 떠나면 null */
  setVideo(video: HTMLVideoElement | null): void;
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

  const capture = createCaptureSection(() => !el.hidden);

  const closeBtn = h('button', { type: 'button', class: 'btn btn-quiet', 'aria-label': '디버그 패널 닫기', onclick: () => api.close() }, '닫기');

  const el = h(
    'aside',
    { class: 'debug-panel', 'aria-label': '디버그 패널', hidden: true },
    h('header', { class: 'dbg-header' }, h('h2', {}, '디버그'), closeBtn),
    h('section', { class: 'dbg-section' }, h('h3', {}, '환경'), h('table', { class: 'dbg-table' }, envBody)),
    h('section', { class: 'dbg-section' }, h('h3', {}, '카메라'), h('table', { class: 'dbg-table' }, camBody)),
    capture.el,
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
    capture: capture.api,
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

/** 자동 촬영 디버그: 현재 값, 그래프, 전환 로그, 세션 녹화, 녹화 재생 */
function createCaptureSection(isOpen: () => boolean): { el: HTMLElement; api: CaptureDebug } {
  const samples: GraphSample[] = [];
  const now = h('div', { class: 'dbg-now' }, '촬영 화면에서 값이 나옵니다');
  const canvas = h('canvas', { class: 'dbg-graph', 'aria-label': 'motion · change · sharpness 그래프' });
  const transList = h('ol', { class: 'dbg-log dbg-trans' });
  let raf = 0;
  let pendingShot = false;
  const redraw = () => {
    raf = 0;
    if (isOpen()) drawGraph(canvas, samples, getParams());
  };

  // ── 녹화 ──
  const recorder = new SessionRecorder();
  let video: HTMLVideoElement | null = null;
  let lastRecording: Blob | null = null;
  const recStatus = h('span', { class: 'dbg-status' });
  const recBtn = h('button', { type: 'button', class: 'btn', disabled: true }, '녹화 시작');
  const useLastBtn = h('button', { type: 'button', class: 'btn', disabled: true }, '방금 녹화로');
  const toggleRecording = async () => {
    try {
      if (recorder.recording) {
        const blob = await recorder.stop();
        recBtn.textContent = '녹화 시작';
        recBtn.disabled = !video;
        if (blob) {
          lastRecording = blob;
          useLastBtn.disabled = false;
          recStatus.textContent = `녹화 ${Math.round(blob.size / 1024)}KB — 내려받았습니다`;
          downloadBlobFile(`bookscan-session-${Date.now()}.webm`, blob);
        }
      } else if (video) {
        recorder.start(video);
        recBtn.textContent = '녹화 중지';
        recStatus.textContent = '녹화 중…';
      }
    } catch (e) {
      recStatus.textContent = e instanceof Error ? e.message : String(e);
      log.error('녹화 실패', e);
    }
  };
  recBtn.addEventListener('click', () => void toggleRecording());

  // ── 재생 ──
  const replayOut = h('div', { class: 'dbg-replay' });
  const rateSel = h('select', { 'aria-label': '재생 속도' }, h('option', { value: '1' }, '1×'), h('option', { value: '2' }, '2×'), h('option', { value: '4' }, '4×'));
  const fileInput = h('input', { type: 'file', accept: 'video/*', 'aria-label': '녹화 영상 고르기' });
  const runs: { label: string; result: ReplayResult }[] = [];
  const renderRuns = () => {
    clear(replayOut);
    runs.forEach((r, i) => {
      replayOut.append(
        h(
          'div',
          { class: 'dbg-run' },
          h('strong', {}, `${i === 0 ? '이번' : `${i}번 전`}: ${r.result.captures.length}장 촬영`),
          h('small', {}, r.label),
          h('small', {}, `촬영 시점(초): ${r.result.captures.map((c) => (c.t / 1000).toFixed(1)).join(', ') || '없음'}`),
        ),
      );
    });
  };
  const runReplay = async (blob: Blob) => {
    const { replayVideo } = await import('../capture/replay');
    const p = getParams();
    const progress = h('p', { class: 'dbg-note' }, '재생 분석 중…');
    replayOut.prepend(progress);
    try {
      const result = await replayVideo(blob, p, {
        rate: Number(rateSel.value),
        onProgress: (t, d) => (progress.textContent = `재생 분석 중… ${(t / 1000).toFixed(1)}s${d && Number.isFinite(d) ? ` / ${(d / 1000).toFixed(1)}s` : ''}`),
      });
      const label = `STILL ${(p.STILL * 100).toFixed(2)}% · MOVE ${(p.MOVE * 100).toFixed(1)}% · MOVE_MS ${p.MOVE_MS} · STABLE_MS ${p.STABLE_MS} · CHANGE_MIN ${(p.CHANGE_MIN * 100).toFixed(1)}% · PIXEL_DIFF ${p.PIXEL_DIFF} · SHARP_RATIO ${p.SHARP_RATIO} · MIN_INTERVAL_MS ${p.MIN_INTERVAL_MS}`;
      runs.unshift({ label, result });
      runs.splice(5);
      progress.remove();
      renderRuns();
      samples.splice(0, samples.length, ...result.samples.map((s) => ({ ...s })));
      redraw();
      log.info(`녹화 재생: ${result.captures.length}장`, { label });
    } catch (e) {
      progress.textContent = `재생 실패: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void runReplay(f);
  });
  useLastBtn.addEventListener('click', () => {
    if (lastRecording) void runReplay(lastRecording);
  });

  const el = h(
    'section',
    { class: 'dbg-section' },
    h('h3', {}, '자동 촬영'),
    now,
    canvas,
    h('h4', {}, '상태 전환'),
    transList,
    h('h4', {}, '세션 녹화'),
    h('p', { class: 'dbg-note' }, '미리보기를 640px 로 녹화해 webm 으로 내려받습니다. PC 에서 아래 "녹화 재생"으로 파라미터별 촬영 시점을 비교할 수 있습니다.'),
    h('div', { class: 'dbg-actions' }, recBtn, recStatus),
    h('h4', {}, '녹화 재생'),
    h('p', { class: 'dbg-note' }, '지금 파라미터로 영상을 처음부터 재생하며 상태 머신을 돌립니다. 파라미터를 바꿔 다시 돌리면 결과가 위에 쌓여 비교됩니다.'),
    h('div', { class: 'dbg-actions' }, fileInput, useLastBtn, rateSel),
    replayOut,
  );

  const api: CaptureDebug = {
    sample(s) {
      samples.push({ ...s, shot: pendingShot || s.shot });
      pendingShot = false;
      const cutoff = s.t - 15_000;
      while (samples.length && samples[0]!.t < cutoff) samples.shift();
      if (isOpen()) {
        now.textContent = `상태 ${s.state} · motion ${(s.motion * 100).toFixed(2)}% · change ${(s.change * 100).toFixed(1)}% · sharpness ${Math.round(s.sharpness)}${s.ms !== undefined ? ` · 분석 ${s.ms.toFixed(1)}ms` : ''}`;
        if (!raf) raf = requestAnimationFrame(redraw);
      }
    },
    transition(t) {
      if (t.to === 'CAPTURE') pendingShot = true;
      transList.append(h('li', {}, `${(t.t / 1000).toFixed(2)}s ${t.from} → ${t.to} (${t.reason})`));
      while (transList.childElementCount > 60) transList.firstElementChild?.remove();
      transList.scrollTop = transList.scrollHeight;
    },
    setVideo(v) {
      video = v;
      if (!v && recorder.recording) void toggleRecording();
      recBtn.disabled = !v && !recorder.recording;
    },
  };
  return { el, api };
}

function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

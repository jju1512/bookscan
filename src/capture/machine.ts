/**
 * 자동 촬영 상태 머신 (SPEC 6장 표). 카메라·화면과 분리된 순수 함수다.
 *
 * 입력: (시각, motion, change, sharpness)  출력: (다음 상태, 촬영 여부)
 * CAPTURE 상태에서는 바깥(촬영·저장 담당)이 captured() / captureFailed() 로 결과를 알려 준다.
 *
 * | 상태        | 다음 상태로 가는 조건 |
 * | WAIT_STABLE | motion < STILL 이 STABLE_MS 동안 → CHECK |
 * | CHECK       | 선명도 미달 → WAIT_STABLE. 첫 장이거나 change ≥ CHANGE_MIN → CAPTURE. 같은 장면 → ARMED |
 * | CAPTURE     | 저장이 끝나면 ARMED |
 * | ARMED       | motion > MOVE 가 MOVE_MS 이상 → TURNING |
 * | TURNING     | motion < STILL 이 STABLE_MS 동안 + 마지막 촬영에서 MIN_INTERVAL_MS 지남 → CHECK |
 * | PAUSED      | 재개하면 WAIT_STABLE |
 */
import type { Params } from '../config/params';

export type CaptureStateName = 'WAIT_STABLE' | 'CHECK' | 'CAPTURE' | 'ARMED' | 'TURNING' | 'PAUSED';

export type MachineParams = Pick<
  Params,
  'STILL' | 'MOVE' | 'MOVE_MS' | 'STABLE_MS' | 'CHANGE_MIN' | 'SHARP_RATIO' | 'MIN_INTERVAL_MS'
>;

export interface FrameInput {
  t: number;
  motion: number;
  change: number;
  sharpness: number;
}

export interface MachineState {
  name: CaptureStateName;
  /** motion < STILL 이 시작된 시각 */
  stillSince: number | null;
  /** motion > MOVE 가 시작된 시각 */
  moveSince: number | null;
  lastCaptureAt: number | null;
  /** 이번 세션 촬영 수 */
  captures: number;
  /** 기준 프레임이 없으면 true → 다음 CHECK 는 "첫 장"으로 보고 change 없이 찍는다 */
  firstShot: boolean;
  /** 최근 촬영들의 선명도 (중앙값 계산용) */
  sharpHistory: number[];
  /** PAUSED 로 가기 전 상태 (로그용) */
  pausedFrom?: CaptureStateName;
}

export interface Transition {
  t: number;
  from: CaptureStateName;
  to: CaptureStateName;
  reason: string;
}

export interface StepResult {
  state: MachineState;
  capture: boolean;
  transitions: Transition[];
}

/** 선명도 중앙값에 쓰는 최근 촬영 수 */
export const SHARP_HISTORY = 9;

export function initialState(opts: { hasReference?: boolean; sharpHistory?: number[] } = {}): MachineState {
  return {
    name: 'WAIT_STABLE',
    stillSince: null,
    moveSince: null,
    lastCaptureAt: null,
    captures: 0,
    firstShot: !opts.hasReference,
    sharpHistory: (opts.sharpHistory ?? []).slice(-SHARP_HISTORY),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 선명도 통과 여부. 기록이 없으면 비교할 대상이 없으므로 통과 */
export function sharpEnough(sharpness: number, history: readonly number[], ratio: number): boolean {
  if (history.length === 0) return true;
  return sharpness >= ratio * median(history);
}

function go(state: MachineState, to: CaptureStateName, t: number, reason: string, out: Transition[]): MachineState {
  out.push({ t, from: state.name, to, reason });
  return { ...state, name: to };
}

/** 분석 프레임 하나를 먹인다 */
export function step(state: MachineState, input: FrameInput, p: MachineParams): StepResult {
  const transitions: Transition[] = [];
  const { t, motion } = input;
  let s = state;
  let capture = false;

  switch (s.name) {
    case 'PAUSED':
    case 'CAPTURE':
      // 일시정지 중이거나 촬영·저장 결과를 기다린다. 프레임은 무시한다.
      break;

    case 'WAIT_STABLE':
    case 'TURNING': {
      if (motion < p.STILL) {
        const since = s.stillSince ?? t;
        s = { ...s, stillSince: since };
        const stable = t - since >= p.STABLE_MS;
        const intervalOk = s.name === 'WAIT_STABLE' || s.lastCaptureAt === null || t - s.lastCaptureAt >= p.MIN_INTERVAL_MS;
        if (stable && intervalOk) {
          s = go(s, 'CHECK', t, s.name === 'TURNING' ? '넘김 후 멈춤' : '안정됨', transitions);
          const r = check(s, input, p, transitions);
          s = r.state;
          capture = r.capture;
        }
      } else {
        s = { ...s, stillSince: null };
      }
      break;
    }

    case 'ARMED': {
      if (motion > p.MOVE) {
        const since = s.moveSince ?? t;
        s = { ...s, moveSince: since };
        if (t - since >= p.MOVE_MS) {
          s = go({ ...s, stillSince: null, moveSince: null }, 'TURNING', t, '넘김 감지', transitions);
        }
      } else {
        s = { ...s, moveSince: null };
      }
      break;
    }

    case 'CHECK': {
      // CHECK 는 들어온 프레임에서 바로 판정하므로 보통 여기 머물지 않는다.
      const r = check(s, input, p, transitions);
      s = r.state;
      capture = r.capture;
      break;
    }
  }
  return { state: s, capture, transitions };
}

function check(s: MachineState, input: FrameInput, p: MachineParams, out: Transition[]): { state: MachineState; capture: boolean } {
  const { t } = input;
  if (!sharpEnough(input.sharpness, s.sharpHistory, p.SHARP_RATIO)) {
    // 흐린 사진: 촬영을 취소하고 다시 안정되기를 기다린다
    return { state: go({ ...s, stillSince: t, moveSince: null }, 'WAIT_STABLE', t, '선명도 미달', out), capture: false };
  }
  if (s.firstShot || input.change >= p.CHANGE_MIN) {
    return { state: go({ ...s, stillSince: null, moveSince: null }, 'CAPTURE', t, s.firstShot ? '첫 장' : '새 페이지', out), capture: true };
  }
  return { state: go({ ...s, stillSince: null, moveSince: null }, 'ARMED', t, '같은 장면', out), capture: false };
}

/** 수동 촬영 (화면 탭): 어느 상태에서나 즉시 CAPTURE. PAUSED 에서도 찍는다 */
export function manualCapture(state: MachineState, t: number): StepResult {
  const transitions: Transition[] = [];
  if (state.name === 'CAPTURE') return { state, capture: false, transitions };
  const s = go({ ...state, stillSince: null, moveSince: null, pausedFrom: state.name === 'PAUSED' ? state.pausedFrom : undefined }, 'CAPTURE', t, '수동 촬영', transitions);
  return { state: s, capture: true, transitions };
}

/** 촬영·저장이 끝났다 → ARMED. 기준 프레임 갱신은 분석기가 한다 */
export function captured(state: MachineState, t: number, sharpness: number, opts: { wasPaused?: boolean } = {}): StepResult {
  const transitions: Transition[] = [];
  const base: MachineState = {
    ...state,
    lastCaptureAt: t,
    captures: state.captures + 1,
    firstShot: false,
    sharpHistory: [...state.sharpHistory, sharpness].slice(-SHARP_HISTORY),
    stillSince: null,
    moveSince: null,
  };
  const to: CaptureStateName = opts.wasPaused ? 'PAUSED' : 'ARMED';
  return { state: go(base, to, t, '저장 완료', transitions), capture: false, transitions };
}

/** 촬영이나 저장에 실패했다 → WAIT_STABLE (같은 장면을 다시 찍을 수 있게) */
export function captureFailed(state: MachineState, t: number): StepResult {
  const transitions: Transition[] = [];
  return { state: go({ ...state, stillSince: null, moveSince: null }, 'WAIT_STABLE', t, '촬영 실패', transitions), capture: false, transitions };
}

export function pause(state: MachineState, t: number, reason = '일시정지'): StepResult {
  const transitions: Transition[] = [];
  if (state.name === 'PAUSED') return { state, capture: false, transitions };
  const s = go({ ...state, pausedFrom: state.name, stillSince: null, moveSince: null }, 'PAUSED', t, reason, transitions);
  return { state: s, capture: false, transitions };
}

export function resume(state: MachineState, t: number): StepResult {
  const transitions: Transition[] = [];
  if (state.name !== 'PAUSED') return { state, capture: false, transitions };
  const s = go({ ...state, pausedFrom: undefined, stillSince: null, moveSince: null }, 'WAIT_STABLE', t, '재개', transitions);
  return { state: s, capture: false, transitions };
}

/** 화면 표시용 상태 이름 (대기 / 넘김 감지 / 촬영) */
export function stateLabel(name: CaptureStateName): string {
  switch (name) {
    case 'WAIT_STABLE': return '대기 · 안정되기를 기다림';
    case 'CHECK': return '확인 중';
    case 'CAPTURE': return '촬영';
    case 'ARMED': return '대기 · 페이지를 넘기세요';
    case 'TURNING': return '넘김 감지';
    case 'PAUSED': return '일시정지';
  }
}

// ── 시퀀스 실행 (단위 테스트·녹화 재생 공용) ─────────────────────

export interface SimCapture {
  /** 촬영 결정 시각 */
  t: number;
  /** 결정 당시 입력 */
  input: FrameInput;
  /** 결정이 난 프레임 번호 */
  index: number;
}

/**
 * 입력 시퀀스를 끝까지 돌려 촬영 시점을 모은다. 촬영·저장은 latencyMs 뒤에 끝난다고 본다.
 * onCapture 는 촬영 결정 직후 불린다 (녹화 재생에서 기준 프레임을 바꿀 때 쓴다).
 */
export function simulate(
  inputs: readonly FrameInput[],
  p: MachineParams,
  opts: { latencyMs?: number; initial?: MachineState; onCapture?: (c: SimCapture) => void } = {},
): { captures: SimCapture[]; transitions: Transition[]; final: MachineState } {
  const latency = opts.latencyMs ?? 300;
  let s = opts.initial ?? initialState();
  const captures: SimCapture[] = [];
  const transitions: Transition[] = [];
  let pending: { doneAt: number; sharpness: number } | null = null;
  inputs.forEach((input, index) => {
    if (pending && input.t >= pending.doneAt) {
      const r = captured(s, pending.doneAt, pending.sharpness);
      s = r.state;
      transitions.push(...r.transitions);
      pending = null;
    }
    const r = step(s, input, p);
    s = r.state;
    transitions.push(...r.transitions);
    if (r.capture) {
      const c = { t: input.t, input, index };
      captures.push(c);
      opts.onCapture?.(c);
      pending = { doneAt: input.t + latency, sharpness: input.sharpness };
    }
  });
  return { captures, transitions, final: s };
}

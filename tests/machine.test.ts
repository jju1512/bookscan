import { describe, expect, it } from 'vitest';
import { defaultParams } from '../src/config/params';
import {
  captured,
  captureFailed,
  initialState,
  manualCapture,
  median,
  pause,
  resume,
  sharpEnough,
  simulate,
  step,
  type FrameInput,
  type MachineState,
} from '../src/capture/machine';

const P = defaultParams();
const FPS = 12;
const DT = 1000 / FPS;

/**
 * 장면 대본: 구간마다 motion·장면 번호·선명도를 정한다.
 * change 는 "지금 장면이 마지막 촬영 장면과 다른가"로 정해진다 (실제 분석기와 같은 뜻).
 */
interface Segment {
  ms: number;
  motion: number;
  scene: number;
  sharp?: number;
  /** 같은 장면이라도 일부가 다르면 (손이 들어와 멈춤 등) */
  partialChange?: number;
}

function run(segments: Segment[], opts: { latencyMs?: number; initial?: MachineState } = {}) {
  const latency = opts.latencyMs ?? 300;
  let s = opts.initial ?? initialState();
  let t = 0;
  let refScene: number | null = null;
  let pending: { at: number; sharp: number } | null = null;
  const shots: { t: number; scene: number }[] = [];
  for (const seg of segments) {
    const end = t + seg.ms;
    for (; t < end; t += DT) {
      if (pending && t >= pending.at) {
        s = captured(s, pending.at, pending.sharp).state;
        pending = null;
      }
      const change = refScene === null ? 1 : refScene !== seg.scene ? 0.3 : seg.partialChange ?? 0.01;
      const input: FrameInput = { t, motion: seg.motion, change, sharpness: seg.sharp ?? 100 };
      const r = step(s, input, P);
      s = r.state;
      if (r.capture) {
        shots.push({ t, scene: seg.scene });
        refScene = seg.scene;
        pending = { at: t + latency, sharp: input.sharpness };
      }
    }
  }
  return { shots, final: s };
}

/** 페이지 n장을 차례로 넘기는 대본 */
function turns(pages: number, opts: { stillMs?: number; turnMs?: number; turnMotion?: number } = {}): Segment[] {
  const still = opts.stillMs ?? 1500;
  const turn = opts.turnMs ?? 700;
  const segs: Segment[] = [{ ms: still, motion: 0.001, scene: 0 }];
  for (let i = 1; i < pages; i++) {
    segs.push({ ms: turn, motion: opts.turnMotion ?? 0.2, scene: i });
    segs.push({ ms: still, motion: 0.001, scene: i });
  }
  return segs;
}

describe('보조 함수', () => {
  it('중앙값', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
  it('선명도: 기록이 없으면 통과, 중앙값×비율 미만이면 미달', () => {
    expect(sharpEnough(1, [], 0.8)).toBe(true);
    expect(sharpEnough(80, [100, 100, 100], 0.8)).toBe(true);
    expect(sharpEnough(79, [100, 100, 100], 0.8)).toBe(false);
  });
});

describe('상태 전환 (SPEC 6장 표)', () => {
  it('WAIT_STABLE: motion < STILL 이 STABLE_MS 이어지면 CHECK → 첫 장이라 CAPTURE', () => {
    let s = initialState();
    let r = step(s, { t: 0, motion: 0, change: 1, sharpness: 50 }, P);
    expect(r.state.name).toBe('WAIT_STABLE');
    r = step(r.state, { t: 399, motion: 0, change: 1, sharpness: 50 }, P);
    expect(r.capture).toBe(false);
    r = step(r.state, { t: 400, motion: 0, change: 1, sharpness: 50 }, P);
    expect(r.capture).toBe(true);
    expect(r.state.name).toBe('CAPTURE');
    expect(r.transitions.map((x) => x.to)).toEqual(['CHECK', 'CAPTURE']);
    s = captured(r.state, 600, 50).state;
    expect(s.name).toBe('ARMED');
    expect(s.captures).toBe(1);
    expect(s.sharpHistory).toEqual([50]);
  });

  it('움직이면 안정 시간이 처음부터 다시 잰다', () => {
    let r = step(initialState(), { t: 0, motion: 0, change: 1, sharpness: 1 }, P);
    r = step(r.state, { t: 300, motion: 0.01, change: 1, sharpness: 1 }, P);
    r = step(r.state, { t: 350, motion: 0, change: 1, sharpness: 1 }, P);
    r = step(r.state, { t: 700, motion: 0, change: 1, sharpness: 1 }, P);
    expect(r.capture).toBe(false);
    r = step(r.state, { t: 750, motion: 0, change: 1, sharpness: 1 }, P);
    expect(r.capture).toBe(true);
  });

  it('ARMED: motion > MOVE 가 MOVE_MS 이상이면 TURNING, 짧은 움직임은 무시', () => {
    let s: MachineState = { ...initialState(), name: 'ARMED', firstShot: false, lastCaptureAt: 0 };
    s = step(s, { t: 1000, motion: 0.1, change: 0.3, sharpness: 1 }, P).state;
    s = step(s, { t: 1100, motion: 0.1, change: 0.3, sharpness: 1 }, P).state;
    s = step(s, { t: 1120, motion: 0.001, change: 0.3, sharpness: 1 }, P).state; // 끊김 → 다시 잰다
    expect(s.name).toBe('ARMED');
    s = step(s, { t: 1200, motion: 0.1, change: 0.3, sharpness: 1 }, P).state;
    s = step(s, { t: 1349, motion: 0.1, change: 0.3, sharpness: 1 }, P).state;
    expect(s.name).toBe('ARMED');
    s = step(s, { t: 1350, motion: 0.1, change: 0.3, sharpness: 1 }, P).state;
    expect(s.name).toBe('TURNING');
  });

  it('TURNING: 멈춰도 마지막 촬영에서 MIN_INTERVAL_MS 전이면 CHECK 로 가지 않는다', () => {
    let s: MachineState = { ...initialState(), name: 'TURNING', firstShot: false, lastCaptureAt: 0 };
    s = step(s, { t: 100, motion: 0, change: 0.3, sharpness: 1 }, P).state;
    const r1 = step(s, { t: 600, motion: 0, change: 0.3, sharpness: 1 }, P);
    expect(r1.capture).toBe(false); // 안정 500ms 지났지만 촬영 후 600ms < 800ms
    const r2 = step(r1.state, { t: 800, motion: 0, change: 0.3, sharpness: 1 }, P);
    expect(r2.capture).toBe(true);
  });

  it('CHECK: 같은 장면이면 촬영하지 않고 ARMED', () => {
    let s: MachineState = { ...initialState(), name: 'TURNING', firstShot: false, lastCaptureAt: -5000 };
    s = step(s, { t: 0, motion: 0, change: 0.02, sharpness: 1 }, P).state;
    const r = step(s, { t: 400, motion: 0, change: 0.02, sharpness: 1 }, P);
    expect(r.capture).toBe(false);
    expect(r.state.name).toBe('ARMED');
  });

  it('CHECK: 선명도 미달이면 WAIT_STABLE 로 가고, 다시 STABLE_MS 뒤 재검사', () => {
    let s: MachineState = { ...initialState({ sharpHistory: [100, 100, 100] }), name: 'TURNING', firstShot: false, lastCaptureAt: -5000 };
    s = step(s, { t: 0, motion: 0, change: 0.3, sharpness: 30 }, P).state;
    let r = step(s, { t: 400, motion: 0, change: 0.3, sharpness: 30 }, P);
    expect(r.capture).toBe(false);
    expect(r.state.name).toBe('WAIT_STABLE');
    r = step(r.state, { t: 500, motion: 0, change: 0.3, sharpness: 95 }, P);
    expect(r.capture).toBe(false);
    r = step(r.state, { t: 800, motion: 0, change: 0.3, sharpness: 95 }, P);
    expect(r.capture).toBe(true);
  });

  it('수동 촬영은 어느 상태에서나 즉시 CAPTURE, PAUSED 였으면 저장 뒤 PAUSED 로 돌아간다', () => {
    for (const name of ['WAIT_STABLE', 'ARMED', 'TURNING', 'PAUSED'] as const) {
      const r = manualCapture({ ...initialState(), name }, 10);
      expect(r.capture, name).toBe(true);
      expect(r.state.name).toBe('CAPTURE');
    }
    const r = manualCapture({ ...initialState(), name: 'CAPTURE' }, 10);
    expect(r.capture).toBe(false); // 이미 촬영 중이면 겹치지 않는다
    const back = captured(manualCapture({ ...initialState(), name: 'PAUSED' }, 0).state, 100, 5, { wasPaused: true });
    expect(back.state.name).toBe('PAUSED');
  });

  it('CAPTURE 동안 프레임은 무시하고, 실패하면 WAIT_STABLE', () => {
    let s = manualCapture(initialState(), 0).state;
    s = step(s, { t: 50, motion: 0.5, change: 1, sharpness: 1 }, P).state;
    expect(s.name).toBe('CAPTURE');
    expect(captureFailed(s, 60).state.name).toBe('WAIT_STABLE');
  });

  it('촬영·저장이 실패하면 같은 장면이라도 다시 안정되면 찍는다 (조용한 누락 방지)', () => {
    let s: MachineState = { ...initialState(), firstShot: false, name: 'CAPTURE', lastCaptureAt: 0 };
    s = captureFailed(s, 100).state;
    s = step(s, { t: 200, motion: 0, change: 0.001, sharpness: 1 }, P).state;
    const r = step(s, { t: 600, motion: 0, change: 0.001, sharpness: 1 }, P);
    expect(r.capture).toBe(true);
  });

  it('선명도 0(값 없음)은 기록에 넣지 않는다', () => {
    expect(captured(manualCapture(initialState(), 0).state, 10, 0).state.sharpHistory).toEqual([]);
  });

  it('PAUSED: 프레임 무시, 재개하면 WAIT_STABLE', () => {
    let s = pause(initialState(), 0).state;
    expect(s.name).toBe('PAUSED');
    const r = step(s, { t: 1000, motion: 0, change: 1, sharpness: 1 }, P);
    expect(r.capture).toBe(false);
    s = resume(r.state, 1100).state;
    expect(s.name).toBe('WAIT_STABLE');
  });

  it('기준 프레임을 불러온 세션은 첫 장 규칙을 쓰지 않는다 (새로고침 뒤 같은 페이지 중복 방지)', () => {
    let s = initialState({ hasReference: true });
    s = step(s, { t: 0, motion: 0, change: 0.01, sharpness: 1 }, P).state;
    const r = step(s, { t: 400, motion: 0, change: 0.01, sharpness: 1 }, P);
    expect(r.capture).toBe(false);
    expect(r.state.name).toBe('ARMED');
  });
});

describe('시퀀스 (SPEC 9장: 누락·중복·손만 움직임·흔들림)', () => {
  it('50페이지를 넘기면 정확히 50장, 장면마다 한 장 (누락 0, 중복 0)', () => {
    const { shots } = run(turns(50));
    expect(shots).toHaveLength(50);
    expect(new Set(shots.map((s) => s.scene)).size).toBe(50);
  });

  it('빠르게 넘겨도 (멈춤 800ms, 넘김 400ms, 저장 300ms) 누락·중복이 없다', () => {
    const { shots } = run(turns(20, { stillMs: 800, turnMs: 400 }));
    expect(shots.map((s) => s.scene)).toEqual([...Array(20).keys()]);
  });

  it('한계: 저장이 끝나기 전에 넘기기 시작해 남은 움직임이 MOVE_MS 보다 짧으면 놓친다', () => {
    // 멈춤 600ms: 안정 400ms 뒤 촬영 + 저장 300ms = 700ms → 다음 넘김이 시작된 뒤에야 ARMED
    const { shots } = run(turns(20, { stillMs: 600, turnMs: 400 }));
    expect(shots.length).toBeLessThan(20);
  });

  it('멈춘 채 오래 두어도 중복 촬영하지 않는다', () => {
    const { shots } = run([{ ms: 60_000, motion: 0.002, scene: 0 }]);
    expect(shots).toHaveLength(1);
  });

  it('손만 움직였다 빠지면 (장면 그대로) 촬영하지 않는다', () => {
    const segs: Segment[] = [
      { ms: 1500, motion: 0.001, scene: 0 },
      { ms: 600, motion: 0.15, scene: 0, partialChange: 0.2 }, // 손이 들어와 움직이는 중
      { ms: 1500, motion: 0.001, scene: 0 }, // 손이 빠지고 같은 페이지
    ];
    const { shots, final } = run(segs);
    expect(shots).toHaveLength(1);
    expect(final.name).toBe('ARMED');
  });

  it('흔들림: 짧은 진동(MOVE_MS 미만)은 넘김으로 보지 않는다', () => {
    const segs: Segment[] = [{ ms: 1500, motion: 0.001, scene: 0 }];
    for (let i = 0; i < 10; i++) {
      segs.push({ ms: 90, motion: 0.08, scene: 0, partialChange: 0.1 });
      segs.push({ ms: 200, motion: 0.001, scene: 0 });
    }
    const { shots } = run(segs);
    expect(shots).toHaveLength(1);
  });

  it('흔들림 뒤 흐린 프레임: 선명도 미달이면 찍지 않고 선명해진 뒤 한 번 찍는다', () => {
    const segs: Segment[] = [
      ...turns(5),
      { ms: 700, motion: 0.2, scene: 5 },
      { ms: 450, motion: 0.001, scene: 5, sharp: 20 }, // 멈췄지만 흐림
      { ms: 1500, motion: 0.001, scene: 5, sharp: 100 },
    ];
    const { shots } = run(segs);
    expect(shots.map((s) => s.scene)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('천천히 넘기면 (움직임이 MOVE 보다 작음) 놓친다 — 튜닝 대상임을 기록', () => {
    const { shots } = run(turns(3, { turnMotion: 0.03 }));
    expect(shots).toHaveLength(1);
  });

  it('simulate 도 같은 결과를 낸다 (녹화 재생 공용 경로)', () => {
    const inputs: FrameInput[] = [];
    let t = 0;
    for (let i = 0; i < 24; i++, t += DT) inputs.push({ t, motion: 0, change: 1, sharpness: 10 });
    const r = simulate(inputs, P);
    expect(r.captures).toHaveLength(1);
    expect(r.final.name).toBe('ARMED');
  });
});

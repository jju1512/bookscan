/**
 * 펴기 (SPEC 8장): 글자 줄을 검출해 페이지를 3차 곡면으로 모델링하고, 최적화한 뒤 리매핑한다.
 * mzucker/page_dewarp (MIT) 방식을 옮김 — https://github.com/mzucker/page_dewarp
 *
 * 흐름: 축소 → 글자 덩어리 → 줄 → 점 샘플 → 초기 자세 → LM 최적화 → 리매핑.
 * 예외를 던지지 않는다. 줄이 적거나 최적화·결과가 이상하면 skipped 로 돌려주고, 호출한 쪽이 자른 이미지를 그대로 쓴다.
 *
 * 원본(page_dewarp)과 다른 점
 * - 최적화기: scipy Powell → 직접 구현한 Levenberg–Marquardt (lm.ts). 변수 배치도 다르다(model.ts).
 * - 목적함수에 곡면 기울기 α·β 의 작은 벌점을 더했다.
 * - 덩어리 모멘트는 채워진 마스크 픽셀로 계산한다 (spans.ts).
 * - 작업 해상도: 1280 고정이 아니라 글자 크기에 맞춰 후보(1280…300) 중에서 고른다 (detect.ts selectWorkScale).
 * - 출력: 페이지 좌표 직사각형이 아니라 입력과 같은 틀에 "들림만 되돌려" 그린다. 페이지 크기 추정은 없다.
 *   입력이 이미 정면으로 펴진 이미지라서다 (remap.ts 머리 주석). 마지막 흑백 임계값 처리도 하지 않는다.
 * - 자세(rvec·tz)가 초기값에서 멀어지지 않도록 벌점을 준다 (model.ts).
 * - 여러 시작점(multiStart): 정면 시작점 외에 x축으로 살짝 기울인 시작점도 LM 으로 풀어 비용이 가장 낮은 것을 쓴다.
 *   휨이 큰 합성 이미지에서 정면 시작점 하나만 쓰면 비용은 줄어도 줄이 오히려 더 휘는 해로 가는 경우가 있었다.
 * - 검산(verify): 편 결과에서 같은 방법으로 줄 곧음을 다시 재서, 입력보다 나아지지 않았으면 건너뛴다.
 */
import { del, type CV, type Raster } from '../raster';
import { pageRect, selectWorkScale, WORK_EDGES } from './detect';
import { levenbergMarquardt } from './lm';
import { measureStraightness } from './metrics';
import { FOCAL_LENGTH, pixToNorm } from './math';
import { buildPageModel, keypointsFromSamples } from './model';
import { remapPage } from './remap';
import { sampleSpans, SPAN_PX_PER_STEP, type P2 } from './spans';

export interface DewarpResult {
  raster: Raster | null;
  skipped: boolean;
  reason?: string;
  meta: Record<string, unknown>;
}

export interface DewarpOptions {
  /** 작업용 축소의 긴 변을 이 값 하나로 고정한다 (기본: WORK_EDGES 후보 중 글자 줄이 가장 잘 잡히는 것) */
  workEdge?: number;
  /** 최적화 시간 상한 ms (기본 3000) */
  maxMs?: number;
  /** 최적화 반복 상한 */
  maxIterations?: number;
  /** 이 줄 수보다 적으면 건너뛴다 (기본 4) */
  minSpans?: number;
  /** 이 점 수보다 적으면 건너뛴다 (기본 40) */
  minPoints?: number;
  /** 점 수 상한. 넘으면 샘플 간격을 늘린다 (기본 1200) */
  maxPoints?: number;
  /** 원래 위치에서 가져오는 거리의 상한 (긴 변 비율, 기본 0.15) */
  maxShift?: number;
  /** 좌표 맵 간격 px (기본 12) */
  remapDecimate?: number;
  /** 기울인 시작점도 시도할지 (기본 true) */
  multiStart?: boolean;
  /** 편 결과의 줄 곧음을 다시 재서 나아지지 않았으면 건너뛸지 (기본 true) */
  verify?: boolean;
  /** 최적화로 데이터 비용이 이만큼(비율)도 안 줄면 평평한 페이지로 보고 건너뛴다 (기본 0.1) */
  minGain?: number;
  /** 가져오는 거리의 최댓값이 긴 변의 이 비율보다 작으면 평평한 페이지로 보고 건너뛴다 (기본 0.005) */
  minShift?: number;
}

/** 최종 잔차 RMS(정규화 좌표)가 이 값을 넘으면 맞지 않은 것으로 본다. 0.03 ≈ 원본 긴 변의 1.5% */
export const MAX_RMS_NORM = 0.03;
/** 곡면 기울기 절댓값 상한 */
export const MAX_SLOPE = 4;

const SKIP_FEW_LINES = '글자 줄이 적어 펴기를 건너뜀 (그림·표 페이지)';
const SKIP_FLAT = '곡면이 거의 없어 펴기를 건너뜀 (평평한 페이지)';

function skip(reason: string, meta: Record<string, unknown>, t0: number): DewarpResult {
  return { raster: null, skipped: true, reason, meta: { ...meta, ms: Math.round(performance.now() - t0) } };
}

export function dewarpPage(cv: CV, src: Raster, opts: DewarpOptions = {}): DewarpResult {
  const t0 = performance.now();
  const meta: Record<string, unknown> = {};
  try {
    return run(cv, src, opts, meta, t0);
  } catch (e) {
    return skip(`펴기 중 오류로 건너뜀: ${e instanceof Error ? e.message : String(e)}`, meta, t0);
  }
}

function run(cv: CV, src: Raster, opts: DewarpOptions, meta: Record<string, unknown>, t0: number): DewarpResult {
  const minSpans = opts.minSpans ?? 4;
  const minPoints = opts.minPoints ?? 40;
  const maxPoints = opts.maxPoints ?? 1200;

  // 1~3. 축소, 글자 덩어리, 줄 (작업 해상도는 글자 크기에 맞춰 후보 중에서 고른다)
  const sel = selectWorkScale(cv, src, opts.workEdge ? [opts.workEdge] : WORK_EDGES);
  const { g, blobs, spans } = sel;
  meta.workEdge = Math.max(g.width, g.height);
  meta.scaleTrials = sel.trials;
  meta.blobs = blobs.length;
  meta.spans = spans.length;
  meta.workSize = [g.width, g.height];
  if (spans.length < minSpans) return skip(SKIP_FEW_LINES, meta, t0);

  // 4. 점 샘플 (점이 너무 많으면 간격을 늘린다)
  let pts = sampleSpans(spans, SPAN_PX_PER_STEP);
  let total = pts.reduce((a, s) => a + s.length, 0);
  if (total > maxPoints) {
    pts = sampleSpans(spans, Math.ceil((SPAN_PX_PER_STEP * total) / maxPoints));
    total = pts.reduce((a, s) => a + s.length, 0);
  }
  // 점이 너무 적은 줄(2개 미만)은 뺀다
  pts = pts.filter((s) => s.length >= 2);
  total = pts.reduce((a, s) => a + s.length, 0);
  meta.points = total;
  meta.lines = pts.length;
  if (pts.length < minSpans || total < minPoints) return skip(SKIP_FEW_LINES, meta, t0);

  const norm = (p: P2): P2 => pixToNorm(g.width, g.height, p[0], p[1]);
  const spanPoints = pts.map((s) => s.map(norm));
  const [rx0, ry0, rx1, ry1] = pageRect(g.width, g.height);
  const outline: P2[] = [norm([rx0, ry0]), norm([rx0, ry1]), norm([rx1, ry1]), norm([rx1, ry0])];

  // 5. 초기값
  const kp = keypointsFromSamples(spanPoints, outline);
  const pageW0 = Math.hypot(kp.corners[1][0] - kp.corners[0][0], kp.corners[1][1] - kp.corners[0][1]);
  const pageH0 = Math.hypot(kp.corners[3][0] - kp.corners[0][0], kp.corners[3][1] - kp.corners[0][1]);
  const pose = planarPose(cv, kp.corners, pageW0, pageH0);
  if (!pose) return skip('초기 자세를 구하지 못해 펴기를 건너뜀', meta, t0);

  // 6~7. 최적화 (시작점마다 LM, 비용이 가장 낮은 것을 쓴다)
  const model = buildPageModel(kp.corners[0], spanPoints, pose);
  const starts: Array<[string, number[]]> = [['flat', pose]];
  if (opts.multiStart !== false) {
    for (const tilt of [0.25, -0.25]) starts.push([`tilt${tilt}`, composeTiltX(pose, tilt)]);
  }
  const maxMs = opts.maxMs ?? 3000;
  const tOpt = performance.now();
  let best: { x: Float64Array; cost: number; name: string; iterations: number; reason: string } | null = null;
  let flatInitial = NaN;
  for (let k = 0; k < starts.length; k++) {
    const [name, startPose] = starts[k]!;
    const remain = maxMs - (performance.now() - tOpt);
    if (remain <= 50) break;
    const x0 = model.pack([...startPose, 0, 0], kp.ycoords, kp.xcoords);
    // 남은 시간을 남은 시작점 수로 나눠 쓴다
    const res = levenbergMarquardt(model.problem, x0, { maxIterations: opts.maxIterations ?? 150, maxMs: remain / (starts.length - k) });
    if (k === 0) flatInitial = res.initialCost;
    if (!best || res.cost < best.cost) best = { x: res.x, cost: res.cost, name, iterations: res.iterations, reason: res.reason };
  }
  if (!best || !Number.isFinite(best.cost)) return skip('펴기 최적화에 실패해 건너뜀', meta, t0);
  const gl = model.globalsOf(best.x);
  const dataCost = model.dataCost(best.x);
  const rms = Math.sqrt(dataCost / (model.nPoints * 2));
  const gain = 1 - dataCost / flatInitial;
  meta.initialCost = flatInitial;
  meta.cost = best.cost;
  meta.dataCost = dataCost;
  meta.gain = gain;
  meta.rmsNorm = rms;
  meta.iterations = best.iterations;
  meta.stop = best.reason;
  meta.start = best.name;
  meta.optMs = Math.round(performance.now() - tOpt);
  meta.globals = Array.from(gl, (v) => +v.toFixed(4));
  if (!(best.cost <= flatInitial)) return skip('최적화 결과가 초기값보다 나빠 건너뜀', meta, t0);
  if (rms > MAX_RMS_NORM) return skip('글자 줄이 곡면 모델에 맞지 않아 펴기를 건너뜀', meta, t0);
  if (Math.abs(gl[6]!) > MAX_SLOPE || Math.abs(gl[7]!) > MAX_SLOPE || !(gl[5]! > 0)) return skip('곡면 모델이 비정상이라 펴기를 건너뜀', meta, t0);
  if (gain < (opts.minGain ?? 0.1)) return skip(SKIP_FLAT, meta, t0);

  // 8. 리매핑: 곡면의 들림만 되돌려 입력과 같은 틀에 다시 그린다 (remap.ts 머리 주석 참고)
  const long = Math.max(src.width, src.height);
  const rm = remapPage(cv, src, { globals: gl, smallW: g.width, smallH: g.height }, { decimate: opts.remapDecimate ?? 12, maxShift: opts.maxShift, minShiftPx: (opts.minShift ?? 0.005) * long });
  if (!rm.ok) return skip(rm.flat ? rm.reason : `${rm.reason} — 펴기를 건너뜀`, meta, t0);
  meta.maxShiftPx = Math.round(rm.maxShiftPx);
  if (opts.verify !== false) {
    // 검산: 입력과 출력을 같은 작업 해상도로 재서, 줄이 더 곧아졌는지 본다
    const edge = Math.max(g.width, g.height);
    const before = measureStraightness(cv, src, edge);
    const after = measureStraightness(cv, rm.raster, edge);
    meta.straightBefore = +before.rmsPermille.toFixed(3);
    meta.straightAfter = +after.rmsPermille.toFixed(3);
    if (Number.isFinite(before.rmsPermille) && !(after.rmsPermille < before.rmsPermille)) return skip('편 결과에서 글자 줄이 더 곧아지지 않아 펴기를 건너뜀', meta, t0);
  }
  meta.ms = Math.round(performance.now() - t0);
  return { raster: rm.raster, skipped: false, meta };
}

/** 페이지 네 모서리(정규화 좌표)에서 평면 자세 [rvec 3, tvec 3] 를 구한다 (cv.solvePnP) */
function planarPose(cv: CV, corners: P2[], w: number, h: number): number[] | null {
  const obj = cv.matFromArray(4, 3, cv.CV_64F, [0, 0, 0, w, 0, 0, w, h, 0, 0, h, 0]);
  const img = cv.matFromArray(4, 2, cv.CV_64F, corners.flatMap((c) => [c[0], c[1]]));
  const K = cv.matFromArray(3, 3, cv.CV_64F, [FOCAL_LENGTH, 0, 0, 0, FOCAL_LENGTH, 0, 0, 0, 1]);
  const dist = cv.Mat.zeros(4, 1, cv.CV_64F);
  const rvec = new cv.Mat();
  const tvec = new cv.Mat();
  try {
    const ok = cv.solvePnP(obj, img, K, dist, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE);
    if (!ok) return null;
    const r = Array.from(rvec.data64F as Float64Array);
    const t = Array.from(tvec.data64F as Float64Array);
    if (r.length !== 3 || t.length !== 3 || ![...r, ...t].every(Number.isFinite) || !(t[2]! > 0)) return null;
    return [...r, ...t];
  } finally {
    del(obj, img, K, dist, rvec, tvec);
  }
}

/** 자세 [rvec, tvec] 에 카메라 x축 둘레로 angle(rad) 만큼 더 기울인 시작점을 만든다 */
function composeTiltX(pose: number[], angle: number): number[] {
  // 회전 벡터끼리의 합성은 행렬로 한다: R' = Rx(angle)·R, t' = Rx(angle)·t
  const R = rotFromVec(pose.slice(0, 3));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const Rx = [1, 0, 0, 0, c, -s, 0, s, c];
  const mul = (A: number[], B: number[]) => {
    const o = new Array<number>(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j]! += A[i * 3 + k]! * B[k * 3 + j]!;
    return o;
  };
  const R2 = mul(Rx, R);
  const t = pose.slice(3, 6);
  const t2 = [Rx[0]! * t[0]! + Rx[1]! * t[1]! + Rx[2]! * t[2]!, Rx[3]! * t[0]! + Rx[4]! * t[1]! + Rx[5]! * t[2]!, Rx[6]! * t[0]! + Rx[7]! * t[1]! + Rx[8]! * t[2]!];
  return [...vecFromRot(R2), ...t2];
}

function rotFromVec(r: number[]): number[] {
  const th = Math.hypot(r[0]!, r[1]!, r[2]!);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [kx, ky, kz] = [r[0]! / th, r[1]! / th, r[2]! / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  return [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s, ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s, kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v];
}

function vecFromRot(R: number[]): number[] {
  const tr = R[0]! + R[4]! + R[8]!;
  const cosT = Math.max(-1, Math.min(1, (tr - 1) / 2));
  const th = Math.acos(cosT);
  if (th < 1e-9) return [0, 0, 0];
  const k = [R[7]! - R[5]!, R[2]! - R[6]!, R[3]! - R[1]!];
  const n = Math.hypot(k[0]!, k[1]!, k[2]!);
  if (n < 1e-9) return [0, 0, 0]; // 180도 근처는 쓰지 않는다 (시작점 용도)
  return [(k[0]! / n) * th, (k[1]! / n) * th, (k[2]! / n) * th];
}

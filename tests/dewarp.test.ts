/**
 * 펴기(dewarp) 시험. 순수 계산(Rodrigues·투영·LM·줄 잇기)은 OpenCV 없이, 나머지는 Node 용 OpenCV.js 로 돌린다.
 * 합성 이미지 회귀는 tests/fixtures/synthetic/dewarp-metrics.json 의 기준값과 비교한다.
 *   기준값을 새로 쓰려면: UPDATE_DEWARP_METRICS=1 npx vitest run tests/dewarp.test.ts --maxWorkers=1
 * 결과 이미지는 tests/fixtures/synthetic/out/ (gitignore) 에 PNG 로 남긴다.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { warpQuad } from '../src/process/crop/crop';
import { dewarpPage } from '../src/process/dewarp/dewarp';
import { levenbergMarquardt, choleskySolveInPlace, type LmProblem } from '../src/process/dewarp/lm';
import {
  cubicCoefficients,
  makeFlatUnprojector,
  normToPix,
  pixToNorm,
  polyval,
  projectPagePoint,
  projectPoints3D,
  rodrigues,
} from '../src/process/dewarp/math';
import { measureStraightness } from '../src/process/dewarp/metrics';
import { buildPageModel, keypointsFromSamples } from '../src/process/dewarp/model';
import { assembleSpans, makeBlob, sampleSpans, type Blob, type P2 } from '../src/process/dewarp/spans';
import { del, type CV, type Raster } from '../src/process/raster';
import { loadPng, savePng } from './synthetic/raster.ts';

let cv: CV;
beforeAll(async () => {
  cv = createRequire(import.meta.url)('@techstark/opencv-js');
  await new Promise<void>((r) => {
    if (cv.Mat) r();
    else cv.onRuntimeInitialized = () => r();
  });
  delete cv.then; // Emscripten 모듈은 thenable 이라 await 하면 끝나지 않는다
}, 60_000);

const FIX = fileURLToPath(new URL('./fixtures/synthetic/', import.meta.url));
const OUT = `${FIX}out/`;
const METRICS_PATH = `${FIX}dewarp-metrics.json`;

/** 합성 장면에서 정답 quad 로 원근 보정해 한 페이지만 꺼낸다 */
function fixturePage(name: string, idx: number): Raster {
  const img = loadPng(`${FIX}${name}.png`);
  const meta = JSON.parse(readFileSync(`${FIX}${name}.json`, 'utf8')) as { pages: Array<{ quad: [P2, P2, P2, P2] }> };
  return warpQuad(cv, img, meta.pages[idx]!.quad);
}

// ───────────────────────── 순수 계산 ─────────────────────────

describe('Rodrigues·투영 (OpenCV 와 비교)', () => {
  const rvec = [0.31, -0.42, 0.17];
  const tvec = [-0.2, 0.35, 1.4];
  const pts = [0, 0, 0, 1, 0, 0.1, 0.5, 1.2, -0.05, -0.8, 0.6, 0.2, 1.3, -0.4, 0.15];

  it('rodrigues 가 cv.Rodrigues 와 같은 행렬을 준다', () => {
    const r = cv.matFromArray(3, 1, cv.CV_64F, rvec);
    const R = new cv.Mat();
    try {
      cv.Rodrigues(r, R);
      const mine = rodrigues(rvec);
      for (let i = 0; i < 9; i++) expect(mine[i]).toBeCloseTo(R.data64F[i], 10);
    } finally {
      del(r, R);
    }
  });

  it('회전 0 이면 단위행렬, 반대 부호면 전치', () => {
    expect(Array.from(rodrigues([0, 0, 0]))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const a = rodrigues(rvec);
    const b = rodrigues(rvec.map((v) => -v));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(a[i * 3 + j]).toBeCloseTo(b[j * 3 + i]!, 12);
  });

  it('projectPoints3D 가 cv.projectPoints 와 같은 값을 준다', () => {
    const f = 1.2;
    const obj = cv.matFromArray(pts.length / 3, 1, cv.CV_64FC3, pts);
    const rv = cv.matFromArray(3, 1, cv.CV_64F, rvec);
    const tv = cv.matFromArray(3, 1, cv.CV_64F, tvec);
    const K = cv.matFromArray(3, 3, cv.CV_64F, [f, 0, 0, 0, f, 0, 0, 0, 1]);
    const dist = cv.Mat.zeros(4, 1, cv.CV_64F);
    const out = new cv.Mat();
    try {
      cv.projectPoints(obj, rv, tv, K, dist, out);
      const mine = projectPoints3D(rvec, tvec, pts, f);
      expect(out.rows * out.cols).toBe(pts.length / 3);
      for (let i = 0; i < mine.length; i++) expect(mine[i]).toBeCloseTo(out.data64F[i], 9);
    } finally {
      del(obj, rv, tv, K, dist, out);
    }
  });

  it('페이지 점 투영: 곡면 높이를 3차식으로 더해 cv.projectPoints 와 같다', () => {
    const alpha = -0.12;
    const beta = 0.2;
    const g = [...rvec, ...tvec, alpha, beta];
    const xy = [0.1, 0.2, 0.6, -0.3, 1.0, 0.9];
    const obj3 = [];
    for (let i = 0; i < xy.length; i += 2) obj3.push(xy[i]!, xy[i + 1]!, polyval(cubicCoefficients(alpha, beta), xy[i]!));
    const expected = projectPoints3D(rvec, tvec, obj3);
    const out = new Float64Array(2);
    for (let i = 0; i < xy.length / 2; i++) {
      projectPagePoint(g, xy[i * 2]!, xy[i * 2 + 1]!, out);
      expect(out[0]).toBeCloseTo(expected[i * 2]!, 12);
      expect(out[1]).toBeCloseTo(expected[i * 2 + 1]!, 12);
    }
  });
});

describe('다항식·좌표 변환', () => {
  it('3차 곡면은 x=0, x=1 에서 높이 0, 기울기 α·β', () => {
    const c = cubicCoefficients(0.3, -0.5);
    expect(polyval(c, 0)).toBeCloseTo(0, 12);
    expect(polyval(c, 1)).toBeCloseTo(0, 12);
    const h = 1e-6;
    expect((polyval(c, h) - polyval(c, 0)) / h).toBeCloseTo(0.3, 5);
    expect((polyval(c, 1) - polyval(c, 1 - h)) / h).toBeCloseTo(-0.5, 5);
    // np.polyval([2,-1,3], 2) = 2*4 - 2 + 3 = 9
    expect(polyval([2, -1, 3], 2)).toBe(9);
  });

  it('pixToNorm ↔ normToPix 가 서로 역이고 긴 변이 ±1 이다', () => {
    const [u, v] = pixToNorm(800, 400, 123, 77);
    const [x, y] = normToPix(800, 400, u, v);
    expect(x).toBeCloseTo(123, 9);
    expect(y).toBeCloseTo(77, 9);
    expect(pixToNorm(800, 400, 800, 200)[0]).toBeCloseTo(1, 12);
    expect(pixToNorm(800, 400, 0, 200)[0]).toBeCloseTo(-1, 12);
  });

  it('평면 투영의 역변환: 투영했다가 되돌리면 같은 페이지 점', () => {
    const g = [0.31, -0.42, 0.17, -0.2, 0.35, 1.4, 0, 0];
    const un = makeFlatUnprojector(g)!;
    const uv = new Float64Array(2);
    const xy = new Float64Array(2);
    for (const [x, y] of [[0.2, 0.3], [1, 1.5], [-0.4, 0.8]] as const) {
      projectPagePoint(g, x, y, uv);
      un(uv[0]!, uv[1]!, xy);
      expect(xy[0]).toBeCloseTo(x, 10);
      expect(xy[1]).toBeCloseTo(y, 10);
    }
  });
});

describe('Levenberg–Marquardt', () => {
  /** y = a·exp(b·x) + c 곡선 맞추기 */
  function expFit(a: number, b: number, c: number, noise = 0): { problem: LmProblem; truth: number[] } {
    const xs = Array.from({ length: 40 }, (_, i) => i / 20);
    let s = 12345;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
    const ys = xs.map((x) => a * Math.exp(b * x) + c + noise * rnd());
    return {
      truth: [a, b, c],
      problem: {
        n: 3,
        m: xs.length,
        residuals(p, out) {
          for (let i = 0; i < xs.length; i++) out[i] = p[0]! * Math.exp(p[1]! * xs[i]!) + p[2]! - ys[i]!;
        },
      },
    };
  }

  it('곡선 맞추기: 정답에 수렴한다', () => {
    const { problem, truth } = expFit(2.5, -1.3, 0.4);
    const res = levenbergMarquardt(problem, [1, -0.5, 0]);
    expect(res.converged).toBe(true);
    for (let i = 0; i < 3; i++) expect(res.x[i]).toBeCloseTo(truth[i]!, 6);
    expect(res.cost).toBeLessThan(1e-14);
    expect(res.initialCost).toBeGreaterThan(res.cost);
  });

  it('잡음이 있어도 잔차가 최소 근처로 수렴한다 (정답에서의 비용보다 크지 않다)', () => {
    const { problem, truth } = expFit(2.5, -1.3, 0.4, 0.05);
    const atTruth = new Float64Array(problem.m);
    problem.residuals(Float64Array.from(truth), atTruth);
    const costTruth = atTruth.reduce((s, v) => s + v * v, 0);
    const res = levenbergMarquardt(problem, [1, -0.5, 0]);
    expect(res.cost).toBeLessThanOrEqual(costTruth + 1e-12);
    expect(res.x[0]).toBeCloseTo(2.5, 0);
  });

  it('로젠브록: 비선형 골짜기를 따라 (1, 1) 에 도달', () => {
    const problem: LmProblem = {
      n: 2,
      m: 2,
      residuals(p, out) {
        out[0] = 10 * (p[1]! - p[0]! * p[0]!);
        out[1] = 1 - p[0]!;
      },
    };
    const res = levenbergMarquardt(problem, [-1.2, 1], { maxIterations: 200 });
    expect(res.x[0]).toBeCloseTo(1, 5);
    expect(res.x[1]).toBeCloseTo(1, 5);
  });

  it('희소 힌트(rowsOf/residualRows)를 줘도 힌트 없는 결과와 같다', () => {
    // 잔차 k = x_k − k (변수 k 는 행 k 에만 영향) + 전체에 영향을 주는 변수 하나(g): r_k = x_k + g − k·2
    const n = 6;
    const dense: LmProblem = {
      n: n + 1,
      m: n,
      residuals(x, out) {
        for (let k = 0; k < n; k++) out[k] = x[k]! + x[n]! - k * 2;
      },
    };
    const sparse: LmProblem = {
      ...dense,
      rowsOf: (j) => (j < n ? [j] : Array.from({ length: n }, (_, i) => i)),
      residualRows(x, rows, out) {
        for (let k = 0; k < rows.length; k++) out[k] = x[rows[k]!]! + x[n]! - rows[k]! * 2;
      },
    };
    const a = levenbergMarquardt(dense, new Float64Array(n + 1));
    const b = levenbergMarquardt(sparse, new Float64Array(n + 1));
    expect(b.cost).toBeLessThan(1e-12);
    expect(a.cost).toBeLessThan(1e-12);
  });

  it('시간 상한 0 이면 시작값을 그대로 돌려주고 timeout 으로 알린다', () => {
    const { problem } = expFit(2, -1, 0.5);
    const res = levenbergMarquardt(problem, [1, 0, 0], { maxMs: -1 });
    expect(res.reason).toBe('timeout');
    expect(res.converged).toBe(false);
    expect(res.cost).toBe(res.initialCost);
  });

  it('시작값에서 비용이 NaN 이면 invalid', () => {
    const problem: LmProblem = { n: 1, m: 1, residuals: (_x, out) => void (out[0] = NaN) };
    expect(levenbergMarquardt(problem, [0]).reason).toBe('invalid');
  });

  it('Cholesky: 밀집·희소 대칭 양정치 행렬을 푼다', () => {
    // A = [[4,1,0],[1,3,1],[0,1,2]] (아래 삼각만 채움), x = [1,2,3] → b = A·x
    const n = 3;
    const A = new Float64Array([4, 0, 0, 1, 3, 0, 0, 1, 2]);
    const b = Float64Array.from([4 + 2, 1 + 6 + 3, 2 + 6]);
    expect(choleskySolveInPlace(A, n, b)).toBe(true);
    expect(Array.from(b)).toEqual([1, 2, 3].map((v) => expect.closeTo(v, 12)));
    // 양정치가 아니면 false
    expect(choleskySolveInPlace(new Float64Array([1, 0, 2, 1]), 2, new Float64Array(2))).toBe(false);
  });
});

describe('덩어리·줄 만들기', () => {
  /** 가로 w, 세로 h 의 꽉 찬 사각 덩어리 */
  function box(x: number, y: number, w: number, h: number): Blob {
    return makeBlob(x, y, w, h, new Uint8Array(w * h).fill(1))!;
  }

  it('덩어리의 중심·방향·범위', () => {
    const b = box(10, 20, 40, 6);
    expect(b.center[0]).toBeCloseTo(10 + 19.5, 9);
    expect(b.center[1]).toBeCloseTo(20 + 2.5, 9);
    expect(Math.abs(b.angle)).toBeLessThan(1e-6);
    expect(b.lxmax - b.lxmin).toBeCloseTo(39, 6);
  });

  it('가로로 늘어선 덩어리는 한 줄로 이어지고 다른 줄과는 섞이지 않는다', () => {
    const blobs: Blob[] = [];
    for (let line = 0; line < 3; line++) for (let k = 0; k < 5; k++) blobs.push(box(20 + k * 55, 30 + line * 40, 40, 8));
    const spans = assembleSpans(blobs);
    expect(spans.length).toBe(3);
    for (const s of spans) {
      expect(s.length).toBe(5);
      expect(new Set(s.map((b) => b.y)).size).toBe(1);
      for (let i = 1; i < s.length; i++) expect(s[i]!.x).toBeGreaterThan(s[i - 1]!.x);
    }
    const pts = sampleSpans(spans);
    expect(pts.every((p) => p.length >= 5)).toBe(true);
  });

  it('너무 짧은 줄은 버린다', () => {
    expect(assembleSpans([box(10, 10, 20, 6)]).length).toBe(0);
  });
});

describe('곡면 모델 최적화 (합성 점, OpenCV 없음)', () => {
  it('알고 있는 곡면에서 만든 점을 평평한 시작값으로부터 잘 맞춘다', () => {
    const truth = [-0.35, 0.02, -0.01, -0.7, -0.95, 1.2, -0.15, 0.1];
    const nLines = 14;
    const spanPoints: P2[][] = [];
    const out = new Float64Array(2);
    for (let i = 0; i < nLines; i++) {
      const line: P2[] = [];
      for (let k = 0; k < 14; k++) {
        projectPagePoint(truth, 0.05 + k * 0.08, 0.1 + i * 0.1, out);
        line.push([out[0]!, out[1]!]);
      }
      spanPoints.push(line);
    }
    // 외곽선은 점들의 경계 상자로 대신한다 (시작값 만들기 시험용)
    const xs = spanPoints.flat().map((p) => p[0]);
    const ys = spanPoints.flat().map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const kp = keypointsFromSamples(spanPoints, [[x0, y0], [x0, y1], [x1, y1], [x1, y0]]);
    expect(kp.xcoords.length).toBe(nLines);
    const pose0 = [0, 0, 0, -0.7, -0.95, 1.2];
    const model = buildPageModel(kp.corners[0], spanPoints, pose0);
    const start = model.pack([...pose0, 0, 0], kp.ycoords, kp.xcoords);
    const c0 = model.dataCost(start);
    const res = levenbergMarquardt(model.problem, start, { maxIterations: 150, maxMs: 5000 });
    const c1 = model.dataCost(res.x);
    expect(c1).toBeLessThan(c0 * 0.05);
    // 점 하나당 잔차 RMS 가 0.002 (긴 변의 0.1%) 아래
    expect(Math.sqrt(c1 / (model.nPoints * 2))).toBeLessThan(0.002);
  });
});

// ───────────────────────── 합성 이미지 회귀 ─────────────────────────

interface MetricEntry {
  before: number;
  after: number | null;
  skipped: boolean;
}

function loadBaseline(): Record<string, MetricEntry> {
  if (!existsSync(METRICS_PATH)) return {};
  return JSON.parse(readFileSync(METRICS_PATH, 'utf8')) as Record<string, MetricEntry>;
}

const baseline = loadBaseline();
const fresh: Record<string, MetricEntry> = {};
const UPDATE = process.env.UPDATE_DEWARP_METRICS === '1';

/** 펴기 전·후 곧음을 같은 글자 크기로 잰다 */
function straightPair(before: Raster, after: Raster, beforeEdge?: number) {
  const b = measureStraightness(cv, before, beforeEdge);
  const scaled = Math.round((b.workEdge * Math.max(after.width, after.height)) / Math.max(before.width, before.height));
  const a = measureStraightness(cv, after, scaled);
  return { b, a };
}

function record(key: string, entry: MetricEntry): void {
  fresh[key] = entry;
  if (UPDATE) {
    const all = { ...loadBaseline(), ...fresh };
    writeFileSync(METRICS_PATH, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([p], [q]) => p.localeCompare(q))), null, 2) + '\n');
  }
}

/** 기준값이 있으면 "크게 나빠지지 않았는가"를 본다 (허용: 기준의 1.25 배 + 0.15‰) */
function expectNoRegression(key: string, after: number): void {
  const base = baseline[key];
  if (!base || base.after === null) return;
  expect(after, `${key} 곧음(‰)이 기준 ${base.after} 보다 크게 나빠짐`).toBeLessThanOrEqual(base.after * 1.25 + 0.15);
}

/** 페이지 한 장 펴기 + 측정 + PNG 저장. 한 테스트가 30초 안에 끝나야 한다 */
function runCase(name: string, idx: number, opts = {}) {
  const input = fixturePage(name, idx);
  const t = performance.now();
  const res = dewarpPage(cv, input, opts);
  const ms = Math.round(performance.now() - t);
  savePng(`${OUT}${name}-${idx}-in.png`, input);
  if (res.raster) savePng(`${OUT}${name}-${idx}-dewarp.png`, res.raster);
  const pair = res.raster ? straightPair(input, res.raster) : { b: measureStraightness(cv, input), a: null };
  return { input, res, ms, ...pair };
}

describe('펴기: 합성 이미지 회귀', () => {
  for (const idx of [0, 1]) {
    it(`spread-curved ${idx === 0 ? '왼쪽' : '오른쪽'} 페이지: 건너뛰지 않고 글자 줄이 더 곧아진다`, () => {
      const { input, res, ms, b, a } = runCase('spread-curved', idx);
      expect(res.skipped, res.reason).toBe(false);
      expect(res.raster).not.toBeNull();
      expect(res.meta.spans).toBeGreaterThanOrEqual(15);
      expect(ms).toBeLessThan(30_000);
      expect(a).not.toBeNull();
      const before = b.rmsPermille;
      const after = a!.rmsPermille;
      console.log(`[dewarp] spread-curved-${idx} 곧음(‰) 전 ${before.toFixed(3)} → 후 ${after.toFixed(3)}, ${ms}ms, 줄 ${res.meta.spans}, 점 ${res.meta.points}, 반복 ${res.meta.iterations}, 비용 ${Number(res.meta.initialCost).toExponential(2)} → ${Number(res.meta.dataCost).toExponential(2)}`);
      expect(after).toBeLessThan(before * 0.9);
      record(`spread-curved-${idx}`, { before: +before.toFixed(3), after: +after.toFixed(3), skipped: false });
      expectNoRegression(`spread-curved-${idx}`, after);
      // 출력 크기는 입력과 같고(틀을 유지한다) 최적화 비용이 줄었다
      expect([res.raster!.width, res.raster!.height]).toEqual([input.width, input.height]);
      expect(Number(res.meta.dataCost)).toBeLessThan(Number(res.meta.initialCost));
    }, 30_000);
  }

  it('spread-figure: 그림 쪽(왼쪽) 페이지는 건너뛴다', () => {
    const { res, ms } = runCase('spread-figure', 0);
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain('글자 줄이 적어');
    expect(res.raster).toBeNull();
    expect(ms).toBeLessThan(30_000);
    record('spread-figure-0', { before: 0, after: null, skipped: true });
  }, 30_000);

  it('spread-figure: 글자 쪽(오른쪽) 페이지는 망가지지 않는다', () => {
    const { res, b, a } = runCase('spread-figure', 1);
    if (!res.skipped) {
      expect(a!.rmsPermille).toBeLessThanOrEqual(b.rmsPermille * 1.1 + 0.15);
      record('spread-figure-1', { before: +b.rmsPermille.toFixed(3), after: +a!.rmsPermille.toFixed(3), skipped: false });
      expectNoRegression('spread-figure-1', a!.rmsPermille);
    }
  }, 30_000);

  for (const [name, idx] of [['spread-flat', 0], ['page-flat', 0]] as const) {
    it(`${name}: 평평한 페이지는 건너뛰거나, 펴도 곧음이 나빠지지 않는다`, () => {
      const normal = runCase(name, idx);
      if (!normal.res.skipped) {
        expect(normal.a!.rmsPermille).toBeLessThanOrEqual(normal.b.rmsPermille * 1.1 + 0.15);
      } else {
        expect(normal.res.reason).toMatch(/평평|곡면/);
      }
      // 건너뛰지 않도록 문턱을 풀어도 (억지로 펴도) 결과가 망가지지 않는다
      const forced = runCase(name, idx, { minGain: -1, minShift: 0, verify: false });
      expect(forced.res.skipped, forced.res.reason).toBe(false);
      expect(forced.a!.rmsPermille).toBeLessThanOrEqual(forced.b.rmsPermille * 1.25 + 0.2);
      expect(forced.ms).toBeLessThan(30_000);
      // 검산을 켜면 나아지지 않은 결과는 건너뛴다 (건너뛰지 않았다면 실제로 곧아졌어야 한다)
      const checked = runCase(name, idx, { minGain: -1, minShift: 0 });
      if (checked.res.skipped) expect(checked.res.reason).toMatch(/곧아지지|평평|곡면/);
      else expect(checked.a!.rmsPermille).toBeLessThan(checked.b.rmsPermille * 1.05);
      console.log(`[dewarp] ${name}-${idx} 곧음(‰) 전 ${forced.b.rmsPermille.toFixed(3)} → 억지로 편 후 ${forced.a!.rmsPermille.toFixed(3)} (보통 실행: ${normal.res.skipped ? '건너뜀' : '폄'}, 이득 ${Number(normal.res.meta.gain).toFixed(3)})`);
      record(`${name}-${idx}`, { before: +forced.b.rmsPermille.toFixed(3), after: +forced.a!.rmsPermille.toFixed(3), skipped: normal.res.skipped });
      expectNoRegression(`${name}-${idx}`, forced.a!.rmsPermille);
    }, 30_000);
  }
});

describe('펴기: 알고 있는 휨을 넣은 이미지', () => {
  /** 평평한 페이지에 x 의 함수인 세로 변위(오른쪽 가장자리에서 최대)를 넣는다. 줄이 오른쪽 아래로 휜다 */
  function bend(src: Raster, ratio: number): Raster {
    const { width: W, height: H } = src;
    const mx = new cv.Mat(H, W, cv.CV_32FC1);
    const my = new cv.Mat(H, W, cv.CV_32FC1);
    const m = new cv.Mat(H, W, cv.CV_8UC4);
    const dst = new cv.Mat();
    try {
      m.data.set(src.data);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const t = x / W;
          const dy = ratio * H * Math.exp(-(((1 - t) / 0.45) ** 2));
          mx.data32F[y * W + x] = x;
          my.data32F[y * W + x] = y - dy;
        }
      }
      cv.remap(m, dst, mx, my, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      return { width: W, height: H, data: new Uint8ClampedArray(dst.data) };
    } finally {
      del(mx, my, m, dst);
    }
  }

  it('page-flat 에 6% 휨을 넣으면 줄이 뚜렷하게 곧아진다', () => {
    const flat = fixturePage('page-flat', 0);
    const bent = bend(flat, 0.06);
    savePng(`${OUT}bent-in.png`, bent);
    const t = performance.now();
    const res = dewarpPage(cv, bent);
    const ms = performance.now() - t;
    expect(res.skipped, res.reason).toBe(false);
    savePng(`${OUT}bent-dewarp.png`, res.raster!);
    const { b, a } = straightPair(bent, res.raster!);
    const flatScore = measureStraightness(cv, flat, b.workEdge).rmsPermille;
    console.log(`[dewarp] bent 곧음(‰) 휜 이미지 ${b.rmsPermille.toFixed(3)} → 편 후 ${a.rmsPermille.toFixed(3)} (원래 평평한 이미지 ${flatScore.toFixed(3)}), ${Math.round(ms)}ms, 이득 ${Number(res.meta.gain).toFixed(3)}`);
    // 휘어 있던 만큼(휜 − 평평)의 40% 이상을 되돌린다 (3차 곡면 모델은 종 모양 휨을 완전히 따라가지 못한다)
    expect(a.rmsPermille).toBeLessThan(b.rmsPermille - 0.4 * (b.rmsPermille - flatScore));
    expect(ms).toBeLessThan(30_000);
    record('bent-page-flat', { before: +b.rmsPermille.toFixed(3), after: +a.rmsPermille.toFixed(3), skipped: false });
    expectNoRegression('bent-page-flat', a.rmsPermille);
  }, 30_000);
});

describe('펴기: 예외 없이 건너뛰기', () => {
  it('글자 없는 빈 이미지', () => {
    const w = 400;
    const h = 500;
    const img: Raster = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(235) };
    const res = dewarpPage(cv, img);
    expect(res.skipped).toBe(true);
    expect(res.reason).toContain('글자 줄이 적어');
    expect(res.raster).toBeNull();
  });

  it('아주 작은 이미지', () => {
    const img: Raster = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(200) };
    const res = dewarpPage(cv, img);
    expect(res.skipped).toBe(true);
  });

  it('무작위 잡음 이미지도 예외를 던지지 않는다', () => {
    const w = 300;
    const h = 400;
    const data = new Uint8ClampedArray(w * h * 4);
    let s = 7;
    for (let i = 0; i < w * h; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const v = (s >>> 24) & 0xff;
      data.set([v, v, v, 255], i * 4);
    }
    expect(() => dewarpPage(cv, { width: w, height: h, data })).not.toThrow();
  });
});

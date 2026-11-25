/**
 * 페이지 곡면 모델: 초기값 만들기와 최소제곱 문제 정의 (OpenCV 없음).
 * mzucker/page_dewarp (MIT) 방식을 옮김 — https://github.com/mzucker/page_dewarp
 *
 * 변수 배치 (LM 의 희소 Cholesky 가 빠르도록 "지역 변수 먼저, 전역 변수 나중"):
 *   [ x_0 … x_{N-1} (점별 페이지 x) | y_0 … y_{S-1} (줄별 페이지 y) | rx ry rz tx ty tz α β ]
 * 원본은 [전역 | y | x] 순서라서 배치가 다르다.
 *
 * 잔차 (정규화 좌표, 투영점 − 관측점):
 *   행 0,1: 페이지 원점 (0,0) 이 왼위 모서리 관측점으로 투영되어야 한다 (원본의 keypoint 0)
 *   그다음 점마다 2행
 *   마지막 6행: 벌점 (원본에는 없다)
 *     λ·α, λ·β                         곡면 기울기를 작게
 *     w·(rvec − 초기 rvec) 3행, w·(tz − 초기 tz)   초기 자세(자른 페이지는 정면)에서 멀리 못 가게
 *   자세 벌점이 없으면 줄마다 y·점마다 x 가 자유라서, 평평한 페이지도 "기울어진 카메라" 해로 흘러가 버린다.
 */
import { GLOBAL_COUNT, projectWithPose, rodrigues } from './math';
import type { LmProblem } from './lm';
import type { P2 } from './spans';

/** 곡면 기울기 벌점 가중치 */
export const SLOPE_PENALTY = 0.02;
/** 자세 벌점 가중치 = POSE_PENALTY·√(점 수). 점이 많을수록 데이터 항이 커지므로 같이 키운다 */
export const POSE_PENALTY = 0.002;

export interface Keypoints {
  /** 줄마다 페이지 상의 y 초기값 */
  ycoords: number[];
  /** 줄마다 점들의 페이지 x 초기값 */
  xcoords: number[][];
  /** 페이지 네 모서리 (왼위, 오른위, 오른아래, 왼아래), 정규화 좌표 */
  corners: [P2, P2, P2, P2];
  /** 주축 방향 */
  xDir: P2;
  yDir: P2;
}

/**
 * 줄들의 가중 평균 방향으로 페이지 x·y 축을 정하고, 페이지 외곽선을 그 축에 투영해 네 모서리를 만든다.
 * spanPoints: 줄별 정규화 좌표 점들. outline: 페이지 외곽선(여백 사각형) 꼭짓점들, 정규화 좌표.
 */
export function keypointsFromSamples(spanPoints: P2[][], outline: P2[]): Keypoints {
  // 줄마다 점들의 주성분(2×2 공분산의 고유벡터)을 줄 길이로 가중 평균
  let ex = 0;
  let ey = 0;
  let wsum = 0;
  for (const pts of spanPoints) {
    const n = pts.length;
    if (n < 2) continue;
    let mx = 0;
    let my = 0;
    for (const p of pts) {
      mx += p[0];
      my += p[1];
    }
    mx /= n;
    my /= n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of pts) {
      const dx = p[0] - mx;
      const dy = p[1] - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let vx = Math.cos(th);
    let vy = Math.sin(th);
    if (vx < 0) {
      vx = -vx;
      vy = -vy;
    }
    const w = Math.hypot(pts[n - 1]![0] - pts[0]![0], pts[n - 1]![1] - pts[0]![1]);
    ex += vx * w;
    ey += vy * w;
    wsum += w;
  }
  let xl = Math.hypot(ex, ey);
  if (wsum <= 0 || xl < 1e-12) {
    ex = 1;
    ey = 0;
    xl = 1;
  }
  const xDir: P2 = [ex / xl, ey / xl];
  const yDir: P2 = [-xDir[1], xDir[0]];

  let px0 = Infinity;
  let px1 = -Infinity;
  let py0 = Infinity;
  let py1 = -Infinity;
  for (const p of outline) {
    const a = p[0] * xDir[0] + p[1] * xDir[1];
    const b = p[0] * yDir[0] + p[1] * yDir[1];
    px0 = Math.min(px0, a);
    px1 = Math.max(px1, a);
    py0 = Math.min(py0, b);
    py1 = Math.max(py1, b);
  }
  const at = (a: number, b: number): P2 => [a * xDir[0] + b * yDir[0], a * xDir[1] + b * yDir[1]];
  const corners: [P2, P2, P2, P2] = [at(px0, py0), at(px1, py0), at(px1, py1), at(px0, py1)];

  const ycoords: number[] = [];
  const xcoords: number[][] = [];
  for (const pts of spanPoints) {
    let sy = 0;
    const xs: number[] = [];
    for (const p of pts) {
      sy += p[0] * yDir[0] + p[1] * yDir[1];
      xs.push(p[0] * xDir[0] + p[1] * xDir[1] - px0);
    }
    ycoords.push(sy / pts.length - py0);
    xcoords.push(xs);
  }
  return { ycoords, xcoords, corners, xDir, yDir };
}

/** 최소제곱 문제와 변수 배치 정보 */
export interface PageModel {
  problem: LmProblem;
  /** 점 수, 줄 수 */
  nPoints: number;
  nSpans: number;
  /** 전역 변수의 시작 번호 */
  gOffset: number;
  /** 변수 벡터에서 데이터 항(벌점 제외)의 잔차 제곱합 */
  dataCost(x: Float64Array): number;
  /** 변수 벡터 만들기 */
  pack(globals: ArrayLike<number>, ycoords: ArrayLike<number>, xcoords: number[][]): Float64Array;
  /** 변수 벡터에서 전역 변수만 꺼내기 */
  globalsOf(x: ArrayLike<number>): Float64Array;
}

/**
 * corner0: 왼위 모서리 관측점. spanPoints: 줄마다 관측점들 (정규화 좌표). pose0: 벌점의 기준이 되는 초기 [rvec, tvec].
 */
export function buildPageModel(corner0: P2, spanPoints: P2[][], pose0: ArrayLike<number>): PageModel {
  const spanCounts = spanPoints.map((s) => s.length);
  const nSpans = spanCounts.length;
  const nPoints = spanCounts.reduce((a, b) => a + b, 0);
  const n = nPoints + nSpans + GLOBAL_COUNT;
  const gOffset = nPoints + nSpans;
  const penaltyRow = 2 + 2 * nPoints;
  // 벌점: [변수 번호(전역 안), 기준값, 가중치]
  const wPose = POSE_PENALTY * Math.sqrt(Math.max(1, nPoints));
  const penalties: Array<[number, number, number]> = [
    [6, 0, SLOPE_PENALTY],
    [7, 0, SLOPE_PENALTY],
    [0, pose0[0]!, wPose],
    [1, pose0[1]!, wPose],
    [2, pose0[2]!, wPose],
    [5, pose0[5]!, wPose],
  ];
  const m = penaltyRow + penalties.length;

  const spanOf = new Int32Array(nPoints);
  const spanStart = new Int32Array(nSpans + 1);
  const dst = new Float64Array(2 * nPoints);
  {
    let k = 0;
    for (let s = 0; s < nSpans; s++) {
      spanStart[s] = k;
      for (const p of spanPoints[s]!) {
        spanOf[k] = s;
        dst[2 * k] = p[0];
        dst[2 * k + 1] = p[1];
        k++;
      }
    }
    spanStart[nSpans] = k;
  }

  const gBuf = new Float64Array(GLOBAL_COUNT);
  const uv = new Float64Array(2);

  /** rows 의 잔차를 out 에 계산한다 (out[k] ↔ rows[k]) */
  const evalRows = (x: Float64Array, rows: ArrayLike<number>, out: Float64Array): void => {
    for (let i = 0; i < GLOBAL_COUNT; i++) gBuf[i] = x[gOffset + i]!;
    const R = rodrigues(gBuf);
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k]!;
      if (row < 2) {
        projectWithPose(R, gBuf, 0, 0, uv);
        out[k] = row === 0 ? uv[0]! - corner0[0] : uv[1]! - corner0[1];
      } else if (row >= penaltyRow) {
        const [gi, anchor, w] = penalties[row - penaltyRow]!;
        out[k] = w * (gBuf[gi]! - anchor);
      } else {
        const j = (row - 2) >> 1;
        projectWithPose(R, gBuf, x[j]!, x[nPoints + spanOf[j]!]!, uv);
        // 카메라 뒤로 간 점은 NaN 이 되고, 그 스텝은 LM 이 거부한다
        out[k] = (row & 1) === 0 ? uv[0]! - dst[2 * j]! : uv[1]! - dst[2 * j + 1]!;
      }
    }
  };

  const allRows = new Int32Array(m);
  for (let i = 0; i < m; i++) allRows[i] = i;
  const spanRows: Int32Array[] = [];
  for (let s = 0; s < nSpans; s++) {
    const a = spanStart[s]!;
    const b = spanStart[s + 1]!;
    const rows = new Int32Array((b - a) * 2);
    for (let j = a; j < b; j++) {
      rows[(j - a) * 2] = 2 + 2 * j;
      rows[(j - a) * 2 + 1] = 3 + 2 * j;
    }
    spanRows.push(rows);
  }

  const problem: LmProblem = {
    n,
    m,
    residuals(x, out) {
      evalRows(x, allRows, out);
    },
    rowsOf(j) {
      if (j < nPoints) return Int32Array.of(2 + 2 * j, 3 + 2 * j);
      if (j < gOffset) return spanRows[j - nPoints]!;
      return allRows;
    },
    residualRows: evalRows,
  };

  return {
    problem,
    nPoints,
    nSpans,
    gOffset,
    dataCost(x) {
      const r = new Float64Array(m);
      evalRows(x, allRows, r);
      let c = 0;
      for (let i = 0; i < penaltyRow; i++) c += r[i]! * r[i]!;
      return c;
    },
    pack(globals, ycoords, xcoords) {
      const x = new Float64Array(n);
      let k = 0;
      for (const xs of xcoords) for (const v of xs) x[k++] = v;
      for (let s = 0; s < nSpans; s++) x[nPoints + s] = ycoords[s]!;
      for (let i = 0; i < GLOBAL_COUNT; i++) x[gOffset + i] = globals[i]!;
      return x;
    },
    globalsOf(x) {
      return Float64Array.from({ length: GLOBAL_COUNT }, (_, i) => x[gOffset + i]!);
    },
  };
}

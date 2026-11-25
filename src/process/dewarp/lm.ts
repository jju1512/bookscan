/**
 * Levenberg–Marquardt 비선형 최소제곱 (OpenCV·외부 패키지 없음).
 * mzucker/page_dewarp (MIT) 는 scipy 의 Powell 법을 쓴다 — https://github.com/mzucker/page_dewarp
 * 여기서는 같은 목적함수(잔차 제곱합)를 LM 으로 푼다. 원본과 다른 점이다.
 *
 * - 야코비안은 수치 미분(전진 차분). 문제가 "변수 j 가 영향을 주는 잔차 행"을 알려 주면 그 행만 다시 계산해서 빠르다.
 * - 정규방정식 (JᵀJ + λ·diag(JᵀJ)) δ = −Jᵀr 은 밀집 행렬(n×n)로 저장하고 Cholesky 로 직접 푼다.
 *   다만 0 인 원소는 건너뛰는 right-looking 방식이라, 변수 순서를 "지역 변수 먼저, 전역 변수 나중"으로 두면
 *   (펴기가 그렇다) 비용이 n 에 거의 비례한다. 완전히 밀집한 문제에서도 맞게 풀린다(느릴 뿐).
 */

export interface LmProblem {
  /** 변수 개수 */
  n: number;
  /** 잔차 개수 */
  m: number;
  /** 전체 잔차 계산: out[0..m) 를 채운다 */
  residuals(x: Float64Array, out: Float64Array): void;
  /** (선택) 변수 j 가 영향을 주는 잔차 행 번호들 */
  rowsOf?(j: number): ArrayLike<number>;
  /** (선택) rows 에 해당하는 잔차만 계산: out[k] = r[rows[k]] */
  residualRows?(x: Float64Array, rows: ArrayLike<number>, out: Float64Array): void;
}

export interface LmOptions {
  maxIterations?: number;
  /** 시간 상한 (ms). 넘으면 그때까지의 최선을 돌려준다 */
  maxMs?: number;
  /** 한 번의 성공한 스텝에서 비용이 이 비율보다 덜 줄면 수렴으로 본다 */
  ftol?: number;
  /** 스텝 크기가 |x| 의 이 비율보다 작으면 수렴 */
  xtol?: number;
  /** 수치 미분의 기본 간격 */
  diffStep?: number;
  initialLambda?: number;
  now?: () => number;
}

export interface LmResult {
  x: Float64Array;
  /** 잔차 제곱합 */
  initialCost: number;
  cost: number;
  iterations: number;
  /** 정규방정식을 푼 횟수(시도한 스텝 수) */
  evaluations: number;
  converged: boolean;
  /** 멈춘 이유 */
  reason: 'ftol' | 'xtol' | 'gtol' | 'maxIterations' | 'timeout' | 'lambda' | 'invalid';
  ms: number;
}

function sumSq(r: Float64Array): number {
  let s = 0;
  for (let i = 0; i < r.length; i++) s += r[i]! * r[i]!;
  return s;
}

interface Sparse {
  /** 행 r 의 항목 [rowStart[r], rowStart[r+1]) */
  rowStart: Int32Array;
  cols: Int32Array;
  vals: Float64Array;
}

/** 열 단위로 모은 항목을 행 단위(CSR)로 바꾼다 */
function toRows(m: number, colRows: Int32Array[], colVals: Float64Array[]): Sparse {
  const rowStart = new Int32Array(m + 1);
  for (const rows of colRows) for (let k = 0; k < rows.length; k++) rowStart[rows[k]! + 1] = rowStart[rows[k]! + 1]! + 1;
  for (let r = 0; r < m; r++) rowStart[r + 1] = rowStart[r + 1]! + rowStart[r]!;
  const nnz = rowStart[m]!;
  const cols = new Int32Array(nnz);
  const vals = new Float64Array(nnz);
  const fillPos = rowStart.slice(0, m);
  for (let j = 0; j < colRows.length; j++) {
    const rows = colRows[j]!;
    const v = colVals[j]!;
    for (let k = 0; k < rows.length; k++) {
      const p = fillPos[rows[k]!]!;
      fillPos[rows[k]!] = p + 1;
      cols[p] = j;
      vals[p] = v[k]!;
    }
  }
  return { rowStart, cols, vals };
}

/** 수치 야코비안 (희소). 열마다 영향을 받는 행만 저장한다 */
function numericJacobian(p: LmProblem, x: Float64Array, r: Float64Array, step: number, full: Float64Array): Sparse {
  const colRows: Int32Array[] = new Array(p.n);
  const colVals: Float64Array[] = new Array(p.n);
  for (let j = 0; j < p.n; j++) {
    const xj = x[j]!;
    const h = step * Math.max(1, Math.abs(xj));
    x[j] = xj + h;
    if (p.rowsOf && p.residualRows) {
      const rows = p.rowsOf(j);
      const tmp = new Float64Array(rows.length);
      p.residualRows(x, rows, tmp);
      const rr = new Int32Array(rows.length);
      const vv = new Float64Array(rows.length);
      let c = 0;
      for (let k = 0; k < rows.length; k++) {
        const d = (tmp[k]! - r[rows[k]!]!) / h;
        if (d !== 0 && Number.isFinite(d)) {
          rr[c] = rows[k]!;
          vv[c] = d;
          c++;
        }
      }
      colRows[j] = rr.slice(0, c);
      colVals[j] = vv.slice(0, c);
    } else {
      p.residuals(x, full);
      let c = 0;
      for (let i = 0; i < p.m; i++) if (full[i] !== r[i]) c++;
      const rr = new Int32Array(c);
      const vv = new Float64Array(c);
      c = 0;
      for (let i = 0; i < p.m; i++) {
        if (full[i] !== r[i]) {
          const d = (full[i]! - r[i]!) / h;
          rr[c] = i;
          vv[c] = Number.isFinite(d) ? d : 0;
          c++;
        }
      }
      colRows[j] = rr;
      colVals[j] = vv;
    }
    x[j] = xj;
  }
  return toRows(p.m, colRows, colVals);
}

/**
 * 대칭 양정치 행렬 A(n×n, 행 우선, 아래 삼각만 사용·파괴)로 A·x = b 를 푼다. b 는 x 로 덮어쓴다.
 * 양정치가 아니면 false. 0 인 원소는 건너뛴다.
 */
export function choleskySolveInPlace(A: Float64Array, n: number, b: Float64Array): boolean {
  const nz = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    let d = A[k * n + k]!;
    if (!(d > 0) || !Number.isFinite(d)) return false;
    d = Math.sqrt(d);
    A[k * n + k] = d;
    let cnt = 0;
    for (let i = k + 1; i < n; i++) {
      const v = A[i * n + k]!;
      if (v !== 0) {
        A[i * n + k] = v / d;
        nz[cnt++] = i;
      }
    }
    for (let a = 0; a < cnt; a++) {
      const ia = nz[a]!;
      const la = A[ia * n + k]!;
      const rowA = ia * n;
      for (let c = 0; c <= a; c++) {
        const ib = nz[c]!;
        A[rowA + ib] = A[rowA + ib]! - la * A[ib * n + k]!;
      }
    }
  }
  // L y = b
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    const row = i * n;
    for (let k = 0; k < i; k++) {
      const l = A[row + k]!;
      if (l !== 0) s -= l * b[k]!;
    }
    b[i] = s / A[row + i]!;
  }
  // Lᵀ x = y
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i]!;
    for (let k = i + 1; k < n; k++) {
      const l = A[k * n + i]!;
      if (l !== 0) s -= l * b[k]!;
    }
    b[i] = s / A[i * n + i]!;
  }
  return true;
}

export function levenbergMarquardt(p: LmProblem, x0: ArrayLike<number>, opts: LmOptions = {}): LmResult {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const maxIter = opts.maxIterations ?? 100;
  const maxMs = opts.maxMs ?? 3000;
  const ftol = opts.ftol ?? 1e-9;
  const xtol = opts.xtol ?? 1e-10;
  const diffStep = opts.diffStep ?? 1e-6;
  const n = p.n;
  const x = Float64Array.from(x0);
  const r = new Float64Array(p.m);
  const rNew = new Float64Array(p.m);
  const full = new Float64Array(p.m);
  p.residuals(x, r);
  let cost = sumSq(r);
  const result = (reason: LmResult['reason'], converged: boolean, iterations: number, evaluations: number, initialCost: number): LmResult => ({
    x,
    initialCost,
    cost,
    iterations,
    evaluations,
    converged,
    reason,
    ms: now() - t0,
  });
  const initialCost = cost;
  if (!Number.isFinite(cost)) return result('invalid', false, 0, 0, initialCost);

  const H = new Float64Array(n * n);
  const W = new Float64Array(n * n);
  const g = new Float64Array(n);
  const diag = new Float64Array(n);
  const delta = new Float64Array(n);
  const xNew = new Float64Array(n);
  let lambda = opts.initialLambda ?? 1e-3;
  let evaluations = 0;
  let iter = 0;

  for (; iter < maxIter; iter++) {
    if (now() - t0 > maxMs) return result('timeout', false, iter, evaluations, initialCost);
    const J = numericJacobian(p, x, r, diffStep, full);
    // H = JᵀJ (아래 삼각), g = Jᵀr
    H.fill(0);
    g.fill(0);
    for (let row = 0; row < p.m; row++) {
      const a = J.rowStart[row]!;
      const b = J.rowStart[row + 1]!;
      const rr = r[row]!;
      for (let u = a; u < b; u++) {
        const cu = J.cols[u]!;
        const vu = J.vals[u]!;
        g[cu] = g[cu]! + vu * rr;
        for (let w = a; w < b; w++) {
          const cw = J.cols[w]!;
          if (cw <= cu) H[cu * n + cw] = H[cu * n + cw]! + vu * J.vals[w]!;
        }
      }
    }
    let gmax = 0;
    for (let i = 0; i < n; i++) {
      diag[i] = H[i * n + i]!;
      gmax = Math.max(gmax, Math.abs(g[i]!));
    }
    if (gmax < 1e-14) return result('gtol', true, iter, evaluations, initialCost);

    let accepted = false;
    for (let tries = 0; tries < 30; tries++) {
      if (now() - t0 > maxMs) return result('timeout', false, iter, evaluations, initialCost);
      // W = H + λ·diag(H)  (대각이 0 이면 아주 작은 값으로 받쳐 준다)
      W.set(H);
      for (let i = 0; i < n; i++) W[i * n + i] = diag[i]! + lambda * Math.max(diag[i]!, 1e-12);
      for (let i = 0; i < n; i++) delta[i] = -g[i]!;
      evaluations++;
      const ok = choleskySolveInPlace(W, n, delta);
      let good = false;
      let newCost = Infinity;
      if (ok) {
        for (let i = 0; i < n; i++) xNew[i] = x[i]! + delta[i]!;
        p.residuals(xNew, rNew);
        newCost = sumSq(rNew);
        good = Number.isFinite(newCost) && newCost < cost;
      }
      if (good) {
        let dn = 0;
        let xn = 0;
        for (let i = 0; i < n; i++) {
          dn += delta[i]! * delta[i]!;
          xn += x[i]! * x[i]!;
        }
        const drop = (cost - newCost) / Math.max(cost, 1e-300);
        x.set(xNew);
        r.set(rNew);
        cost = newCost;
        lambda = Math.max(lambda * 0.3, 1e-12);
        accepted = true;
        if (drop < ftol) return result('ftol', true, iter + 1, evaluations, initialCost);
        if (Math.sqrt(dn) < xtol * (Math.sqrt(xn) + xtol)) return result('xtol', true, iter + 1, evaluations, initialCost);
        break;
      }
      lambda *= 4;
      if (lambda > 1e14) return result('lambda', false, iter, evaluations, initialCost);
    }
    if (!accepted) return result('lambda', false, iter, evaluations, initialCost);
  }
  return result('maxIterations', false, iter, evaluations, initialCost);
}

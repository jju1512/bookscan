/** 후처리용 작은 기하 도구 (순수 함수) */

export type Pt = [number, number];

/** 왼위 → 오른위 → 오른아래 → 왼아래 순서로 */
export function orderCorners(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  if (pts.length !== 4) throw new Error('꼭짓점은 4개여야 합니다');
  const bySum = [...pts].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const byDiff = [...pts].sort((a, b) => a[0] - a[1] - (b[0] - b[1]));
  const tl = bySum[0]!;
  const br = bySum[3]!;
  const bl = byDiff[0]!;
  const tr = byDiff[3]!;
  // 네 점이 겹치면(매우 기울어진 사각형) 중심 각도 순서로 다시 정한다
  const set = new Set([tl, tr, br, bl]);
  if (set.size === 4) return [tl, tr, br, bl];
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // atan2 순서는 -π(왼쪽)부터 시계 방향(화면 좌표). 왼위가 먼저 오도록 돌린다
  let start = 0;
  let best = Infinity;
  sorted.forEach((p, i) => {
    const s = p[0] + p[1];
    if (s < best) {
      best = s;
      start = i;
    }
  });
  const r = [...sorted.slice(start), ...sorted.slice(0, start)];
  return [r[0]!, r[1]!, r[2]!, r[3]!];
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function isConvex(pts: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (z !== 0) {
      if (sign === 0) sign = Math.sign(z);
      else if (Math.sign(z) !== sign) return false;
    }
  }
  return true;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 점 집합의 네 극점 (x+y 최소·최대, x−y 최소·최대). 다각형 근사가 4점이 안 될 때 쓴다 */
export function extremeCorners(pts: Pt[]): [Pt, Pt, Pt, Pt] {
  let tl = pts[0]!, tr = pts[0]!, br = pts[0]!, bl = pts[0]!;
  for (const p of pts) {
    if (p[0] + p[1] < tl[0] + tl[1]) tl = p;
    if (p[0] + p[1] > br[0] + br[1]) br = p;
    if (p[0] - p[1] > tr[0] - tr[1]) tr = p;
    if (p[0] - p[1] < bl[0] - bl[1]) bl = p;
  }
  return [tl, tr, br, bl];
}

/** 비율 좌표 [x0,y0,...] ↔ 픽셀 꼭짓점 */
export function cornersToNorm(c: Pt[], w: number, h: number): number[] {
  return c.flatMap(([x, y]) => [x / w, y / h]);
}
export function normToCorners(n: number[], w: number, h: number): [Pt, Pt, Pt, Pt] {
  const p = (i: number): Pt => [n[i * 2]! * w, n[i * 2 + 1]! * h];
  return [p(0), p(1), p(2), p(3)];
}

/** 원근 보정 결과 크기: 마주 보는 변 중 긴 쪽 */
export function warpSize(c: [Pt, Pt, Pt, Pt]): { width: number; height: number } {
  const [tl, tr, br, bl] = c;
  return {
    width: Math.max(2, Math.round(Math.max(dist(tl, tr), dist(bl, br)))),
    height: Math.max(2, Math.round(Math.max(dist(tl, bl), dist(tr, br)))),
  };
}

/** 이동 평균 (가장자리는 있는 값만) */
export function smooth(values: ArrayLike<number>, radius: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i]! + values[i]!;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = (pre[b]! - pre[a]!) / (b - a);
  }
  return out;
}

/**
 * 글자 덩어리(blob)와 글자 줄(span) 만들기 (OpenCV 없음).
 * mzucker/page_dewarp (MIT) 방식을 옮김 — https://github.com/mzucker/page_dewarp
 *
 * 원본과 다른 점
 * - 덩어리의 중심·주축은 외곽선 모멘트(cv.moments + SVDecomp) 대신 채워진 마스크 픽셀의 모멘트로 구한다. 2×2 고유벡터는 닫힌 식.
 * - 주축 방향은 항상 오른쪽(+x)을 향하게 맞춘다(원본은 SVD 부호에 맡긴다).
 * - 좌표는 모두 작업용 축소 이미지의 픽셀 좌표(칸 번호 기준).
 */

export type P2 = [number, number];

// page_dewarp 의 상수 (작업용 축소 해상도 기준)
export const TEXT_MIN_WIDTH = 15;
export const TEXT_MIN_HEIGHT = 2;
export const TEXT_MIN_ASPECT = 1.5;
export const TEXT_MAX_THICKNESS = 10;
export const EDGE_MAX_OVERLAP = 1.0;
export const EDGE_MAX_LENGTH = 100.0;
export const EDGE_ANGLE_COST = 10.0;
export const EDGE_MAX_ANGLE = 7.5;
export const SPAN_MIN_WIDTH = 30;
export const SPAN_PX_PER_STEP = 20;

export interface Blob {
  /** 경계 상자 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 상자 안 채움 마스크 (0/1), 길이 w*h */
  mask: Uint8Array;
  center: P2;
  /** 주축 단위 벡터 (tx ≥ 0) */
  tangent: P2;
  /** 주축 각도 (rad, -π/2..π/2) */
  angle: number;
  /** 주축 위 범위 (중심 기준) */
  lxmin: number;
  lxmax: number;
  point0: P2;
  point1: P2;
  pred: Blob | null;
  succ: Blob | null;
}

/** 마스크 한 덩어리의 통계를 계산해 Blob 을 만든다. 픽셀이 없으면 null */
export function makeBlob(x: number, y: number, w: number, h: number, mask: Uint8Array): Blob | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (mask[j * w + i]) {
        n++;
        sx += i;
        sy += j;
      }
    }
  }
  if (n === 0) return null;
  const mx = sx / n;
  const my = sy / n;
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (mask[j * w + i]) {
        const dx = i - mx;
        const dy = j - my;
        mu20 += dx * dx;
        mu02 += dy * dy;
        mu11 += dx * dy;
      }
    }
  }
  const th = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  let tx = Math.cos(th);
  let ty = Math.sin(th);
  if (tx < 0) {
    tx = -tx;
    ty = -ty;
  }
  let lxmin = Infinity;
  let lxmax = -Infinity;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (mask[j * w + i]) {
        const p = (i - mx) * tx + (j - my) * ty;
        if (p < lxmin) lxmin = p;
        if (p > lxmax) lxmax = p;
      }
    }
  }
  const center: P2 = [x + mx, y + my];
  return {
    x,
    y,
    w,
    h,
    mask,
    center,
    tangent: [tx, ty],
    angle: Math.atan2(ty, tx),
    lxmin,
    lxmax,
    point0: [center[0] + tx * lxmin, center[1] + ty * lxmin],
    point1: [center[0] + tx * lxmax, center[1] + ty * lxmax],
    pred: null,
    succ: null,
  };
}

function projX(b: Blob, p: P2): number {
  return b.tangent[0] * (p[0] - b.center[0]) + b.tangent[1] * (p[1] - b.center[1]);
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function localOverlap(a: Blob, b: Blob): number {
  return overlap(a.lxmin, a.lxmax, projX(a, b.point0), projX(a, b.point1));
}

interface Edge {
  score: number;
  a: Blob;
  b: Blob;
}

function candidateEdge(ca: Blob, cb: Blob): Edge | null {
  let a = ca;
  let b = cb;
  // a 가 왼쪽, b 가 오른쪽
  if (a.point0[0] > b.point1[0]) {
    const t = a;
    a = b;
    b = t;
  }
  const overA = localOverlap(a, b);
  const overB = localOverlap(b, a);
  const deltaAngle = (Math.abs(a.angle - b.angle) * 180) / Math.PI;
  const xOverlap = Math.max(overA, overB);
  const dist = Math.hypot(b.point0[0] - a.point1[0], b.point0[1] - a.point1[1]);
  if (dist > EDGE_MAX_LENGTH || xOverlap > EDGE_MAX_OVERLAP || deltaAngle > EDGE_MAX_ANGLE) return null;
  return { score: dist + deltaAngle * EDGE_ANGLE_COST, a, b };
}

/** 덩어리를 좌우로 이어 줄(span)을 만든다. 너무 짧은 줄은 버린다 */
export function assembleSpans(blobs: Blob[]): Blob[][] {
  const list = [...blobs].sort((p, q) => p.y - q.y);
  const edges: Edge[] = [];
  for (let i = 0; i < list.length; i++) {
    const bi = list[i]!;
    for (let j = 0; j < i; j++) {
      const bj = list[j]!;
      // 가로로 멀리 떨어진 쌍은 계산하지 않고 거른다 (EDGE_MAX_LENGTH 의 두 배 + 상자 폭)
      const gap = Math.abs(bi.center[0] - bj.center[0]) - (bi.w + bj.w) / 2;
      if (gap > EDGE_MAX_LENGTH * 2) continue;
      const e = candidateEdge(bi, bj);
      if (e) edges.push(e);
    }
  }
  edges.sort((p, q) => p.score - q.score);
  for (const e of edges) {
    if (e.a.succ === null && e.b.pred === null) {
      e.a.succ = e.b;
      e.b.pred = e.a;
    }
  }
  const spans: Blob[][] = [];
  const used = new Set<Blob>();
  for (const start of list) {
    if (used.has(start)) continue;
    let cur: Blob | null = start;
    // 맨 앞으로 (순환 방지로 방문 검사)
    const seen = new Set<Blob>();
    while (cur.pred && !seen.has(cur.pred)) {
      seen.add(cur);
      cur = cur.pred;
    }
    const span: Blob[] = [];
    let width = 0;
    while (cur && !used.has(cur)) {
      used.add(cur);
      span.push(cur);
      width += cur.lxmax - cur.lxmin;
      cur = cur.succ;
    }
    if (width > SPAN_MIN_WIDTH) spans.push(span);
  }
  return spans;
}

/**
 * 줄마다 일정 간격으로 점을 뽑는다. 각 덩어리의 열마다 "잉크 세로 평균 위치"를 점으로 쓴다.
 * 결과는 줄별 [x, y] 픽셀 좌표 배열 (왼쪽에서 오른쪽).
 */
export function sampleSpans(spans: Blob[][], step = SPAN_PX_PER_STEP): P2[][] {
  return spans.map((span) => {
    const pts: P2[] = [];
    for (const b of span) {
      const start = Math.floor(((b.w - 1) % step) / 2);
      for (let i = start; i < b.w; i += step) {
        let sum = 0;
        let cnt = 0;
        for (let j = 0; j < b.h; j++) {
          if (b.mask[j * b.w + i]) {
            sum += j;
            cnt++;
          }
        }
        if (cnt > 0) pts.push([b.x + i, b.y + sum / cnt]);
      }
    }
    return pts;
  });
}

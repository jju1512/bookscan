/**
 * 펴기의 순수 계산 (OpenCV 없음): Rodrigues 회전, 핀홀 투영, 3차 곡면.
 * mzucker/page_dewarp (MIT) 방식을 옮김 — https://github.com/mzucker/page_dewarp
 *
 * 좌표 약속
 * - 정규화 좌표: 이미지 중심이 원점, 긴 변이 [-1, 1] 이 되는 배율(2/긴 변). 원본의 pix2norm/norm2pix 와 같다.
 * - 페이지 좌표 (x, y): 펴진 종이 위의 평면 좌표. 곡면 높이 z 는 x 만의 3차 다항식이다.
 * - 전역 변수 g = [rx, ry, rz, tx, ty, tz, α, β] (회전 벡터, 이동, 곡면 양 끝 기울기).
 */

export const FOCAL_LENGTH = 1.2;

/** 전역 변수 개수: rvec 3 + tvec 3 + 곡면 기울기 2 */
export const GLOBAL_COUNT = 8;

/** 화면 좌표 → 정규화 좌표 배율 */
export function normScale(width: number, height: number): number {
  return 2 / Math.max(width, height);
}

export function pixToNorm(width: number, height: number, x: number, y: number): [number, number] {
  const s = normScale(width, height);
  return [(x - width * 0.5) * s, (y - height * 0.5) * s];
}

export function normToPix(width: number, height: number, u: number, v: number): [number, number] {
  const s = normScale(width, height);
  return [u / s + width * 0.5, v / s + height * 0.5];
}

/** 회전 벡터 → 3×3 회전 행렬 (행 우선, 길이 9). cv.Rodrigues 와 같은 규약 */
export function rodrigues(r: ArrayLike<number>, out: Float64Array = new Float64Array(9)): Float64Array {
  const rx = r[0]!;
  const ry = r[1]!;
  const rz = r[2]!;
  const th = Math.hypot(rx, ry, rz);
  if (th < 1e-12) {
    out.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    return out;
  }
  const kx = rx / th;
  const ky = ry / th;
  const kz = rz / th;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const v = 1 - c;
  out[0] = c + kx * kx * v;
  out[1] = kx * ky * v - kz * s;
  out[2] = kx * kz * v + ky * s;
  out[3] = ky * kx * v + kz * s;
  out[4] = c + ky * ky * v;
  out[5] = ky * kz * v - kx * s;
  out[6] = kz * kx * v - ky * s;
  out[7] = kz * ky * v + kx * s;
  out[8] = c + kz * kz * v;
  return out;
}

/** 3차 곡면의 다항식 계수 (높은 차수부터): z(x) = (α+β)x³ − (2α+β)x² + αx. z(0)=z(1)=0, 기울기 z'(0)=α, z'(1)=β */
export function cubicCoefficients(alpha: number, beta: number): [number, number, number, number] {
  return [alpha + beta, -2 * alpha - beta, alpha, 0];
}

/** 다항식 값 (np.polyval 과 같은 차수 순서, Horner) */
export function polyval(coef: ArrayLike<number>, x: number): number {
  let y = 0;
  for (let i = 0; i < coef.length; i++) y = y * x + coef[i]!;
  return y;
}

/**
 * 페이지 점 (x, y) 를 전역 변수 g 로 투영한다 (곡면 높이 포함). 결과는 정규화 좌표 [u, v].
 * 카메라 뒤(z ≤ 0)면 NaN.
 */
export function projectPagePoint(g: ArrayLike<number>, x: number, y: number, out: Float64Array, o = 0): void {
  const R = rodrigues(g);
  projectWithPose(R, g, x, y, out, o);
}

/** 이미 계산한 회전 행렬 R 로 투영한다 (g 의 3~5 번이 이동, 6·7 번이 α·β). 여러 점을 한꺼번에 투영할 때 쓴다 */
export function projectWithPose(R: Float64Array, g: ArrayLike<number>, x: number, y: number, out: Float64Array, o = 0): void {
  const alpha = g[6]!;
  const beta = g[7]!;
  // 계수를 풀어 쓴 Horner: ((α+β)x − (2α+β))x + α) x
  const z = (((alpha + beta) * x - (2 * alpha + beta)) * x + alpha) * x;
  const X = R[0]! * x + R[1]! * y + R[2]! * z + g[3]!;
  const Y = R[3]! * x + R[4]! * y + R[5]! * z + g[4]!;
  const Z = R[6]! * x + R[7]! * y + R[8]! * z + g[5]!;
  if (!(Z > 1e-9)) {
    out[o] = NaN;
    out[o + 1] = NaN;
    return;
  }
  out[o] = (FOCAL_LENGTH * X) / Z;
  out[o + 1] = (FOCAL_LENGTH * Y) / Z;
}

/** 임의의 3D 점을 투영한다 (cv.projectPoints 와 비교하는 시험용). 왜곡 없음, 주점 (0,0) */
export function projectPoints3D(rvec: ArrayLike<number>, tvec: ArrayLike<number>, pts: ArrayLike<number>, f = FOCAL_LENGTH): Float64Array {
  const R = rodrigues(rvec);
  const n = pts.length / 3;
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3]!;
    const y = pts[i * 3 + 1]!;
    const z = pts[i * 3 + 2]!;
    const X = R[0]! * x + R[1]! * y + R[2]! * z + tvec[0]!;
    const Y = R[3]! * x + R[4]! * y + R[5]! * z + tvec[1]!;
    const Z = R[6]! * x + R[7]! * y + R[8]! * z + tvec[2]!;
    out[i * 2] = (f * X) / Z;
    out[i * 2 + 1] = (f * Y) / Z;
  }
  return out;
}

/**
 * 평면(z=0) 투영의 역변환: 정규화 이미지 좌표 (u, v) → 페이지 좌표 (x, y).
 * 평면 투영은 호모그래피 H = [[f·R00, f·R01, f·tx], [f·R10, f·R11, f·ty], [R20, R21, tz]] 이므로 3×3 역행렬로 푼다.
 * 반환 함수가 특이(역행렬 없음)이면 null.
 */
export function makeFlatUnprojector(g: ArrayLike<number>): ((u: number, v: number, out: Float64Array) => void) | null {
  const R = rodrigues(g);
  const f = FOCAL_LENGTH;
  const a = f * R[0]!, b = f * R[1]!, c = f * g[3]!;
  const d = f * R[3]!, e = f * R[4]!, h = f * g[4]!;
  const p = R[6]!, q = R[7]!, r = g[5]!;
  const det = a * (e * r - h * q) - b * (d * r - h * p) + c * (d * q - e * p);
  if (!(Math.abs(det) > 1e-12)) return null;
  // 여인수 행렬의 전치 / det
  const i00 = (e * r - h * q) / det, i01 = (c * q - b * r) / det, i02 = (b * h - c * e) / det;
  const i10 = (h * p - d * r) / det, i11 = (a * r - c * p) / det, i12 = (c * d - a * h) / det;
  const i20 = (d * q - e * p) / det, i21 = (b * p - a * q) / det, i22 = (a * e - b * d) / det;
  return (u, v, out) => {
    const w = i20 * u + i21 * v + i22;
    out[0] = (i00 * u + i01 * v + i02) / w;
    out[1] = (i10 * u + i11 * v + i12) / w;
  };
}

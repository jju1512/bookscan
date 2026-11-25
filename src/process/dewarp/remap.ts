/**
 * 리매핑: 곡면의 "들림"만 되돌려 원래 이미지 틀에 다시 그린다 (OpenCV 는 cv.remap 에만 쓴다).
 * mzucker/page_dewarp (MIT) 방식을 옮김 — https://github.com/mzucker/page_dewarp
 *
 * 원본과 다른 점 (중요)
 * - 원본은 출력을 "페이지 좌표(x, y)의 직사각형"으로 그린다. 원본 입력은 비스듬히 찍은 사진이라 맞춘 카메라 자세가
 *   진짜 자세이기 때문이다. 이 앱은 자르기 단계가 페이지를 이미 정면(원근 보정)으로 펴 놓은 이미지를 넣는다.
 *   그러면 맞춘 기울기(rvec)는 "줄 변위를 설명하는 값"일 뿐 진짜 카메라 자세가 아니어서, 페이지 좌표로 그리면
 *   멀쩡한 이미지에 원근 왜곡이 다시 생긴다(시험으로 확인함).
 * - 그래서 출력 픽셀 q 마다 "평평했다면 q 에 투영될 페이지 점 (x, y)"를 평면 투영의 역변환으로 구하고,
 *   그 점이 곡면 위에서 실제로 투영되는 위치 P(x, y, z(x)) 의 이미지를 가져온다. 곡면이 평평하면(z=0) 출력은 입력과 같다.
 *   출력 크기는 입력과 같고, 페이지 크기 추정은 하지 않는다.
 * - 성긴 격자(decimate 간격)를 계산한 뒤 cv.resize 대신 JS 로 쌍선형 보간해서 좌표 맵을 만든다. 줄 단위(밴드)로
 *   나눠 처리하므로 큰 이미지에서도 메모리를 크게 쓰지 않는다.
 * - 마지막 흑백 임계값 처리는 하지 않는다(화질 보정 단계가 따로 있다). 컬러 RGBA 로 낸다.
 */
import { del, type CV, type Raster } from '../raster';
import { makeFlatUnprojector, normToPix, pixToNorm, projectWithPose, rodrigues } from './math';

export interface RemapGeometry {
  /** 전역 변수 [rvec, tvec, α, β] */
  globals: ArrayLike<number>;
  /** 작업용 축소 이미지 크기 (정규화 기준) */
  smallW: number;
  smallH: number;
}

export interface RemapOptions {
  /** 좌표 맵을 이 간격(px)으로 성기게 계산한다 */
  decimate?: number;
  /** 한 번에 처리하는 출력 줄 수 */
  bandRows?: number;
  /** 원래 위치에서 가장 멀리 가져오는 거리의 상한 (긴 변에 대한 비율). 넘으면 비정상으로 본다 */
  maxShift?: number;
  /** 가장 멀리 가져오는 거리가 이보다 작으면 평평한 페이지로 보고 리매핑하지 않는다 (px, 기본 0 = 항상 리매핑) */
  minShiftPx?: number;
}

/** flat: 변위가 너무 작아 할 필요가 없음(실패가 아님) */
export type RemapResult = { ok: true; raster: Raster; maxShiftPx: number } | { ok: false; reason: string; flat?: boolean };

export function remapPage(cv: CV, src: Raster, geo: RemapGeometry, opts: RemapOptions = {}): RemapResult {
  const decimate = opts.decimate ?? 12;
  const bandRows = opts.bandRows ?? 256;
  const maxShift = (opts.maxShift ?? 0.15) * Math.max(src.width, src.height);
  const outW = src.width;
  const outH = src.height;
  if (outW < 16 || outH < 16) return { ok: false, reason: `이미지가 너무 작음 (${outW}×${outH})` };

  const unproject = makeFlatUnprojector(geo.globals);
  if (!unproject) return { ok: false, reason: '평면 투영이 특이해 되돌릴 수 없음' };

  // 성긴 격자: 노드 i ↔ 출력 가장자리 좌표 i/(gw-1)·outW (칸 번호 좌표로는 −0.5)
  const gw = Math.ceil(outW / decimate) + 1;
  const gh = Math.ceil(outH / decimate) + 1;
  const mapX = new Float32Array(gw * gh);
  const mapY = new Float32Array(gw * gh);
  const R = rodrigues(geo.globals);
  const xy = new Float64Array(2);
  const uv = new Float64Array(2);
  // 원본 칸 번호 좌표 ↔ 작은 이미지 칸 번호 좌표
  const sx = geo.smallW / src.width;
  const sy = geo.smallH / src.height;
  let worst = 0;
  for (let j = 0; j < gh; j++) {
    const oy = (j / (gh - 1)) * outH - 0.5;
    for (let i = 0; i < gw; i++) {
      const ox = (i / (gw - 1)) * outW - 0.5;
      const [qu, qv] = pixToNorm(geo.smallW, geo.smallH, (ox + 0.5) * sx - 0.5, (oy + 0.5) * sy - 0.5);
      unproject(qu, qv, xy);
      projectWithPose(R, geo.globals, xy[0]!, xy[1]!, uv);
      if (!Number.isFinite(uv[0]!) || !Number.isFinite(uv[1]!) || !Number.isFinite(xy[0]!)) return { ok: false, reason: '페이지 일부가 카메라 뒤로 투영됨' };
      const [px, py] = normToPix(geo.smallW, geo.smallH, uv[0]!, uv[1]!);
      const mx = (px + 0.5) / sx - 0.5;
      const my = (py + 0.5) / sy - 0.5;
      mapX[j * gw + i] = mx;
      mapY[j * gw + i] = my;
      worst = Math.max(worst, Math.hypot(mx - ox, my - oy));
    }
  }
  if (worst > maxShift) return { ok: false, reason: `펴는 변위가 비정상으로 큼 (${Math.round(worst)}px)` };
  if (worst < (opts.minShiftPx ?? 0)) return { ok: false, flat: true, reason: '곡면이 거의 없어 펴기를 건너뜀 (평평한 페이지)' };

  const out = new Uint8ClampedArray(outW * outH * 4);
  const srcMat = new cv.Mat(src.height, src.width, cv.CV_8UC4);
  try {
    srcMat.data.set(src.data);
    for (let y0 = 0; y0 < outH; y0 += bandRows) {
      const bh = Math.min(bandRows, outH - y0);
      const mx = new cv.Mat(bh, outW, cv.CV_32FC1);
      const my = new cv.Mat(bh, outW, cv.CV_32FC1);
      const dst = new cv.Mat();
      try {
        const fx = mx.data32F as Float32Array;
        const fy = my.data32F as Float32Array;
        for (let r = 0; r < bh; r++) {
          const t = ((y0 + r + 0.5) / outH) * (gh - 1);
          const j0 = Math.min(gh - 2, Math.max(0, Math.floor(t)));
          const wy = t - j0;
          for (let X = 0; X < outW; X++) {
            const s = ((X + 0.5) / outW) * (gw - 1);
            const i0 = Math.min(gw - 2, Math.max(0, Math.floor(s)));
            const wx = s - i0;
            const a = j0 * gw + i0;
            const b = a + gw;
            const w00 = (1 - wx) * (1 - wy);
            const w10 = wx * (1 - wy);
            const w01 = (1 - wx) * wy;
            const w11 = wx * wy;
            const o = r * outW + X;
            fx[o] = mapX[a]! * w00 + mapX[a + 1]! * w10 + mapX[b]! * w01 + mapX[b + 1]! * w11;
            fy[o] = mapY[a]! * w00 + mapY[a + 1]! * w10 + mapY[b]! * w01 + mapY[b + 1]! * w11;
          }
        }
        cv.remap(srcMat, dst, mx, my, cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
        out.set(dst.data as Uint8Array, y0 * outW * 4);
      } finally {
        del(mx, my, dst);
      }
    }
  } finally {
    del(srcMat);
  }
  return { ok: true, raster: { width: outW, height: outH, data: out }, maxShiftPx: worst };
}

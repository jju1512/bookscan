/**
 * 후처리 단계가 주고받는 이미지 (RGBA 픽셀). ImageData 와 같은 모양이라 브라우저·Node 테스트에서 함께 쓴다.
 * Blob ↔ Raster 변환은 브라우저 전용 함수(decodeToRaster, encodeRaster)로 따로 둔다.
 */

export interface Raster {
  width: number;
  height: number;
  /** RGBA, 길이 width*height*4 */
  data: Uint8ClampedArray;
}

/** OpenCV.js 모듈. 타입 정의가 매우 커서 타입 검사를 느리게 하므로 느슨하게 쓴다 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

export function createRaster(width: number, height: number, fill?: [number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
      data[i + 2] = fill[2];
      data[i + 3] = 255;
    }
  } else {
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
  }
  return { width, height, data };
}

/** 긴 변이 maxEdge 를 넘지 않게 줄일 배율 (늘리지 않는다) */
export function scaleToFit(width: number, height: number, maxEdge: number): number {
  const long = Math.max(width, height);
  return long > maxEdge ? maxEdge / long : 1;
}

/** Raster → cv.Mat (CV_8UC4). 반드시 호출한 쪽에서 delete() */
export function rasterToMat(cv: CV, r: Raster) {
  const m = new cv.Mat(r.height, r.width, cv.CV_8UC4);
  m.data.set(r.data);
  return m;
}

/** cv.Mat → Raster. 1·3·4 채널 모두 받는다. 넘긴 Mat 은 지우지 않는다 */
export function matToRaster(cv: CV, m: { rows: number; cols: number; channels(): number; data: Uint8Array }): Raster {
  const ch = m.channels();
  let rgba = m;
  let tmp = null;
  if (ch !== 4) {
    tmp = new cv.Mat();
    cv.cvtColor(m, tmp, ch === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
    rgba = tmp;
  }
  const out: Raster = { width: rgba.cols, height: rgba.rows, data: new Uint8ClampedArray(rgba.data) };
  tmp?.delete();
  return out;
}

/** Mat 여러 개를 한 번에 지운다 (try/finally 에서 쓴다) */
export function del(...mats: Array<{ delete(): void; isDeleted?: () => boolean } | null | undefined>): void {
  for (const m of mats) {
    try {
      if (m && !(m.isDeleted?.() ?? false)) m.delete();
    } catch {
      // 이미 지워진 Mat
    }
  }
}

/** 브라우저(worker 포함): Blob → Raster, 긴 변 maxEdge 로 줄이며 디코드 */
export async function decodeToRaster(blob: Blob, maxEdge: number): Promise<Raster> {
  const probe = await createImageBitmap(blob);
  const s = scaleToFit(probe.width, probe.height, maxEdge);
  let bmp = probe;
  if (s < 1) {
    probe.close();
    bmp = await createImageBitmap(blob, { resizeWidth: Math.round(probe.width * s), resizeHeight: Math.round(probe.height * s), resizeQuality: 'high' });
  }
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { width: img.width, height: img.height, data: img.data };
}

/** 브라우저(worker 포함): Raster → JPEG Blob */
export async function encodeRaster(r: Raster, quality = 0.9): Promise<Blob> {
  const c = new OffscreenCanvas(r.width, r.height);
  const ctx = c.getContext('2d')!;
  ctx.putImageData(new ImageData(r.data as unknown as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

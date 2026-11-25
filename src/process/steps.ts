/**
 * 오픈소스 구현의 단계 객체 (SPEC 8장 인터페이스 run(input, meta) => {image, meta}).
 * worker 안에서 OpenCV 를 받아 만든다. 결과 meta.outcome 에 판정(done/skipped/failed)과 메모를 담는다.
 * AI 구현(Phase 4)은 같은 ProcessStep 모양으로 만들어 이 표의 항목만 바꿔 끼우면 된다.
 */
import { cropPage } from './crop/crop';
import { dewarpPage } from './dewarp/dewarp';
import { enhancePage } from './enhance/enhance';
import { removeFingers } from './finger/finger';
import { decodeToRaster, encodeRaster, type CV, type Raster } from './raster';
import type { ProcessStep, StepMeta, StepName, StepOutcome } from './step';

export type ImageStepName = Exclude<StepName, 'ocr'>;

export interface StepEnv {
  maxEdge: number;
  jpegQuality?: number;
}

export function createSteps(cv: CV, env: StepEnv): Record<ImageStepName, ProcessStep> {
  const q = env.jpegQuality ?? 0.9;
  const decode = async (input: ImageBitmap | Blob): Promise<Raster> => {
    if (input instanceof Blob) return decodeToRaster(input, env.maxEdge);
    const c = new OffscreenCanvas(input.width, input.height);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(input, 0, 0);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    return { width: img.width, height: img.height, data: img.data };
  };
  const make = (name: ImageStepName, fn: (r: Raster, meta: StepMeta) => { raster: Raster | null; meta: Record<string, unknown>; outcome: StepOutcome }): ProcessStep => ({
    name,
    impl: 'opensource',
    async run(input, meta) {
      const r = await decode(input);
      const res = fn(r, meta);
      const image = res.raster ? await encodeRaster(res.raster, q) : null;
      return { image, meta: { ...meta, ...res.meta, outcome: res.outcome, width: res.raster?.width ?? r.width, height: res.raster?.height ?? r.height } };
    },
  });

  return {
    crop: make('crop', (r, meta) => {
      const res = cropPage(cv, r, {
        side: (meta.side as 'left' | 'right' | 'single') ?? 'single',
        manual: meta.manual as { corners?: number[]; splitX?: number } | undefined,
      });
      return {
        raster: res.raster,
        meta: { corners: res.corners, splitX: res.splitX, found: res.found, method: res.method },
        outcome: res.found ? { state: 'done', note: res.method === 'manual' ? '수동 보정값 사용' : undefined } : { state: 'failed', note: res.note },
      };
    }),
    finger: make('finger', (r) => {
      const res = removeFingers(cv, r);
      const filled = res.regions.filter((x) => x.action !== 'overText').length;
      const note = res.overText
        ? '손가락이 본문 글자를 덮고 있습니다 (지우지 않고 표시만 함). 다시 찍는 것을 권합니다.'
        : filled
          ? `손가락 ${filled}곳을 지웠습니다`
          : undefined;
      return { raster: res.changed ? res.raster : null, meta: { regions: res.regions, overText: res.overText }, outcome: { state: 'done', note } };
    }),
    dewarp: make('dewarp', (r) => {
      const res = dewarpPage(cv, r);
      if (res.skipped) return { raster: null, meta: { ...res.meta }, outcome: { state: 'skipped', note: res.reason } };
      return { raster: res.raster, meta: { ...res.meta }, outcome: { state: 'done' } };
    }),
    enhance: make('enhance', (r, meta) => {
      const res = enhancePage(cv, r, { binarize: meta.binarize === true });
      return { raster: res.raster, meta: { backgroundBefore: res.backgroundBefore, backgroundAfter: res.backgroundAfter }, outcome: { state: 'done' } };
    }),
  };
}

/** Node 테스트용 OpenCV.js 와 fixture 읽기 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CV, Raster } from '../../src/process/raster';
import { loadPng, savePng } from '../synthetic/raster.ts';

let cvp: Promise<CV> | null = null;

/** ★ Emscripten 모듈은 thenable 이라 await 하면 끝나지 않는다. onRuntimeInitialized 를 기다리고 then 을 지운다 */
export function loadCv(): Promise<CV> {
  cvp ??= new Promise((resolve) => {
    const cv = createRequire(import.meta.url)('@techstark/opencv-js');
    const done = () => {
      delete cv.then;
      resolve(cv);
    };
    if (cv.Mat) done();
    else cv.onRuntimeInitialized = done;
  });
  return cvp;
}

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'synthetic');
export const OUT = join(FIXTURES, 'out');

export function fixture(name: string): { raster: Raster; truth: Record<string, unknown> & { [k: string]: any } } {
  const img = loadPng(join(FIXTURES, `${name}.png`));
  const truth = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
  return { raster: { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }, truth };
}

/** 눈으로 보려고 결과를 out/ 에 쓴다 (gitignore) */
export function writeOut(name: string, r: Raster): void {
  try {
    savePng(join(OUT, `${name}.png`), { width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) });
  } catch {
    // 쓰기 실패는 테스트 실패가 아니다
  }
}

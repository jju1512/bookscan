import { describe, expect, it } from 'vitest';
import { FrameAnalyzer, diffRatio, gaussianBlur5, laplacianVariance, resizeGray, rgbaToGray, type GrayFrame } from '../src/capture/analysis';
import { analysisSize } from '../src/capture/analyzerClient';
import { photoFallbackReason, parseJpegSize } from '../src/camera/shoot';

function frame(w: number, h: number, fn: (x: number, y: number) => number): GrayFrame {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fn(x, y);
  return { width: w, height: h, data };
}

describe('프레임 분석', () => {
  it('RGBA → 흑백', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const g = rgbaToGray(rgba, 3, 1);
    expect(g.data[0]).toBeGreaterThanOrEqual(254);
    expect(g.data[1]).toBe(0);
    expect(g.data[2]).toBeGreaterThan(70);
    expect(g.data[2]).toBeLessThan(80);
  });

  it('블러는 평평한 면을 바꾸지 않고 날카로운 경계를 부드럽게 한다', () => {
    const flat = frame(10, 10, () => 100);
    expect([...gaussianBlur5(flat).data].every((v) => v === 100)).toBe(true);
    const edge = frame(10, 1, (x) => (x < 5 ? 0 : 255));
    const b = gaussianBlur5(edge).data;
    expect(b[4]).toBeGreaterThan(0);
    expect(b[5]).toBeLessThan(255);
  });

  it('diffRatio: 임계값보다 크게 바뀐 픽셀 비율', () => {
    const a = frame(10, 10, () => 100);
    const b = frame(10, 10, (x) => (x < 3 ? 140 : 110));
    expect(diffRatio(a, b, 25)).toBeCloseTo(0.3);
    expect(diffRatio(a, frame(5, 5, () => 0), 25)).toBe(1);
  });

  it('라플라시안 분산: 선명한 무늬 > 흐린 무늬 > 평평한 면', () => {
    const sharp = frame(64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 255 : 0);
    const blurred = gaussianBlur5(gaussianBlur5(sharp));
    const flat = frame(64, 64, () => 128);
    expect(laplacianVariance(sharp)).toBeGreaterThan(laplacianVariance(blurred));
    expect(laplacianVariance(blurred)).toBeGreaterThan(laplacianVariance(flat));
    expect(laplacianVariance(flat)).toBe(0);
  });

  it('FrameAnalyzer: 첫 프레임 motion=1, 기준 없으면 change=1, setReference 뒤 같은 장면이면 change≈0', () => {
    const a = new FrameAnalyzer(25);
    const f1 = frame(32, 24, (x) => x * 8);
    let m = a.analyze(f1);
    expect(m.motion).toBe(1);
    expect(m.change).toBe(1);
    m = a.analyze(f1);
    expect(m.motion).toBe(0);
    a.setReference();
    m = a.analyze(f1);
    expect(m.change).toBe(0);
    const f2 = frame(32, 24, (x) => 255 - x * 8);
    m = a.analyze(f2);
    expect(m.change).toBeGreaterThan(0.5);
  });

  it('썸네일로 기준 프레임을 정하면 크기를 맞춘다', () => {
    const a = new FrameAnalyzer(25);
    const big = frame(64, 48, (x, y) => (x + y) * 2);
    a.setReferenceFrom(big, 32, 24);
    const m = a.analyze(resizeGray(big, 32, 24));
    expect(m.change).toBeLessThan(0.02);
  });

  it('분석 크기: 가로 ANALYSIS_WIDTH, 비율 유지, 짝수 높이', () => {
    expect(analysisSize(4096, 3072, 320)).toEqual({ width: 320, height: 240 });
    expect(analysisSize(1920, 1080, 320)).toEqual({ width: 320, height: 180 });
    expect(analysisSize(200, 100, 320)).toEqual({ width: 200, height: 100 });
  });
});

describe('촬영 방식 전환 (auto)', () => {
  it('1초 초과, 실패, 미리보기 끊김이면 스트림 프레임으로', () => {
    expect(photoFallbackReason({ ms: 400, maxFrameGapMs: 100 })).toBeNull();
    expect(photoFallbackReason({ ms: 1001, maxFrameGapMs: 100 })).toMatch('1초');
    expect(photoFallbackReason({ ms: 400, maxFrameGapMs: 700 })).toMatch('끊김');
    expect(photoFallbackReason({ ms: 0, maxFrameGapMs: 0, error: new Error('x') })).toMatch('실패');
  });

  it('JPEG 헤더에서 크기와 EXIF 방향을 읽는다', () => {
    // SOI, APP1(Exif, orientation=6), SOF0(높이 3000, 폭 4000)
    const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
    const app1 = [0xff, 0xe1, 0, exif.length + 2, ...exif];
    const sof = [0xff, 0xc0, 0, 17, 8, 0x0b, 0xb8, 0x0f, 0xa0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const jpeg = new Uint8Array([0xff, 0xd8, ...app1, ...sof]);
    expect(parseJpegSize(jpeg)).toEqual({ width: 3000, height: 4000 });
    const plain = new Uint8Array([0xff, 0xd8, ...sof]);
    expect(parseJpegSize(plain)).toEqual({ width: 4000, height: 3000 });
    expect(parseJpegSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

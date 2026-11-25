/**
 * 고해상도 촬영 (SPEC 6장 "카메라와 촬영").
 * - photo: ImageCapture.takePhoto()
 * - frame: 최대 해상도 스트림의 현재 프레임을 캔버스로 떠서 JPEG 로
 * - auto : photo 를 쓰다가 1초를 넘기거나, 실패하거나, 미리보기가 끊기면 이번 세션은 frame 으로 바꾼다
 */
import type { CaptureMethod } from '../config/settings';
import { log } from '../debug/log';
import type { OpenCamera } from './camera';

export interface Shot {
  blob: Blob;
  width: number;
  height: number;
  method: 'photo' | 'frame';
  ms: number;
}

/** takePhoto 가 이보다 오래 걸리면 auto 는 frame 으로 바꾼다 (SPEC: 1초) */
export const PHOTO_SLOW_MS = 1000;
/** takePhoto 도중 미리보기 프레임 간격이 이보다 길면 "끊김"으로 본다 */
export const PREVIEW_STALL_MS = 600;
export const JPEG_QUALITY = 0.92;

interface ImageCaptureLike {
  takePhoto(settings?: Record<string, unknown>): Promise<Blob>;
}
type ImageCaptureCtor = new (t: MediaStreamTrack) => ImageCaptureLike;

export function hasImageCapture(): boolean {
  return typeof (globalThis as { ImageCapture?: unknown }).ImageCapture === 'function';
}

/** auto 모드에서 photo 를 그만 쓸 이유. 없으면 null (순수 함수, 테스트 대상) */
export function photoFallbackReason(r: { ms: number; maxFrameGapMs: number; error?: unknown }): string | null {
  if (r.error) return 'takePhoto 실패';
  if (r.ms > PHOTO_SLOW_MS) return `takePhoto ${Math.round(r.ms)}ms (1초 초과)`;
  if (r.maxFrameGapMs > PREVIEW_STALL_MS) return `takePhoto 중 미리보기 ${Math.round(r.maxFrameGapMs)}ms 끊김`;
  return null;
}

export class Shooter {
  private imageCapture: ImageCaptureLike | null = null;
  /** auto 모드에서 frame 으로 바꿨는가 (이번 세션 동안 유지) */
  private fellBack = false;
  private lastFrameAt = performance.now();
  private maxGap = 0;
  private watching = false;
  private stopWatch: (() => void) | null = null;
  fallbackReason: string | null = null;

  constructor(
    private readonly cam: OpenCamera,
    private readonly video: HTMLVideoElement,
    private readonly method: () => CaptureMethod,
  ) {
    const Ctor = (globalThis as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
    if (Ctor) {
      try {
        this.imageCapture = new Ctor(cam.track);
      } catch {
        this.imageCapture = null;
      }
    }
    this.startFrameWatch();
  }

  /** 지금 쓸 방식 */
  effectiveMethod(): 'photo' | 'frame' {
    const m = this.method();
    if (m === 'frame' || !this.imageCapture) return 'frame';
    if (m === 'photo') return 'photo';
    return this.fellBack ? 'frame' : 'photo';
  }

  async shoot(): Promise<Shot> {
    const method = this.effectiveMethod();
    if (method === 'photo') {
      const t0 = performance.now();
      this.maxGap = 0;
      this.lastFrameAt = t0;
      this.watching = true;
      try {
        const blob = await this.imageCapture!.takePhoto();
        const ms = performance.now() - t0;
        this.watching = false;
        const gap = Math.max(this.maxGap, performance.now() - this.lastFrameAt);
        const dims = (await jpegSize(blob)) ?? { width: 0, height: 0 };
        if (this.method() === 'auto') {
          const reason = photoFallbackReason({ ms, maxFrameGapMs: gap });
          if (reason) this.switchToFrame(reason);
        }
        return { blob, width: dims.width, height: dims.height, method, ms };
      } catch (e) {
        this.watching = false;
        if (this.method() === 'photo') throw e;
        this.switchToFrame(photoFallbackReason({ ms: 0, maxFrameGapMs: 0, error: e }) ?? 'takePhoto 실패');
        log.warn('takePhoto 실패, 프레임 캡처로 다시 찍습니다', e);
        return this.shootFrame();
      }
    }
    return this.shootFrame();
  }

  private switchToFrame(reason: string): void {
    if (this.fellBack) return;
    this.fellBack = true;
    this.fallbackReason = reason;
    log.warn(`촬영 방식을 스트림 프레임 캡처로 바꿉니다: ${reason}`);
  }

  private async shootFrame(): Promise<Shot> {
    const t0 = performance.now();
    const w = this.video.videoWidth;
    const h = this.video.videoHeight;
    if (!w || !h) throw new Error('미리보기가 아직 준비되지 않았습니다');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('캔버스를 만들 수 없습니다');
    ctx.drawImage(this.video, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 변환 실패'))), 'image/jpeg', JPEG_QUALITY),
    );
    canvas.width = canvas.height = 0;
    return { blob, width: w, height: h, method: 'frame', ms: performance.now() - t0 };
  }

  /** 미리보기 프레임 간격을 잰다 (takePhoto 가 미리보기를 끊는지 보려고) */
  private startFrameWatch(): void {
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (id: number) => void;
    };
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    let id = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const now = performance.now();
      if (this.watching) this.maxGap = Math.max(this.maxGap, now - this.lastFrameAt);
      this.lastFrameAt = now;
      id = v.requestVideoFrameCallback!(tick);
    };
    id = v.requestVideoFrameCallback(tick);
    this.stopWatch = () => {
      stopped = true;
      v.cancelVideoFrameCallback?.(id);
    };
  }

  dispose(): void {
    this.stopWatch?.();
  }

  get track(): MediaStreamTrack {
    return this.cam.track;
  }
}

/** 썸네일 JPEG (목록용, 긴 변 maxEdge) */
export async function makeThumbnail(blob: Blob, maxEdge = 400): Promise<{ thumb: Blob; width: number; height: number }> {
  const probe = await createImageBitmap(blob);
  const { width, height } = probe;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'medium';
  ctx.drawImage(probe, 0, 0, tw, th);
  probe.close();
  const thumb = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return { thumb, width, height };
}

/** JPEG 헤더(SOF)에서 크기를 읽는다. EXIF 방향 5~8 이면 가로·세로를 바꾼다. 실패하면 null */
export async function jpegSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 256 * 1024)).arrayBuffer());
  return parseJpegSize(head);
}

export function parseJpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  let orientation = 1;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (marker === 0xe1) orientation = exifOrientation(b, i + 4, len - 2) ?? orientation;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && i + 9 <= b.length) {
      const height = (b[i + 5]! << 8) | b[i + 6]!;
      const width = (b[i + 7]! << 8) | b[i + 8]!;
      return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function exifOrientation(b: Uint8Array, start: number, len: number): number | null {
  // "Exif\0\0" + TIFF 헤더
  if (start + 14 > b.length || b[start] !== 0x45 || b[start + 1] !== 0x78 || b[start + 2] !== 0x69 || b[start + 3] !== 0x66) return null;
  const t = start + 6;
  const le = b[t] === 0x49;
  const u16 = (o: number) => (le ? b[o]! | (b[o + 1]! << 8) : (b[o]! << 8) | b[o + 1]!);
  const u32 = (o: number) => (le ? (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0 : ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0);
  const ifd = t + u32(t + 4);
  if (ifd + 2 > Math.min(b.length, start + len)) return null;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > b.length) return null;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

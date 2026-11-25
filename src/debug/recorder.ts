/**
 * 세션 녹화 (SPEC 6장 디버그). 미리보기를 640px 캔버스로 줄여 MediaRecorder 로 녹화한다.
 * 카메라 스트림을 그대로 녹화하면 4K 라 휴대폰이 버거워하고, 재생 분석은 어차피 320px 로 줄인다.
 */
import { log } from './log';

export const RECORD_WIDTH = 640;
export const RECORD_FPS = 15;

export function pickRecorderMime(): string | undefined {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  if (typeof MediaRecorder === 'undefined') return undefined;
  return candidates.find((m) => MediaRecorder.isTypeSupported(m));
}

export class SessionRecorder {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private canvas: HTMLCanvasElement | null = null;
  private raf = 0;
  private startedAt = 0;

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  get elapsedMs(): number {
    return this.recording ? performance.now() - this.startedAt : 0;
  }

  start(video: HTMLVideoElement): void {
    if (this.recording) return;
    const mime = pickRecorderMime();
    if (!mime) throw new Error('이 브라우저는 MediaRecorder 녹화를 지원하지 않습니다');
    const w = RECORD_WIDTH;
    const h = Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * w / 2) * 2 || 480;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const draw = () => {
      if (video.readyState >= 2) ctx.drawImage(video, 0, 0, w, h);
      this.raf = requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(RECORD_FPS);
    this.chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    rec.start(1000);
    this.recorder = rec;
    this.canvas = canvas;
    this.startedAt = performance.now();
    log.info(`세션 녹화 시작 ${w}×${h} ${mime}`);
  }

  stop(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec) return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        cancelAnimationFrame(this.raf);
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'video/webm' });
        this.chunks = [];
        this.recorder = null;
        if (this.canvas) this.canvas.width = this.canvas.height = 0;
        this.canvas = null;
        log.info(`세션 녹화 끝 ${Math.round(blob.size / 1024)}KB`);
        resolve(blob);
      };
      rec.stop();
    });
  }
}

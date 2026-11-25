/**
 * 녹화 영상 재생 (SPEC 6장 "세션 녹화", 9장 "녹화 영상 재생 테스트").
 * 프레임을 하나씩 넣으면 실제 촬영과 같은 분석기·상태 머신으로 촬영 시점을 낸다.
 * ReplayRunner 는 순수 계산이라 단위 테스트에서 합성 프레임으로 돌리고, 브라우저에서는 replayVideo 로 영상을 먹인다.
 */
import type { Params } from '../config/params';
import { FrameAnalyzer, rgbaToGray, type GrayFrame } from './analysis';
import { captured, initialState, step, type MachineState, type Transition } from './machine';

export interface ReplaySample {
  t: number;
  motion: number;
  change: number;
  sharpness: number;
  state: MachineState['name'];
  shot?: boolean;
}

export interface ReplayResult {
  captures: { t: number; index: number }[];
  samples: ReplaySample[];
  transitions: Transition[];
}

export type ReplayParams = Pick<
  Params,
  'PIXEL_DIFF' | 'STILL' | 'MOVE' | 'MOVE_MS' | 'STABLE_MS' | 'CHANGE_MIN' | 'SHARP_RATIO' | 'MIN_INTERVAL_MS'
>;

export class ReplayRunner {
  private analyzer: FrameAnalyzer;
  private state: MachineState = initialState();
  private pending: { doneAt: number; sharpness: number } | null = null;
  private index = 0;
  readonly result: ReplayResult = { captures: [], samples: [], transitions: [] };

  /** latencyMs: 촬영·저장에 걸린다고 볼 시간 (그동안 CAPTURE 상태) */
  constructor(
    private readonly params: ReplayParams,
    private readonly latencyMs = 300,
  ) {
    this.analyzer = new FrameAnalyzer(params.PIXEL_DIFF);
  }

  /** gray: 블러 전 흑백 축소 프레임, t: ms */
  push(gray: GrayFrame, t: number): ReplaySample {
    if (this.pending && t >= this.pending.doneAt) {
      const r = captured(this.state, this.pending.doneAt, this.pending.sharpness);
      this.state = r.state;
      this.result.transitions.push(...r.transitions);
      this.pending = null;
    }
    const m = this.analyzer.analyze(gray);
    const r = step(this.state, { t, ...m }, this.params);
    this.state = r.state;
    this.result.transitions.push(...r.transitions);
    const sample: ReplaySample = { t, ...m, state: this.state.name };
    if (r.capture) {
      this.analyzer.setReference();
      this.result.captures.push({ t, index: this.index });
      this.pending = { doneAt: t + this.latencyMs, sharpness: m.sharpness };
      sample.shot = true;
    }
    this.result.samples.push(sample);
    this.index++;
    return sample;
  }
}

/**
 * 브라우저에서 녹화 영상(webm)을 재생하며 ANALYSIS_FPS 간격으로 프레임을 뽑아 ReplayRunner 에 넣는다.
 * MediaRecorder webm 은 탐색(seek)이 느리거나 부정확해서, 재생하면서 requestVideoFrameCallback 의 mediaTime 으로 뽑는다.
 */
export async function replayVideo(
  blob: Blob,
  params: Params,
  opts: { rate?: number; onProgress?: (t: number, duration: number) => void; signal?: AbortSignal } = {},
): Promise<ReplayResult> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  const url = URL.createObjectURL(blob);
  video.src = url;
  const runner = new ReplayRunner(params);
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('영상을 열 수 없습니다'));
    });
    const width = Math.min(params.ANALYSIS_WIDTH, video.videoWidth);
    const height = Math.max(2, Math.round((video.videoHeight * width) / video.videoWidth / 2) * 2);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const step = 1000 / params.ANALYSIS_FPS;
    let nextT = 0;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number };
    video.playbackRate = opts.rate ?? 1;
    await new Promise<void>((resolve, reject) => {
      const onFrame = (tMs: number) => {
        if (opts.signal?.aborted) {
          video.pause();
          reject(new DOMException('중단', 'AbortError'));
          return;
        }
        if (tMs + 0.5 >= nextT) {
          ctx.drawImage(video, 0, 0, width, height);
          const img = ctx.getImageData(0, 0, width, height);
          runner.push(rgbaToGray(img.data, width, height), tMs);
          nextT = tMs + step;
          opts.onProgress?.(tMs, (video.duration || 0) * 1000);
        }
      };
      if (typeof v.requestVideoFrameCallback === 'function') {
        const loop = (_now: number, meta: { mediaTime: number }) => {
          onFrame(meta.mediaTime * 1000);
          if (!video.ended) v.requestVideoFrameCallback!(loop);
        };
        v.requestVideoFrameCallback(loop);
      } else {
        const iv = setInterval(() => onFrame(video.currentTime * 1000), step / (opts.rate ?? 1));
        video.addEventListener('ended', () => clearInterval(iv));
      }
      video.onended = () => resolve();
      video.onerror = () => reject(new Error('재생 중 오류'));
      void video.play().catch(reject);
    });
    return runner.result;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

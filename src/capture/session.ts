/**
 * 촬영 세션: 미리보기 → 분석 worker → 상태 머신 → 고해상도 촬영 → 저장 (SPEC 3장 데이터 흐름 1·2).
 * 카메라 열기·화면은 scan 화면이 맡고, 이 클래스는 "언제 찍고 어떻게 저장하나"만 한다.
 */
import { makeThumbnail, Shooter, type Shot } from '../camera/shoot';
import { getParams } from '../config';
import { log } from '../debug/log';
import { busy } from '../storage/busy';
import type { Repo } from '../storage/repo';
import type { Capture } from '../storage/types';
import { AnalyzerClient, analysisSize } from './analyzerClient';
import {
  captured,
  captureFailed,
  initialState,
  manualCapture,
  pause,
  resume,
  step,
  type CaptureStateName,
  type MachineState,
  type StepResult,
  type Transition,
} from './machine';

export interface Sample {
  t: number;
  motion: number;
  change: number;
  sharpness: number;
  state: CaptureStateName;
  ms: number;
}

export interface SessionEvents {
  onState?(state: MachineState): void;
  onSample?(s: Sample): void;
  onTransition?(t: Transition): void;
  /** 저장(IndexedDB 커밋)까지 끝났을 때만 부른다 → 이때 피드백을 준다 */
  onCaptured?(c: Capture, shot: Shot): void;
  onCaptureError?(e: unknown): void;
}

export class CaptureSession {
  private analyzer = new AnalyzerClient();
  private state: MachineState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private capturing = false;
  private t0 = performance.now();
  private lastSample: Sample | null = null;
  private shooter: Shooter | null = null;
  private video: HTMLVideoElement | null = null;
  /** 재촬영할 촬영 ID (한 장 찍으면 끝) */
  replaceCaptureId?: string;

  constructor(
    private readonly repo: Repo,
    private readonly bookId: string,
    private readonly events: SessionEvents,
    opts: { hasReference?: boolean; sharpHistory?: number[]; replaceCaptureId?: string } = {},
  ) {
    this.state = initialState({ hasReference: opts.hasReference, sharpHistory: opts.sharpHistory });
    this.replaceCaptureId = opts.replaceCaptureId;
  }

  get current(): MachineState {
    return this.state;
  }

  get last(): Sample | null {
    return this.lastSample;
  }

  get method(): 'photo' | 'frame' | null {
    return this.shooter?.effectiveMethod() ?? null;
  }

  /** 이전 세션의 마지막 촬영 썸네일을 기준 프레임으로 쓴다 (새로고침 뒤 같은 페이지를 또 찍지 않게) */
  async loadReference(thumb: Blob, videoW: number, videoH: number): Promise<boolean> {
    try {
      const bmp = await createImageBitmap(thumb);
      // 썸네일과 미리보기 비율이 다르면(takePhoto 화각 차이) 기준으로 못 쓴다
      if (Math.abs(bmp.width / bmp.height - videoW / videoH) > 0.02) {
        bmp.close();
        return false;
      }
      const { width, height } = analysisSize(videoW, videoH, getParams().ANALYSIS_WIDTH);
      this.analyzer.setReferenceFrom(bmp, width, height);
      this.state = { ...this.state, firstShot: false };
      return true;
    } catch {
      return false;
    }
  }

  /** 카메라가 열린 뒤 부른다. 탭 복귀로 카메라를 다시 열면 다시 부른다 */
  attach(video: HTMLVideoElement, shooter: Shooter): void {
    this.video = video;
    this.shooter?.dispose();
    this.shooter = shooter;
    this.analyzer.resetMotion();
    if (!this.running) {
      this.running = true;
      this.schedule(0);
    }
  }

  /** 카메라를 놓을 때 (탭 숨김). 상태 머신은 PAUSED 로 */
  detach(reason: string): void {
    this.apply(pause(this.state, this.now(), reason));
    this.shooter?.dispose();
    this.shooter = null;
    this.video = null;
  }

  pause(): void {
    this.apply(pause(this.state, this.now()));
  }

  resume(): void {
    this.analyzer.resetMotion();
    this.apply(resume(this.state, this.now()));
  }

  /** 화면 탭 → 즉시 촬영 */
  manual(): void {
    if (this.capturing || !this.shooter) return;
    const wasPaused = this.state.name === 'PAUSED';
    const r = manualCapture(this.state, this.now());
    this.apply(r);
    if (r.capture) void this.doCapture(true, wasPaused);
  }

  dispose(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.shooter?.dispose();
    this.analyzer.terminate();
  }

  private now(): number {
    return performance.now() - this.t0;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    const p = getParams();
    const interval = 1000 / p.ANALYSIS_FPS;
    const started = performance.now();
    try {
      const v = this.video;
      if (v && v.readyState >= 2 && v.videoWidth > 0 && !this.analyzer.busy) {
        const { width, height } = analysisSize(v.videoWidth, v.videoHeight, p.ANALYSIS_WIDTH);
        const bitmap = await createImageBitmap(v, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
        const t = this.now();
        const m = await this.analyzer.analyze(bitmap, p.PIXEL_DIFF);
        const sample: Sample = { t, motion: m.motion, change: m.change, sharpness: m.sharpness, state: this.state.name, ms: m.ms };
        const r = step(this.state, { t, motion: m.motion, change: m.change, sharpness: m.sharpness }, p);
        this.apply(r);
        sample.state = this.state.name;
        this.lastSample = sample;
        this.events.onSample?.(sample);
        if (r.capture) void this.doCapture(false, false);
      }
    } catch (e) {
      log.warn('프레임 분석 실패', e);
    }
    this.schedule(Math.max(0, interval - (performance.now() - started)));
  }

  private apply(r: StepResult): void {
    this.state = r.state;
    for (const t of r.transitions) {
      log.debug(`상태 ${t.from} → ${t.to} (${t.reason})`);
      this.events.onTransition?.(t);
    }
    if (r.transitions.length) this.events.onState?.(this.state);
  }

  private async doCapture(isManual: boolean, wasPaused: boolean): Promise<void> {
    if (this.capturing) return;
    const shooter = this.shooter;
    if (!shooter) {
      this.apply(captureFailed(this.state, this.now()));
      return;
    }
    this.capturing = true;
    // 기준 프레임 = 촬영을 결정한 순간의 축소 프레임 (SPEC 6장 change)
    this.analyzer.setReference();
    const sharpness = this.lastSample?.sharpness ?? 0;
    try {
      const shot = await shooter.shoot();
      const saved = await busy.track(
        (async () => {
          const { thumb, width, height } = await makeThumbnail(shot.blob);
          return this.repo.addCapture(this.bookId, {
            jpeg: shot.blob,
            thumb,
            width: shot.width || width,
            height: shot.height || height,
            sharpness,
            manual: isManual,
            replaceCaptureId: this.replaceCaptureId,
          });
        })(),
      );
      log.info(`촬영 저장 #${saved.seq} ${saved.width}×${saved.height} ${shot.method} ${Math.round(shot.ms)}ms`);
      this.replaceCaptureId = undefined;
      this.apply(captured(this.state, this.now(), sharpness, { wasPaused }));
      this.events.onCaptured?.(saved, shot);
    } catch (e) {
      log.error('촬영 또는 저장 실패', e);
      this.apply(captureFailed(this.state, this.now()));
      if (wasPaused) this.apply(pause(this.state, this.now()));
      this.events.onCaptureError?.(e);
    } finally {
      this.capturing = false;
    }
  }
}

/**
 * 촬영 화면 (SPEC 6장). 전체 화면 미리보기 + 가이드 틀 + 상태 표시 + 페이지 카운터.
 * 화면을 탭하면 즉시 수동 촬영. 탭이 숨겨지면 카메라·Wake Lock 을 놓고 PAUSED, 돌아오면 다시 연다.
 */
import {
  cameraEnvironmentProblem,
  openRearCamera,
  snapshotCamera,
  stopStream,
  type OpenCamera,
} from '../../camera/camera';
import { describeCameraError, type CameraErrorInfo } from '../../camera/constraints';
import { flashBorder, shutterSound, unlockAudio, vibrate } from '../../camera/feedback';
import { summaryLine } from '../../camera/info';
import { Shooter } from '../../camera/shoot';
import { setTorch, torchSupported } from '../../camera/torch';
import { stateLabel, type CaptureStateName } from '../../capture/machine';
import { CaptureSession } from '../../capture/session';
import { getParams } from '../../config';
import { getSettings } from '../../config/settings';
import { log } from '../../debug/log';
import { formatBytes, freeBytes, isLowSpace, requestPersist } from '../../storage/persist';
import type { Screen } from '../context';
import { append, clear, h } from '../dom';
import { confirmDialog, toast } from '../ui';
import { WakeLockHold } from '../wakelock';

export const scanScreen: Screen = (ctx, route, root) => {
  if (route.name !== 'scan') return;
  const { bookId } = route;
  let retake = route.retake;
  let disposed = false;

  const video = h('video', { class: 'preview', autoplay: true, playsinline: true, muted: true });
  video.muted = true;
  const guide = h('div', { class: 'guide', 'aria-hidden': 'true' }, h('div', { class: 'guide-frame' }), h('div', { class: 'guide-spine' }));
  const stateEl = h('div', { class: 'scan-state', 'aria-live': 'polite' }, '카메라 준비 중');
  const counter = h('div', { class: 'scan-counter', 'aria-live': 'polite' }, '0장');
  const res = h('div', { class: 'res-badge' }, '');
  const pauseBtn = h('button', { type: 'button', class: 'btn btn-big' }, '일시정지');
  const torchBtn = h('button', { type: 'button', class: 'btn btn-big', hidden: true }, '플래시 켜기');
  const shootBtn = h('button', { type: 'button', class: 'btn btn-big btn-primary', 'aria-label': '지금 촬영' }, '찍기');
  const doneBtn = h('button', { type: 'button', class: 'btn btn-big' }, '끝내기');
  const retakeNote = h('div', { class: 'retake-note', hidden: !retake }, '재촬영: 이 장을 다시 찍으면 원래 자리에 들어갑니다');
  const surface = h('div', { class: 'scan-surface', role: 'button', 'aria-label': '화면을 누르면 촬영' }, video, guide);
  const cameraBox = h(
    'section',
    { class: 'camera' },
    surface,
    res,
    stateEl,
    counter,
    retakeNote,
    h('div', { class: 'camera-controls' }, pauseBtn, torchBtn, shootBtn, doneBtn),
  );
  const messageBox = h('section', { class: 'card' });
  root.append(messageBox);

  let cam: OpenCamera | null = null;
  let session: CaptureSession | null = null;
  let count = 0;
  let torchOn = false;
  let opening = false;
  let resumeOnVisible = false;
  let userPaused = false;
  const wake = new WakeLockHold();

  const setState = (name: CaptureStateName) => {
    stateEl.textContent = stateLabel(name);
    stateEl.dataset.state = name;
    cameraBox.dataset.state = name;
  };

  const showMessage = (problem: CameraErrorInfo | null, text?: string) => {
    cameraBox.remove();
    clear(messageBox);
    append(
      messageBox,
      h('h1', {}, '촬영'),
      problem ? h('div', { class: 'notice notice-error', role: 'alert' }, h('strong', {}, problem.title), h('p', {}, problem.detail)) : h('p', { class: 'lead' }, text ?? ''),
      problem && !problem.retryable ? null : h('button', { type: 'button', class: 'btn btn-primary btn-big', onclick: () => void start() }, problem ? '다시 시도' : '카메라 켜기'),
      h('p', {}, h('a', { href: `#/book/${encodeURIComponent(bookId)}`, class: 'btn btn-quiet' }, '← 책으로')),
    );
    if (!messageBox.isConnected) root.append(messageBox);
  };

  // ── 촬영 전 점검 (규칙 4·6) ──────────────────────────
  const preflight = async (): Promise<boolean> => {
    const book = await ctx.repo.getBook(bookId);
    if (!book) {
      showMessage({ kind: 'unknown', title: '책을 찾을 수 없습니다', detail: '목록에서 다시 골라 주세요.', retryable: false });
      return false;
    }
    count = (await ctx.repo.listCaptures(bookId)).length;
    counter.textContent = `${count}장`;
    const persisted = await requestPersist();
    const s = await ctx.refreshStorage();
    if (persisted === false) log.warn('영구 저장이 거부됐습니다');
    if (isLowSpace(s)) {
      const go = await confirmDialog(`저장 공간이 부족합니다 (여유 ${formatBytes(freeBytes(s))}).`, {
        detail: '책을 ZIP 으로 내보내거나 드라이브에 올린 뒤 오래된 책을 지우세요. 그래도 계속 찍을 수는 있습니다.',
        ok: '그래도 촬영',
        cancel: '책으로 돌아가기',
      });
      if (!go) {
        ctx.go({ name: 'book', bookId });
        return false;
      }
    }
    return true;
  };

  // ── 카메라 ──────────────────────────────────────────
  async function start(): Promise<void> {
    if (opening || cam || disposed) return;
    const env = cameraEnvironmentProblem();
    if (env) return showMessage(env);
    opening = true;
    unlockAudio();
    try {
      const opened = await openRearCamera(getParams());
      if (disposed || document.hidden) {
        stopStream(opened.stream);
        resumeOnVisible = !disposed;
        return;
      }
      cam = opened;
      opened.track.addEventListener('ended', () => {
        if (cam === opened) {
          log.warn('카메라 트랙이 끝났습니다');
          stopCamera('트랙 종료');
          showMessage({ kind: 'busy', title: '카메라 연결이 끊겼습니다', detail: '다시 켜 주세요.', retryable: true });
        }
      });
      video.srcObject = opened.stream;
      messageBox.remove();
      if (!cameraBox.isConnected) root.append(cameraBox);
      await video.play().catch((e: unknown) => log.warn('video.play 실패', e));
      await waitForVideo(video);
      if (disposed) return void stopStream(opened.stream);
      const snap = await snapshotCamera(opened, video);
      res.textContent = summaryLine(snap);
      ctx.debug.setCamera(snap);
      torchBtn.hidden = !torchSupported(opened.track);
      torchOn = false;
      torchBtn.textContent = '플래시 켜기';
      log.info('카메라 열림', opened.track.getSettings());

      if (!session) {
        const caps = await ctx.repo.listCaptures(bookId);
        session = new CaptureSession(ctx.repo, bookId, events, {
          sharpHistory: caps.slice(-9).map((c) => c.sharpness),
          replaceCaptureId: retake,
        });
        // 새로고침 뒤 이어서 찍을 때: 마지막 촬영 썸네일을 기준 프레임으로 (같은 페이지 중복 방지)
        const last = caps[caps.length - 1];
        if (last && !retake) {
          const thumb = await ctx.repo.files.read(last.thumb);
          if (thumb && (await session.loadReference(thumb, video.videoWidth, video.videoHeight))) log.info('이전 마지막 촬영을 기준 프레임으로 씀');
        }
      } else if (!userPaused) {
        session.resume();
      }
      // 기다리는 사이 화면을 나갔으면 세션을 붙이지 않는다 (worker·타이머·Wake Lock 누수 방지)
      if (disposed) {
        session?.dispose();
        session = null;
        stopStream(opened.stream);
        return;
      }
      session.attach(video, new Shooter(opened, video, () => getSettings().captureMethod));
      if (userPaused) session.pause();
      setState(session.current.name);
      ctx.debug.capture.setVideo(video);
      await wake.acquire();
      if (disposed) await wake.release();
    } catch (err) {
      log.error('카메라 열기 실패', err);
      showMessage(describeCameraError(err));
    } finally {
      opening = false;
    }
  }

  function stopCamera(reason: string): void {
    session?.detach(reason);
    stopStream(cam?.stream);
    cam = null;
    video.srcObject = null;
    ctx.debug.setCamera(null);
    ctx.debug.capture.setVideo(null);
    void wake.release();
  }

  const events = {
    onState: (s: { name: CaptureStateName }) => setState(s.name),
    onSample: (s: Parameters<typeof ctx.debug.capture.sample>[0]) => ctx.debug.capture.sample(s),
    onTransition: (t: Parameters<typeof ctx.debug.capture.transition>[0]) => ctx.debug.capture.transition(t),
    onCaptured: () => {
      count++;
      counter.textContent = `${count}장`;
      const st = getSettings();
      if (st.shutterSound) shutterSound();
      if (st.vibrate) vibrate();
      flashBorder(cameraBox);
      if (retake) {
        retake = undefined;
        toast('재촬영한 사진으로 바꿨습니다', 'ok');
        ctx.go({ name: 'book', bookId });
      }
    },
    onCaptureError: (e: unknown) => toast(`촬영 실패: ${e instanceof Error ? e.message : String(e)}`, 'error'),
  };

  // ── 조작 ────────────────────────────────────────────
  surface.addEventListener('click', () => {
    unlockAudio();
    session?.manual();
  });
  shootBtn.addEventListener('click', () => {
    unlockAudio();
    session?.manual();
  });
  pauseBtn.addEventListener('click', () => {
    if (!session) return;
    userPaused = !userPaused;
    if (userPaused) session.pause();
    else session.resume();
    pauseBtn.textContent = userPaused ? '재개' : '일시정지';
  });
  torchBtn.addEventListener('click', async () => {
    if (!cam) return;
    try {
      await setTorch(cam.track, !torchOn);
      torchOn = !torchOn;
      torchBtn.textContent = torchOn ? '플래시 끄기' : '플래시 켜기';
    } catch (e) {
      log.warn('플래시 전환 실패', e);
      toast('플래시를 바꿀 수 없습니다', 'error');
    }
  });
  doneBtn.addEventListener('click', () => ctx.go({ name: 'book', bookId }));

  // 블루투스 키보드·리모컨: Enter / Space 로 촬영 (선택 사항, SPEC 2장)
  const onKey = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && cameraBox.isConnected && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      session?.manual();
    }
  };
  document.addEventListener('keydown', onKey);

  // 탭 숨김 → 카메라·Wake Lock 해제, PAUSED. 돌아오면 다시 연다 (SPEC 6장)
  const onVisibility = () => {
    if (document.hidden) {
      if (cam) {
        resumeOnVisible = true;
        stopCamera('탭 숨김');
        setState('PAUSED');
        log.info('탭 숨김 — 카메라 해제');
      }
    } else if (resumeOnVisible) {
      resumeOnVisible = false;
      log.info('탭 복귀 — 카메라 다시 열기');
      void start();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  showMessage(null, '카메라를 여는 중…');
  void (async () => {
    if (await preflight()) await start();
  })();

  return () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('keydown', onKey);
    stopCamera('화면 나감');
    session?.dispose();
    session = null;
  };
};

function waitForVideo(v: HTMLVideoElement): Promise<void> {
  if (v.readyState >= 2 && v.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      v.removeEventListener('loadeddata', done);
      resolve();
    };
    v.addEventListener('loadeddata', done);
    setTimeout(done, 3000);
  });
}

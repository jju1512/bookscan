/**
 * Phase 0 화면: 카메라 권한 화면 → 후면 카메라 미리보기(받은 해상도 표시), 디버그 패널, 설치 버튼.
 * Phase 1 에서 책 목록·촬영 화면이 붙으면 이 파일을 화면별로 나눈다.
 */
import {
  cameraEnvironmentProblem,
  cameraPermissionState,
  openRearCamera,
  snapshotCamera,
  stopStream,
  type OpenCamera,
} from '../camera/camera';
import { describeCameraError, type CameraErrorInfo } from '../camera/constraints';
import { summaryLine } from '../camera/info';
import { getParams } from '../config';
import { createDebugPanel, type DebugPanel } from '../debug/panel';
import { log } from '../debug/log';
import { clear, h } from './dom';
import { setupInstallButton, isStandalone } from './install';

export interface AppHandle {
  debug: DebugPanel;
  /** 서비스 워커 상태를 디버그 패널 환경 표에 반영한다. */
  setServiceWorkerStatus(text: string): void;
  /** 새 버전 배너를 띄운다. */
  showUpdateBanner(onReload: () => void): void;
}

export function startApp(root: HTMLElement): AppHandle {
  const debug = createDebugPanel();
  const screen = h('main', { class: 'screen', id: 'screen' });
  const installBtn = h('button', { type: 'button', class: 'btn btn-tool', hidden: true }, '홈 화면에 설치');
  const debugBtn = h('button', { type: 'button', class: 'btn btn-tool', 'aria-controls': 'debug-panel', onclick: () => debug.toggle() }, '디버그');
  const toolbar = h('div', { class: 'toolbar' }, installBtn, debugBtn);
  const banner = h('div', { class: 'banner', role: 'status', hidden: true });
  debug.el.id = 'debug-panel';
  root.append(screen, toolbar, banner, debug.el);

  let swStatus = '확인 중';
  const refreshEnv = () =>
    debug.setEnv([
      { name: '앱 버전', value: `${__APP_VERSION__} (${__BUILD_TIME__})` },
      { name: 'base', value: import.meta.env.BASE_URL },
      { name: '실행 방식', value: isStandalone() ? '설치된 앱 (standalone)' : '브라우저 탭' },
      { name: '보안 컨텍스트', value: window.isSecureContext ? '예 (HTTPS/localhost)' : '아니오 — 카메라 불가' },
      { name: '서비스 워커', value: swStatus },
      { name: '브라우저', value: navigator.userAgent },
    ]);
  refreshEnv();
  setupInstallButton(installBtn, () => refreshEnv());
  if (new URLSearchParams(location.search).has('debug')) debug.open();

  let cam: OpenCamera | null = null;
  let resumeOnVisible = false;
  let opening = false;

  const showPermission = (problem?: CameraErrorInfo) => {
    clear(screen);
    const blocked = problem && !problem.retryable;
    screen.append(
      h(
        'section',
        { class: 'card' },
        h('h1', {}, '북스캔'),
        problem
          ? h('div', { class: 'notice notice-error', role: 'alert' }, h('strong', {}, problem.title), h('p', {}, problem.detail))
          : h(
              'p',
              { class: 'lead' },
              '책 페이지를 찍으려면 카메라 권한이 필요합니다. 촬영한 이미지는 이 기기 안에만 저장되고, 다른 곳으로 보내지 않습니다.',
            ),
        blocked
          ? null
          : h('button', { type: 'button', class: 'btn btn-primary btn-big', onclick: () => void startCamera() }, problem ? '다시 시도' : '카메라 켜기'),
      ),
    );
  };

  const showPreview = (opened: OpenCamera) => {
    clear(screen);
    const video = h('video', { class: 'preview', autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    video.srcObject = opened.stream;
    const badge = h('div', { class: 'res-badge', 'aria-live': 'polite' }, '해상도 확인 중…');
    const stopBtn = h('button', { type: 'button', class: 'btn btn-big', onclick: () => stopCamera(true) }, '카메라 끄기');
    screen.append(h('section', { class: 'camera' }, video, badge, h('div', { class: 'camera-controls' }, stopBtn)));

    const update = async () => {
      if (cam !== opened) return;
      const snap = await snapshotCamera(opened, video);
      if (cam !== opened) return;
      badge.textContent = summaryLine(snap);
      debug.setCamera(snap);
    };
    video.addEventListener('loadedmetadata', () => void update());
    video.addEventListener('resize', () => void update());
    void video.play().catch((e: unknown) => log.warn('video.play 실패', e));
    void update();
  };

  async function startCamera(): Promise<void> {
    if (opening || cam) return;
    const env = cameraEnvironmentProblem();
    if (env) {
      showPermission(env);
      return;
    }
    opening = true;
    clear(screen);
    screen.append(h('section', { class: 'card' }, h('p', { class: 'lead' }, '카메라를 여는 중…')));
    try {
      const opened = await openRearCamera(getParams());
      // 여는 동안 탭이 숨겨졌으면 바로 놓고, 돌아올 때 다시 연다.
      if (document.hidden) {
        stopStream(opened.stream);
        resumeOnVisible = true;
        log.info('여는 도중 탭 숨김 — 카메라 해제');
        showPermission();
        return;
      }
      opened.track.addEventListener('ended', () => {
        if (cam === opened) {
          log.warn('카메라 트랙이 끝났습니다');
          stopCamera(false);
          showPermission({ kind: 'busy', title: '카메라 연결이 끊겼습니다', detail: '다시 켜 주세요.', retryable: true });
        }
      });
      cam = opened;
      log.info('카메라 열림', opened.track.getSettings());
      showPreview(opened);
    } catch (err) {
      const info = describeCameraError(err);
      log.error('카메라 열기 실패', err);
      showPermission(info);
    } finally {
      opening = false;
    }
  }

  function stopCamera(showScreen: boolean): void {
    stopStream(cam?.stream);
    cam = null;
    debug.setCamera(null);
    if (showScreen) showPermission();
  }

  // 탭이 숨겨지면 카메라를 놓고, 돌아오면 다시 연다 (SPEC 6장).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 여는 중이면 startCamera 가 끝난 뒤 document.hidden 을 보고 스스로 놓는다.
      if (cam) {
        resumeOnVisible = true;
        stopCamera(false);
        log.info('탭 숨김 — 카메라 해제');
      }
    } else if (resumeOnVisible) {
      resumeOnVisible = false;
      log.info('탭 복귀 — 카메라 다시 열기');
      void startCamera();
    }
  });

  // 이미 권한을 받았으면 바로 켜고, 아니면 권한 화면을 보여 준다.
  const envProblem = cameraEnvironmentProblem();
  if (envProblem) {
    showPermission(envProblem);
  } else {
    showPermission();
    void cameraPermissionState().then((state) => {
      log.info('카메라 권한 상태', state);
      if (cam || opening) return;
      if (state === 'granted') void startCamera();
      // 이미 거부된 상태면 버튼을 눌러도 브라우저가 묻지 않으므로, 바꾸는 방법부터 보여 준다.
      else if (state === 'denied') showPermission(describeCameraError({ name: 'NotAllowedError' }));
    });
  }

  return {
    debug,
    setServiceWorkerStatus(text) {
      swStatus = text;
      refreshEnv();
    },
    showUpdateBanner(onReload) {
      clear(banner);
      banner.append(
        h('span', {}, '새 버전이 있습니다.'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: onReload }, '새로고침'),
      );
      banner.hidden = false;
    },
  };
}

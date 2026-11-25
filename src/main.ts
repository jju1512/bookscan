import './app/styles.css';
import { registerSW } from 'virtual:pwa-register';
import { startApp } from './app/app';
import { initParams } from './config';
import { captureGlobalErrors, log } from './debug/log';

captureGlobalErrors();
initParams();
log.info(`북스캔 ${__APP_VERSION__} 시작`);

const root = document.getElementById('app');
if (!root) throw new Error('#app 이 없습니다');
const app = startApp(root);

// 새 버전이 오면 바로 바꾸지 않고 배너로 묻는다. 촬영·후처리 중에 화면이 갑자기 새로고침되는 것을 막기 위해서다.
if ('serviceWorker' in navigator) {
  const updateSW = registerSW({
    onNeedRefresh() {
      log.info('새 버전 대기 중');
      app.showUpdateBanner(() => void updateSW(true));
    },
    onOfflineReady() {
      log.info('오프라인 준비 완료');
      app.setServiceWorkerStatus('등록됨 · 오프라인 준비 완료');
    },
    onRegisteredSW(_url, registration) {
      app.setServiceWorkerStatus(registration?.active ? '등록됨 · 동작 중' : '등록됨 · 설치 중');
    },
    onRegisterError(error) {
      log.error('서비스 워커 등록 실패', error);
      app.setServiceWorkerStatus('등록 실패 (로그 참고)');
    },
  });
} else {
  app.setServiceWorkerStatus('지원 안 함');
}

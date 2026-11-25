/**
 * 앱 셸: 저장소 열기·복구, 라우터, 상단 알림 줄(저장 경고·드라이브), 디버그 패널, 설치 버튼.
 * 화면은 screens/ 에 하나씩 있고, 무거운 후처리 화면은 필요할 때만 불러온다.
 */
import { getParams } from '../config';
import { getSettings } from '../config/settings';
import { createDebugPanel, type DebugPanel } from '../debug/panel';
import { log } from '../debug/log';
import { openStorage } from '../storage';
import { busy, installBeforeUnload } from '../storage/busy';
import { estimateStorage, formatBytes, freeBytes, isPersisted, type StorageStatus } from '../storage/persist';
import type { AppCtx, Screen, SyncApi } from './context';
import { clear, h } from './dom';
import { isStandalone, setupInstallButton } from './install';
import { parseRoute, routeHash, type Route } from './router';
import { toast } from './ui';

export interface AppHandle {
  debug: DebugPanel;
  setServiceWorkerStatus(text: string): void;
  showUpdateBanner(onReload: () => void): void;
}

const NULL_SYNC: SyncApi = {
  configured: false,
  connected: () => false,
  connect: async () => {},
  disconnect: async () => {},
  status: () => ({ pending: 0, failed: 0, running: 0, needsReconnect: false, paused: null }),
  onChange: () => () => {},
  enqueuePdf: async () => {},
  retryFailed: async () => {},
};

async function loadScreen(name: Route['name']): Promise<Screen> {
  switch (name) {
    case 'books': return (await import('./screens/books')).booksScreen;
    case 'book': return (await import('./screens/book')).bookScreen;
    case 'scan': return (await import('./screens/scan')).scanScreen;
    case 'settings': return (await import('./screens/settings')).settingsScreen;
    case 'process': return (await import('./screens/process')).processScreen;
    case 'manual': return (await import('./screens/manual')).manualScreen;
    case 'compare': return (await import('./screens/compare')).compareScreen;
    case 'driveImport': return (await import('./screens/driveImport')).driveImportScreen;
    case 'onboarding': return (await import('./screens/onboarding')).onboardingScreen;
  }
}

export function startApp(root: HTMLElement): AppHandle {
  const debug = createDebugPanel();
  const banners = h('div', { class: 'banners', 'aria-live': 'polite' });
  const screen = h('main', { class: 'screen', id: 'screen' });
  const installBtn = h('button', { type: 'button', class: 'btn btn-tool', hidden: true }, '홈 화면에 설치');
  const debugBtn = h('button', { type: 'button', class: 'btn btn-tool', 'aria-controls': 'debug-panel', onclick: () => debug.toggle() }, '디버그');
  const toolbar = h('div', { class: 'toolbar' }, installBtn, debugBtn);
  const updateBanner = h('div', { class: 'banner', role: 'status', hidden: true });
  debug.el.id = 'debug-panel';
  root.append(banners, screen, toolbar, updateBanner, debug.el);

  let swStatus = '확인 중';
  let storageStatus: StorageStatus | null = null;
  const refreshEnv = () =>
    debug.setEnv([
      { name: '앱 버전', value: `${__APP_VERSION__} (${__BUILD_TIME__})` },
      { name: 'base', value: import.meta.env.BASE_URL },
      { name: '실행 방식', value: isStandalone() ? '설치된 앱 (standalone)' : '브라우저 탭' },
      { name: '보안 컨텍스트', value: window.isSecureContext ? '예 (HTTPS/localhost)' : '아니오 — 카메라 불가' },
      { name: '서비스 워커', value: swStatus },
      { name: '저장 공간', value: storageStatus ? `${formatBytes(storageStatus.usage)} 사용 / 여유 ${formatBytes(freeBytes(storageStatus))}` : '확인 중' },
      { name: '영구 저장', value: storageStatus?.persisted === undefined ? '아직 요청 안 함' : storageStatus.persisted ? '허용됨' : '거부됨' },
      { name: '드라이브 클라이언트 ID', value: import.meta.env.VITE_GOOGLE_CLIENT_ID ? '설정됨' : '없음 (드라이브 기능 숨김)' },
      { name: '브라우저', value: navigator.userAgent },
    ]);
  refreshEnv();
  setupInstallButton(installBtn, () => refreshEnv());
  if (new URLSearchParams(location.search).has('debug')) debug.open();

  const bannerEls = new Map<string, HTMLElement>();
  const setBanner = (id: string, el: HTMLElement | null) => {
    bannerEls.get(id)?.remove();
    bannerEls.delete(id);
    if (el) {
      el.dataset.banner = id;
      bannerEls.set(id, el);
      banners.append(el);
    }
  };

  installBeforeUnload(busy);

  const showFatal = (title: string, detail: string) => {
    clear(screen);
    screen.append(h('section', { class: 'card' }, h('h1', {}, '북스캔'), h('div', { class: 'notice notice-error', role: 'alert' }, h('strong', {}, title), h('p', {}, detail))));
  };

  void (async () => {
    let opened;
    try {
      opened = await openStorage();
    } catch (e) {
      log.error('저장소 열기 실패', e);
      showFatal('저장소를 열 수 없습니다', '이 브라우저에서 IndexedDB 를 쓸 수 없습니다. 시크릿 모드라면 일반 창에서 열어 주세요.');
      return;
    }
    const { repo } = opened;
    storageStatus = opened.status;
    refreshEnv();
    const rec = await repo.recover();
    if (rec.uploads || rec.steps || rec.jobs) log.info('중단된 작업을 이어서 하도록 되돌림', rec);

    const updateStorageBanners = (s: StorageStatus) => {
      // 규칙 5: 시크릿 모드·저장 불가 경고
      setBanner(
        'ephemeral',
        s.ephemeral
          ? h('div', { class: 'notice notice-error banner-row', role: 'alert' }, h('strong', {}, '탭을 닫으면 사라집니다. '), s.reason ?? '이 창에서는 촬영본을 오래 보관할 수 없습니다. 자주 ZIP 으로 내보내세요.')
          : null,
      );
      // 규칙 4: 영구 저장 거부
      setBanner(
        'persist',
        s.persisted === false && !s.ephemeral
          ? h('div', { class: 'notice notice-warn banner-row' }, '공간이 부족하면 브라우저가 데이터를 지울 수 있습니다. 홈 화면에 설치하면 보통 영구 저장이 허용됩니다. 중요한 책은 ZIP 으로 내보내 두세요.')
          : null,
      );
    };
    updateStorageBanners(opened.status);

    let sync: SyncApi = NULL_SYNC;
    if (import.meta.env.VITE_GOOGLE_CLIENT_ID) {
      try {
        const mod = await import('../sync');
        sync = mod.createSync({ repo, clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID, setBanner, appVersion: __APP_VERSION__ });
      } catch (e) {
        log.error('드라이브 연동 모듈을 불러오지 못했습니다', e);
      }
    }

    const ctx: AppCtx = {
      repo,
      get storage() {
        return storageStatus!;
      },
      debug,
      sync,
      go(r, replace) {
        const hash = routeHash(r);
        if (replace) history.replaceState(null, '', hash);
        else if (location.hash !== hash) location.hash = hash;
        if (replace || location.hash === hash) void render();
      },
      async refreshStorage() {
        const est = await estimateStorage();
        storageStatus = { ...storageStatus!, ...est, persisted: await isPersisted() };
        updateStorageBanners(storageStatus);
        refreshEnv();
        return storageStatus;
      },
      setBanner,
    };

    let cleanup: (() => void) | void;
    let renderSeq = 0;
    const render = async () => {
      const seq = ++renderSeq;
      const route = parseRoute(location.hash);
      if (route.name !== 'onboarding' && !getSettings().onboardingDone && sync.configured) {
        ctx.go({ name: 'onboarding' }, true);
        return;
      }
      let screenFn: Screen;
      try {
        screenFn = await loadScreen(route.name);
      } catch (e) {
        log.error('화면을 불러오지 못했습니다', e);
        toast('화면을 불러오지 못했습니다. 새로고침해 주세요.', 'error');
        return;
      }
      if (seq !== renderSeq) return;
      try {
        cleanup?.();
      } catch (e) {
        log.warn('화면 정리 오류', e);
      }
      clear(screen);
      screen.className = `screen screen-${route.name}`;
      document.body.dataset.route = route.name;
      try {
        cleanup = screenFn(ctx, route, screen);
      } catch (e) {
        log.error('화면 오류', e);
        showFatal('화면을 그리는 중 오류가 났습니다', e instanceof Error ? e.message : String(e));
      }
    };
    window.addEventListener('hashchange', () => void render());
    await render();
    log.info('파라미터', getParams());
  })();

  return {
    debug,
    setServiceWorkerStatus(text) {
      swStatus = text;
      refreshEnv();
    },
    showUpdateBanner(onReload) {
      clear(updateBanner);
      updateBanner.append(
        h('span', {}, '새 버전이 있습니다.'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            onclick: () => {
              // 저장·업로드·후처리 중이면 끝난 뒤에 바꾸도록 묻는다
              const reasons = busy.reasons();
              if (reasons.length && !window.confirm(`진행 중인 작업이 있습니다 (${reasons.join(', ')}). 지금 새로고침할까요?`)) return;
              onReload();
            },
          },
          '새로고침',
        ),
      );
      updateBanner.hidden = false;
    },
  };
}

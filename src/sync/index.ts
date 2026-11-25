/**
 * 드라이브 연동 진입점 (SPEC 7장). 화면이 쓰는 SyncApi 를 만든다.
 * - 토큰은 GisTokenProvider 의 메모리에만 있다. 앱을 다시 열면 토큰이 없으므로 첫 업로드에서 401 경로를 탄다:
 *   대기열이 멈추고 팝업 없는 재발급(prompt:'')을 시도 → 실패하면 상단에 "드라이브 다시 연결" 버튼.
 * - online/offline 이벤트로 대기열을 멈추고 다시 시작한다. 촬영은 대기열을 기다리지 않는다.
 */
import type { SyncApi } from '../app/context';
import { getSettings, updateSettings } from '../config/settings';
import { log } from '../debug/log';
import { busy } from '../storage/busy';
import type { Repo } from '../storage/repo';
import { DriveClient } from './drive';
import { UploadQueue, type QueueStatus } from './queue';
import { GisTokenProvider } from './token';

export interface SyncOptions {
  repo: Repo;
  clientId: string;
  setBanner: (id: string, el: HTMLElement | null) => void;
  appVersion: string;
}

let driveForImport: DriveClient | null = null;
/** 다른 기기에서 불러오기 화면이 쓰는 클라이언트 (연동 중일 때만) */
export function currentDrive(): DriveClient | null {
  return driveForImport;
}

export function createSync(opts: SyncOptions): SyncApi {
  const { repo } = opts;
  const token = new GisTokenProvider(opts.clientId);
  const drive = new DriveClient({ fetch: (...a) => fetch(...a), getToken: () => token.current() });
  driveForImport = drive;
  const queue = new UploadQueue({ repo, drive, token, appVersion: opts.appVersion });
  const listeners = new Set<() => void>();
  let status: QueueStatus = queue.status();
  const notify = () => {
    for (const fn of listeners) fn();
  };

  const reconnectBanner = () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-small';
    btn.textContent = '드라이브 다시 연결';
    btn.addEventListener('click', () => void api.connect().catch((e) => log.warn('다시 연결 실패', e)));
    const el = document.createElement('div');
    el.className = 'notice notice-warn banner-row';
    el.append('드라이브 로그인이 만료됐습니다. 업로드는 기다리는 중이고 촬영은 계속됩니다. ', btn);
    return el;
  };

  queue.onStatus((s) => {
    status = s;
    opts.setBanner('drive', getSettings().driveEnabled && s.needsReconnect ? reconnectBanner() : null);
    notify();
  });
  token.onChange(notify);

  const onlineChange = () => queue.setOnline(navigator.onLine);
  window.addEventListener('online', onlineChange);
  window.addEventListener('offline', onlineChange);
  queue.setOnline(navigator.onLine);

  // 끝나지 않은 업로드가 있으면 떠날 때 경고 (규칙 3)
  busy.register('upload', () => {
    if (!getSettings().driveEnabled) return null;
    const n = status.pending + status.running;
    return n > 0 && !status.needsReconnect && status.paused !== 'offline' ? `업로드 대기 ${n}장` : null;
  });

  if (getSettings().driveEnabled) queue.start();

  const api: SyncApi = {
    configured: true,
    connected: () => token.current() !== null,
    async connect() {
      // 사용자가 버튼을 누른 경우에만 부른다 (브라우저가 팝업을 열어 준다)
      await token.requestInteractive();
      updateSettings({ driveEnabled: true, onboardingDone: true });
      queue.start();
      queue.reconnected();
      log.info('드라이브 연결됨');
      notify();
    },
    async disconnect() {
      queue.stop();
      await token.revoke();
      updateSettings({ driveEnabled: false });
      opts.setBanner('drive', null);
      log.info('드라이브 연동 해제');
      notify();
    },
    status: () => ({ ...status }),
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async enqueuePdf(bookId, file, name) {
      if (!getSettings().driveEnabled) return;
      await repo.putJob({ id: `pdf:${bookId}`, bookId, kind: 'pdf', file, name, upload: { state: 'pending', attempts: 0 }, createdAt: Date.now() });
      queue.kick();
    },
    async retryFailed() {
      for (const c of await repo.allCaptures()) {
        if (!c.deleted && c.upload.state === 'failed') await repo.setUpload(c.id, { nextAttemptAt: undefined });
      }
      for (const j of await repo.allJobs()) {
        if (j.upload.state === 'failed') await repo.setJobUpload(j.id, { nextAttemptAt: undefined });
      }
      queue.kick();
    },
  };
  return api;
}

/** 화면들이 받는 앱 공용 객체 */
import type { DebugPanel } from '../debug/panel';
import type { StorageStatus } from '../storage/persist';
import type { Repo } from '../storage/repo';
import type { Route } from './router';

/** 드라이브 연동 (Phase 2). 클라이언트 ID 가 없으면 configured=false */
export interface SyncApi {
  readonly configured: boolean;
  /** 토큰이 있어 업로드할 수 있다 */
  connected(): boolean;
  /** 연동하기 / 다시 연결 (사용자가 버튼을 눌렀을 때만) */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): { pending: number; failed: number; running: number; needsReconnect: boolean; paused: string | null; lastError?: string };
  onChange(fn: () => void): () => void;
  /** PDF 등 책 단위 파일을 대기열에 넣는다 */
  enqueuePdf(bookId: string, file: string, name: string): Promise<void>;
  /** 실패한 업로드를 바로 다시 시도 */
  retryFailed(): Promise<void>;
}

export interface AppCtx {
  repo: Repo;
  storage: StorageStatus;
  debug: DebugPanel;
  go(r: Route, replace?: boolean): void;
  refreshStorage(): Promise<StorageStatus>;
  /** 상단 알림 줄. el=null 이면 지운다 */
  setBanner(id: string, el: HTMLElement | null): void;
  sync: SyncApi;
}

export type Screen = (ctx: AppCtx, route: Route, root: HTMLElement) => void | (() => void);

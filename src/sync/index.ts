/** 드라이브 연동 진입점 (Phase 2 에서 구현) */
import type { SyncApi } from '../app/context';
import type { Repo } from '../storage/repo';

export function createSync(_opts: { repo: Repo; clientId: string; setBanner: (id: string, el: HTMLElement | null) => void; appVersion: string }): SyncApi {
  throw new Error('드라이브 연동은 Phase 2 에서 구현합니다');
}

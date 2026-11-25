/** 여러 화면이 함께 쓰는 표시 조각 */
import { getSettings } from '../../config/settings';
import type { AppCtx } from '../context';
import { clear, h } from '../dom';

/** "업로드 대기 N장 · 실패 M건" (SPEC 7장). 드라이브 설정이 없으면 숨긴다 */
export function syncStatusLine(ctx: AppCtx, el: HTMLElement): void {
  clear(el);
  if (!ctx.sync.configured) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (!getSettings().driveEnabled) {
    el.textContent = '드라이브 백업: 꺼짐 (설정에서 연동할 수 있습니다)';
    return;
  }
  const s = ctx.sync.status();
  const parts = [`업로드 대기 ${s.pending + s.running}장`];
  if (s.failed) parts.push(`실패 ${s.failed}건`);
  if (s.paused === 'offline') parts.push('오프라인 — 연결되면 이어서 올립니다');
  else if (s.needsReconnect) parts.push('로그인 만료 — 다시 연결이 필요합니다');
  else if (!ctx.sync.connected()) parts.push('연결 안 됨');
  el.append(h('span', {}, `드라이브: ${parts.join(' · ')}`));
  if (s.failed) {
    el.append(' ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => void ctx.sync.retryFailed() }, '지금 다시 시도'));
  }
}

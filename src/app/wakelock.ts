/** Screen Wake Lock. 촬영 화면과 후처리 중에만 켠다 (SPEC 3장, 8장). 탭이 숨겨지면 브라우저가 풀어 버리므로 돌아오면 다시 잡는다. */
import { log } from '../debug/log';

export class WakeLockHold {
  private sentinel: WakeLockSentinel | null = null;
  private wanted = false;
  private readonly onVisible = () => {
    if (this.wanted && document.visibilityState === 'visible' && !this.sentinel) void this.grab();
  };

  get supported(): boolean {
    return 'wakeLock' in navigator;
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    document.addEventListener('visibilitychange', this.onVisible);
    await this.grab();
  }

  private async grab(): Promise<void> {
    if (!this.supported || document.visibilityState !== 'visible') return;
    try {
      const s = await navigator.wakeLock.request('screen');
      if (!this.wanted) {
        await s.release();
        return;
      }
      this.sentinel = s;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
      });
    } catch (e) {
      log.warn('Wake Lock 실패', e);
    }
  }

  async release(): Promise<void> {
    this.wanted = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    const s = this.sentinel;
    this.sentinel = null;
    await s?.release().catch(() => {});
  }
}

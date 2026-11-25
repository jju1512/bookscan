/**
 * 끝나지 않은 저장·업로드·후처리가 있는지 센다. 있으면 페이지를 떠날 때 beforeunload 경고를 띄운다 (SPEC 4장 규칙 3).
 */

type Source = () => string | null;

export class BusyTracker {
  private inflight = 0;
  private sources = new Map<string, Source>();

  /** 저장 같은 짧은 작업을 감싼다 */
  async track<T>(p: Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await p;
    } finally {
      this.inflight--;
    }
  }

  /** 오래 가는 작업의 상태를 묻는 함수를 등록한다. 바쁘면 이유 문자열, 아니면 null */
  register(name: string, source: Source): () => void {
    this.sources.set(name, source);
    return () => this.sources.delete(name);
  }

  /** 바쁜 이유들. 비어 있으면 떠나도 된다 */
  reasons(): string[] {
    const out: string[] = [];
    if (this.inflight > 0) out.push(`저장 중 ${this.inflight}건`);
    for (const s of this.sources.values()) {
      const r = s();
      if (r) out.push(r);
    }
    return out;
  }
}

export const busy = new BusyTracker();

export function installBeforeUnload(tracker: BusyTracker = busy, target: Window = window): void {
  target.addEventListener('beforeunload', (ev) => {
    if (tracker.reasons().length === 0) return;
    ev.preventDefault();
    // 크롬은 문구를 보여 주지 않지만 returnValue 를 채워야 경고를 띄운다.
    ev.returnValue = '';
  });
}

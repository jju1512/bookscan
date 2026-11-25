/** 화면들이 함께 쓰는 작은 UI 조각: 알림(toast), 확인 대화상자, 모달, 다운로드 */
import { h } from './dom';

let toastBox: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500): void {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastBox.append(el);
  setTimeout(() => el.remove(), ms);
}

export function modal(content: Node, opts: { onClose?: () => void; wide?: boolean } = {}): { close: () => void; el: HTMLElement } {
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  const box = h('div', { class: `modal${opts.wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' }, content);
  const back = h('div', { class: 'modal-back' }, box);
  back.addEventListener('click', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(back);
  return { close, el: box };
}

export function confirmDialog(message: string, opts: { ok?: string; cancel?: string; danger?: boolean; detail?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal(
      h(
        'div',
        { class: 'confirm' },
        h('p', { class: 'confirm-msg' }, message),
        opts.detail ? h('p', { class: 'muted' }, opts.detail) : null,
        h(
          'div',
          { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => finish(false) }, opts.cancel ?? '취소'),
          h('button', { type: 'button', class: `btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => finish(true) }, opts.ok ?? '확인'),
        ),
      ),
      { onClose: () => finish(false) },
    );
  });
}

export function promptDialog(message: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { type: 'text', class: 'input', value: initial });
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(input.value);
    });
    const m = modal(
      h(
        'div',
        { class: 'confirm' },
        h('label', { class: 'confirm-msg' }, message, input),
        h(
          'div',
          { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn', onclick: () => finish(null) }, '취소'),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => finish(input.value) }, '확인'),
        ),
      ),
      { onClose: () => finish(null) },
    );
    setTimeout(() => input.focus(), 0);
  });
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}

/** Blob 을 img 에 보여 준다. 반환한 함수로 URL 을 푼다 */
export function blobImg(blob: Blob | null, attrs: Record<string, string> = {}): { img: HTMLImageElement; revoke: () => void } {
  const img = h('img', { decoding: 'async', ...attrs });
  if (!blob) return { img, revoke: () => {} };
  const url = URL.createObjectURL(blob);
  img.src = url;
  return { img, revoke: () => URL.revokeObjectURL(url) };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '계산 중';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function formatDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

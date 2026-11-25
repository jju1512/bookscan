/** 홈 화면 설치 버튼 (PWA). 크롬이 beforeinstallprompt 를 줄 때만 버튼을 보인다. */
import { log } from '../debug/log';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export function setupInstallButton(button: HTMLButtonElement, onChange: () => void): void {
  let deferred: BeforeInstallPromptEvent | null = null;

  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferred = ev as BeforeInstallPromptEvent;
    button.hidden = false;
    log.info('설치 가능 (beforeinstallprompt)');
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    button.hidden = true;
    log.info('홈 화면에 설치됨');
    onChange();
  });

  button.addEventListener('click', async () => {
    if (!deferred) return;
    const ev = deferred;
    deferred = null;
    button.hidden = true;
    await ev.prompt();
    const choice = await ev.userChoice;
    log.info('설치 선택', choice.outcome);
  });
}

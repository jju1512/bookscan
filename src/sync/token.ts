/**
 * 구글 로그인 토큰 (SPEC 7장 "로그인 만료 처리").
 * 서버가 없으므로 리프레시 토큰이 없고, 액세스 토큰은 약 1시간 뒤 만료된다.
 * 토큰은 메모리에만 둔다. localStorage·IndexedDB 에 저장하지 않는다.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
/** 만료 이 시간 전부터 토큰을 없는 것으로 본다 */
const EXPIRY_MARGIN_MS = 60_000;
const SILENT_TIMEOUT_MS = 20_000;
const REVOKE_TIMEOUT_MS = 5_000;
const DEFAULT_EXPIRES_SEC = 3600;

export interface TokenProvider {
  /** 쓸 수 있는 토큰. 만료 60초 전부터 null */
  current(): string | null;
  /** 사용자가 버튼을 눌렀을 때만 부른다 (팝업이 열릴 수 있다). 실패하면 reject */
  requestInteractive(): Promise<void>;
  /** 팝업 없는 재발급을 시도한다. 성공하면 true */
  silentRefresh(): Promise<boolean>;
  /** 구글에 토큰 폐기를 알리고 토큰을 버린다 */
  revoke(): Promise<void>;
  /** 토큰이 생기거나 사라질 때 알린다. 반환값은 구독 해제 */
  onChange(fn: () => void): () => void;
}

// ── 구글 로그인 라이브러리(GIS)의 최소 타입. 쓰는 것만 선언한다 ──────────
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}
interface GisErrorResponse {
  type?: string;
  message?: string;
}
interface GisTokenClient {
  requestAccessToken(overrideConfig?: { prompt?: string }): void;
}
interface GisOauth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (resp: GisTokenResponse) => void;
    error_callback?: (err: GisErrorResponse) => void;
  }): GisTokenClient;
  hasGrantedAllScopes(resp: GisTokenResponse, ...scopes: string[]): boolean;
  revoke(accessToken: string, done?: () => void): void;
}

function gis(): GisOauth2 | undefined {
  return (globalThis as unknown as { google?: { accounts?: { oauth2?: GisOauth2 } } }).google?.accounts?.oauth2;
}

let scriptPromise: Promise<void> | null = null;

/** GIS 스크립트를 한 번만 넣는다. 실패하면 다음 호출에서 다시 시도한다 */
export function loadGisScript(): Promise<void> {
  if (gis()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  const p = new Promise<void>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('브라우저가 아니어서 구글 로그인 스크립트를 불러올 수 없습니다'));
      return;
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error('구글 로그인 스크립트를 불러오지 못했습니다'));
    };
    document.head.appendChild(s);
  });
  scriptPromise = p;
  p.catch(() => {
    if (scriptPromise === p) scriptPromise = null;
  });
  return p;
}

interface Pending {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface GisTokenProviderOptions {
  loadScript?: () => Promise<void>;
  now?: () => number;
}

export class GisTokenProvider implements TokenProvider {
  private token: string | null = null;
  private expiresAt = 0;
  private client: GisTokenClient | null = null;
  private pending: Pending | null = null;
  private inflight: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly loadScript: () => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly clientId: string,
    opts: GisTokenProviderOptions = {},
  ) {
    this.loadScript = opts.loadScript ?? loadGisScript;
    this.now = opts.now ?? (() => Date.now());
  }

  current(): string | null {
    return this.token && this.now() < this.expiresAt - EXPIRY_MARGIN_MS ? this.token : null;
  }

  requestInteractive(): Promise<void> {
    return this.request();
  }

  async silentRefresh(): Promise<boolean> {
    try {
      await this.request(SILENT_TIMEOUT_MS);
      return this.current() !== null;
    } catch {
      return false;
    }
  }

  async revoke(): Promise<void> {
    const t = this.token;
    this.token = null;
    this.expiresAt = 0;
    const oauth = gis();
    if (t && oauth) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, REVOKE_TIMEOUT_MS);
        try {
          oauth.revoke(t, () => {
            clearTimeout(timer);
            resolve();
          });
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    this.notify();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // 화면 갱신 오류가 로그인을 막지 않게 한다
      }
    }
  }

  private async getClient(): Promise<GisTokenClient> {
    if (this.client) return this.client;
    await this.loadScript();
    const oauth = gis();
    if (!oauth) throw new Error('구글 로그인 라이브러리가 준비되지 않았습니다');
    this.client ??= oauth.initTokenClient({
      client_id: this.clientId,
      scope: DRIVE_SCOPE,
      callback: (resp) => this.onResponse(resp),
      error_callback: (err) => this.settle(new Error(`구글 로그인 실패: ${err.type ?? err.message ?? '알 수 없는 오류'}`)),
    });
    return this.client;
  }

  /** 한 번에 한 요청만 보낸다. 이미 기다리는 요청이 있으면 그 결과를 같이 받는다 */
  private request(timeoutMs?: number): Promise<void> {
    if (!this.inflight) {
      const p = this.send(timeoutMs).finally(() => {
        this.inflight = null;
      });
      this.inflight = p;
    }
    return this.inflight;
  }

  private async send(timeoutMs?: number): Promise<void> {
    const client = await this.getClient();
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: Pending = { promise, resolve, reject };
    if (timeoutMs !== undefined) {
      pending.timer = setTimeout(() => this.settle(new Error('구글 로그인 응답이 없습니다')), timeoutMs);
    }
    this.pending = pending;
    try {
      client.requestAccessToken({ prompt: '' });
    } catch (e) {
      this.settle(e instanceof Error ? e : new Error(String(e)));
    }
    return promise;
  }

  private settle(err?: Error): void {
    const p = this.pending;
    if (!p) return;
    if (p.timer !== undefined) clearTimeout(p.timer);
    this.pending = null;
    if (err) p.reject(err);
    else p.resolve();
  }

  private onResponse(resp: GisTokenResponse): void {
    if (resp.error || !resp.access_token) {
      this.settle(new Error(`구글 로그인 실패: ${resp.error_description ?? resp.error ?? '토큰을 받지 못했습니다'}`));
      return;
    }
    if (!gis()?.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
      this.settle(new Error('드라이브 접근 권한이 허용되지 않았습니다'));
      return;
    }
    const sec = Number(resp.expires_in ?? DEFAULT_EXPIRES_SEC);
    this.token = resp.access_token;
    this.expiresAt = this.now() + (Number.isFinite(sec) ? sec : DEFAULT_EXPIRES_SEC) * 1000;
    this.notify();
    this.settle();
  }
}

export interface MemoryTokenProviderOptions {
  now?: () => number;
}

/** 테스트용. 토큰을 직접 넣고, 재발급 결과를 지정한다 */
export class MemoryTokenProvider implements TokenProvider {
  /** silentRefresh 가 돌려줄 값. true 면 refreshedToken 을 새 토큰으로 넣는다 */
  silentResult = false;
  refreshedToken = 'refreshed-token';
  /** requestInteractive 가 reject 할 오류. 없으면 interactiveToken 을 넣고 성공 */
  interactiveError: Error | null = null;
  interactiveToken = 'interactive-token';
  silentCalls = 0;
  interactiveCalls = 0;

  private token: string | null = null;
  private expiresAt = 0;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(opts: MemoryTokenProviderOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  setToken(token: string | null, expiresInSec = DEFAULT_EXPIRES_SEC): void {
    this.token = token;
    this.expiresAt = this.now() + expiresInSec * 1000;
    this.notify();
  }

  current(): string | null {
    return this.token && this.now() < this.expiresAt - EXPIRY_MARGIN_MS ? this.token : null;
  }

  async requestInteractive(): Promise<void> {
    this.interactiveCalls++;
    if (this.interactiveError) throw this.interactiveError;
    this.setToken(this.interactiveToken);
  }

  async silentRefresh(): Promise<boolean> {
    this.silentCalls++;
    if (this.silentResult) this.setToken(this.refreshedToken);
    return this.silentResult;
  }

  async revoke(): Promise<void> {
    this.setToken(null);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

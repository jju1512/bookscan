/**
 * 디버그 로그. 최근 항목만 메모리에 두고, 디버그 패널에서 보고 텍스트로 내보낸다 (SPEC 9장 안정성).
 * Phase 1 에서 상태 전환 로그와 IndexedDB 보관이 붙는다.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  message: string;
}

type Listener = (entry: LogEntry) => void;

export class Logger {
  private entries: LogEntry[] = [];
  private listeners = new Set<Listener>();

  constructor(
    private readonly capacity = 500,
    private readonly now: () => number = () => Date.now(),
  ) {}

  log(level: LogLevel, message: string, data?: unknown): LogEntry {
    const entry: LogEntry = { time: this.now(), level, message: data === undefined ? message : `${message} ${stringify(data)}` };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  debug(message: string, data?: unknown) { return this.log('debug', message, data); }
  info(message: string, data?: unknown) { return this.log('info', message, data); }
  warn(message: string, data?: unknown) { return this.log('warn', message, data); }
  error(message: string, data?: unknown) { return this.log('error', message, data); }

  all(): readonly LogEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toText(): string {
    return this.entries.map(formatEntry).join('\n');
  }
}

export function formatEntry(e: LogEntry): string {
  return `${new Date(e.time).toISOString()} [${e.level.toUpperCase()}] ${e.message}`;
}

function stringify(data: unknown): string {
  if (data instanceof Error) return `${data.name}: ${data.message}`;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

/** 앱 전체가 쓰는 로거 */
export const log = new Logger();

/** 잡히지 않은 오류도 로그에 남긴다. */
export function captureGlobalErrors(target: Window = window): void {
  target.addEventListener('error', (ev) => log.error('window.error', ev.error ?? ev.message));
  target.addEventListener('unhandledrejection', (ev) => log.error('unhandledrejection', ev.reason));
}

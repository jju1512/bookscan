/**
 * 후처리 서비스 (앱에 하나). 화면을 옮겨 다녀도 처리가 이어지도록 실행기를 화면 밖에 둔다.
 * - 처리 중에는 Wake Lock 을 켜고 beforeunload 경고 대상에 올린다 (SPEC 8장: 화면이 켜져 있을 때만 진행).
 * - 책 전체를 끝까지 처리하면 PDF 를 만들고, 드라이브 연동 중이면 대기열에 넣는다.
 * - OpenCV worker 와 Tesseract worker 는 처리할 때만 만들고, 끝나면 정리해 메모리를 돌려준다.
 */
import { WakeLockHold } from '../app/wakelock';
import { getParams } from '../config';
import { getSettings } from '../config/settings';
import { log } from '../debug/log';
import { busy } from '../storage/busy';
import type { Repo } from '../storage/repo';
import { WorkerExecutor } from './client';
import { TesseractEngine } from './ocr/ocr';
import { ProcessRunner, type RunProgress } from './runner';

export interface ServiceState {
  bookId: string | null;
  running: boolean;
  progress: RunProgress | null;
  /** 마지막 실행 결과 메시지 */
  message?: string;
  pdf?: { bookId: string; path: string; name: string; textPages: number; pages: number; textError?: string };
}

type AfterPdf = (bookId: string, path: string, name: string) => Promise<void> | void;

export class ProcessService {
  private executor: WorkerExecutor | null = null;
  private ocr: TesseractEngine | null = null;
  private runner: ProcessRunner | null = null;
  private wake = new WakeLockHold();
  private listeners = new Set<(s: ServiceState) => void>();
  state: ServiceState = { bookId: null, running: false, progress: null };
  afterPdf: AfterPdf | null = null;

  constructor(private readonly repo: Repo) {
    busy.register('process', () => (this.state.running ? '후처리 중' : null));
  }

  onChange(fn: (s: ServiceState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<ServiceState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  private ensure(): ProcessRunner {
    this.executor ??= new WorkerExecutor();
    if (!this.runner) {
      this.runner = new ProcessRunner({
        repo: this.repo,
        executor: { runImageStep: (...a) => this.executor!.runImageStep(...a), dispose: () => {} },
        ocr: () => (this.ocr ??= new TesseractEngine()),
        settings: () => {
          const s = getSettings();
          return { steps: s.steps, enhanceBinarize: s.enhanceBinarize, maxEdge: getParams().PROCESS_MAX_EDGE };
        },
        log: (level, msg, data) => log[level](msg, data),
      });
      this.runner.onProgress((p) => this.set({ progress: p }));
    }
    return this.runner;
  }

  /** 처리 시작. pageIds 를 주면 그 페이지만. 끝까지 하면 makePdf 가 true 일 때 PDF 를 만든다 */
  async start(bookId: string, opts: { pageIds?: string[]; makePdf?: boolean } = {}): Promise<void> {
    if (this.state.running) return;
    const runner = this.ensure();
    this.set({ bookId, running: true, message: undefined, progress: null });
    await this.wake.acquire();
    const t0 = performance.now();
    try {
      const finished = await runner.run(bookId, { pageIds: opts.pageIds });
      log.info(`후처리 ${finished ? '완료' : '멈춤'} (${Math.round((performance.now() - t0) / 1000)}초)`);
      if (!finished) {
        this.set({ message: '멈췄습니다. "이어서 처리"를 누르면 끝나지 않은 단계부터 이어서 합니다.' });
        return;
      }
      const book = await this.repo.getBook(bookId);
      if ((opts.makePdf ?? true) && book?.processState === 'done') await this.makePdf(bookId);
      else this.set({ message: '처리를 마쳤습니다.' });
    } catch (e) {
      log.error('후처리 실패', e);
      this.set({ message: `후처리 중 오류: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      this.set({ running: false });
      await this.wake.release();
      await this.release();
    }
  }

  stop(): void {
    this.runner?.stop();
    this.set({ message: '현재 단계가 끝나면 멈춥니다…' });
  }

  async makePdf(bookId: string): Promise<void> {
    const { exportBookPdf } = await import('../export/bookPdf');
    this.set({ message: 'PDF 를 만드는 중…' });
    const r = await exportBookPdf(this.repo, bookId, { onPage: (d, t) => this.set({ message: `PDF 를 만드는 중… ${d}/${t}쪽` }) });
    this.set({
      pdf: { bookId, path: r.path, name: r.name, textPages: r.textPages, pages: r.pages, textError: r.textError },
      message: `PDF 를 만들었습니다 (${r.pages}쪽, 검색 가능 ${r.textPages}쪽)${r.textError ? ` — ${r.textError}` : ''}`,
    });
    log.info('PDF 생성', { pages: r.pages, textPages: r.textPages, bytes: r.file.size });
    await this.afterPdf?.(bookId, r.path, r.name);
  }

  /** worker 들을 닫아 메모리를 돌려준다 (다음 처리 때 다시 만든다) */
  private async release(): Promise<void> {
    this.executor?.dispose();
    this.executor = null;
    await this.ocr?.dispose();
    this.ocr = null;
    this.runner = null;
  }
}

let service: ProcessService | null = null;
export function processService(repo: Repo): ProcessService {
  service ??= new ProcessService(repo);
  return service;
}

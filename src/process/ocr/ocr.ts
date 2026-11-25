/**
 * OCR (SPEC 8장): Tesseract.js (kor+eng). 페이지 텍스트와 단어별 좌표를 저장한다.
 * - worker·코어(WASM)·언어 데이터는 같은 출처의 vendor/ 에서 받는다 (scripts/copy-vendor.mjs). CDN 을 쓰지 않는다.
 *   언어 데이터는 처음 쓸 때 받아 서비스 워커 캐시와 Tesseract 의 IndexedDB 캐시에 남는다.
 * - 단어 좌표는 이미지 크기에 대한 비율(0~1)로 바꿔 둔다 (PDF 페이지 크기와 상관없이 쓰려고).
 * 실패하면 텍스트 없이 PDF 를 만든다 (runner 가 처리).
 */
import type { OcrWord } from '../../storage/types';

export interface OcrResult {
  text: string;
  words: OcrWord[];
  /** 평균 신뢰도 (0~100) */
  confidence: number;
}

export interface OcrEngine {
  recognize(image: Blob): Promise<OcrResult>;
  dispose(): Promise<void>;
}

/** Tesseract 결과에서 쓰는 모양만 (v5~7 공통) */
export interface TessWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
export interface TessData {
  text: string;
  confidence?: number;
  blocks?: Array<{ paragraphs: Array<{ lines: Array<{ words: TessWord[] }> }> }> | null;
}

export function tessWords(data: TessData): TessWord[] {
  const out: TessWord[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) out.push(w);
  return out;
}

/** 단어 상자를 비율 좌표로. 빈 단어·신뢰도 아주 낮은 단어·이미지 밖 상자는 뺀다 */
export function normalizeWords(words: TessWord[], width: number, height: number, minConfidence = 10): OcrWord[] {
  const out: OcrWord[] = [];
  for (const w of words) {
    const t = w.text.trim();
    if (!t || w.confidence < minConfidence) continue;
    const x0 = Math.max(0, Math.min(width, w.bbox.x0));
    const x1 = Math.max(0, Math.min(width, w.bbox.x1));
    const y0 = Math.max(0, Math.min(height, w.bbox.y0));
    const y1 = Math.max(0, Math.min(height, w.bbox.y1));
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ t, x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height });
  }
  return out;
}

/** 브라우저용 Tesseract 엔진. 처음 recognize 때 worker 를 만든다 */
export class TesseractEngine implements OcrEngine {
  private worker: Promise<{ recognize: (img: Blob, o?: object, out?: object) => Promise<{ data: TessData }>; terminate: () => Promise<unknown> }> | null = null;

  constructor(
    private readonly base: string = import.meta.env.BASE_URL,
    private readonly langs = 'kor+eng',
  ) {}

  private get(): NonNullable<TesseractEngine['worker']> {
    this.worker ??= (async () => {
      const { createWorker, OEM } = await import('tesseract.js');
      const abs = (p: string) => new URL(`${this.base.replace(/\/?$/, '/')}${p}`, location.href).href;
      const w = await createWorker(this.langs, OEM.LSTM_ONLY, {
        workerPath: abs('vendor/tesseract/worker.min.js'),
        corePath: abs('vendor/tesseract/'),
        langPath: abs('vendor/tessdata'),
        workerBlobURL: false,
        gzip: true,
      });
      return w as unknown as Awaited<NonNullable<TesseractEngine['worker']>>;
    })();
    return this.worker;
  }

  async recognize(image: Blob): Promise<OcrResult> {
    const w = await this.get();
    const bmp = await createImageBitmap(image);
    const { width, height } = bmp;
    bmp.close();
    const { data } = await w.recognize(image, {}, { blocks: true, text: true });
    const words = normalizeWords(tessWords(data), width, height);
    return { text: (data.text ?? '').trim(), words, confidence: data.confidence ?? 0 };
  }

  async dispose(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await (await w).terminate().catch(() => {});
  }
}

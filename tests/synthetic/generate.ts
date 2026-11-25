/**
 * 합성 테스트 이미지 세트를 tests/fixtures/synthetic/ 에 만든다 (PNG + 같은 이름의 정답 .json).
 *
 *   node tests/synthetic/generate.ts              # 전부
 *   node tests/synthetic/generate.ts spread-curved ocr-ko   # 이름으로 골라서
 *   node tests/synthetic/generate.ts --out <폴더>  # 다른 곳에 쓰기
 *
 * 같은 명령은 항상 같은 바이트를 낸다 (시드 고정).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawPage } from './page.ts';
import { savePng } from './raster.ts';
import type { RgbaImage } from './raster.ts';
import { renderScene } from './scene.ts';
import type { Quad, SceneSpec, SceneTruth } from './scene.ts';

export const DEFAULT_OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/synthetic');

const OUT_W = 1600;
const OUT_H = 1150;

function quad(tl: [number, number], tr: [number, number], br: [number, number], bl: [number, number]): Quad {
  return [
    { x: tl[0], y: tl[1] },
    { x: tr[0], y: tr[1] },
    { x: br[0], y: br[1] },
    { x: bl[0], y: bl[1] },
  ];
}

/** 펼침 장면 공통 뼈대 */
function spread(seed: number, q: Quad, extra: Partial<SceneSpec> = {}): SceneSpec {
  return { seed, mode: 'spread', outWidth: OUT_W, outHeight: OUT_H, quad: q, ...extra };
}

export const SCENES: Record<string, SceneSpec> = {
  // 정면에 가깝다. 위가 아주 조금 좁다
  'spread-flat': spread(101, quad([130, 105], [1478, 92], [1490, 1050], [118, 1060])),
  // 강한 원근: 위쪽이 아래쪽보다 훨씬 좁은 사다리꼴
  'spread-perspective': spread(102, quad([250, 130], [1330, 85], [1555, 1085], [45, 1050])),
  // 원근 + 휘어짐 (책등 쪽으로 글자 줄이 눈에 띄게 처진다)
  'spread-curved': spread(103, quad([170, 105], [1440, 78], [1530, 1030], [95, 1050]), { curve: 0.045 }),
  // 손가락이 바깥 여백에만 있다 (좌·우 가장자리)
  'spread-finger-margin': spread(104, quad([135, 100], [1475, 88], [1488, 1048], [122, 1058]), {
    fingers: [
      { edge: 'left', along: 0.55, reach: 0.04, radius: 32 },
      { edge: 'right', along: 0.33, reach: 0.04, radius: 32, angleDeg: -6 },
    ],
  }),
  // 손가락이 본문 글자를 덮는다 (아래에서 올라온 것, 오른쪽에서 들어온 것)
  'spread-finger-text': spread(105, quad([140, 98], [1470, 92], [1480, 1052], [125, 1056]), {
    curve: 0.03,
    fingers: [
      { edge: 'bottom', along: 0.27, reach: 0.3, radius: 34 },
      { edge: 'right', along: 0.45, reach: 0.15, radius: 30, angleDeg: 12 },
    ],
  }),
  // 왼쪽 페이지는 대부분 그림 + 설명 두 줄, 오른쪽은 일반 본문
  'spread-figure': spread(106, quad([150, 100], [1465, 85], [1495, 1050], [120, 1062]), {
    curve: 0.03,
    pages: {
      left: {
        figure: { rect: { x: 62, y: 80, w: 590, h: 690 }, style: 'gradient' },
        lines: ['그림 3. 합성 도판의 예', '밝기가 서서히 바뀌는 그림이다.'],
        firstBaselineY: 835,
        maxLines: 2,
      },
    },
  }),
  // 한 페이지만 책상 위에 놓은 장면 (세로 사진)
  'page-flat': {
    seed: 107,
    mode: 'single',
    outWidth: 1100,
    outHeight: 1500,
    quad: quad([118, 92], [988, 78], [1012, 1412], [92, 1398]),
  },
};

/** OCR 용 정답 줄: 한국어 6줄 + 영어 1줄 (한 줄이 본문 폭 1000px 안에 들어가야 한다) */
const OCR_LINES: string[] = [
  '오래된 도서관의 서가 사이로 오후의',
  '햇살이 길게 들어왔다. 먼지가 천천히',
  '떠다니는 것을 바라보며 그는 낡은',
  'The quick brown fox jumps over 12 lazy dogs.',
  '책의 표지를 조심스럽게 쓸어 보았다.',
  '문자 인식은 글자가 또렷할수록 정확해진다.',
  '사진은 흔들리지 않게, 밝고 고르게 찍자.',
];

export interface OcrTruth {
  kind: 'ocr';
  width: number;
  height: number;
  sizePx: number;
  /** 줄 단위 정답. text 를 \n 으로 이으면 전체 정답 */
  lines: Array<{ text: string; lang: 'ko' | 'en'; baselineY: number; x0: number; x1: number }>;
  text: string;
}

export function renderOcr(): { image: RgbaImage; truth: OcrTruth } {
  const width = 1200;
  const height = 1600;
  const page = drawPage({
    width,
    height,
    side: 'single',
    seed: 201,
    sizePx: 38,
    lineHeight: 130,
    margins: { top: 200, bottom: 200, outer: 100, inner: 100 },
    lines: OCR_LINES,
    firstBaselineY: 300,
    noise: 0.3,
  });
  for (const l of page.lines) {
    if (l.x1 > page.textRect.x + page.textRect.w) throw new Error(`OCR 줄이 본문 폭을 넘었다: ${l.text}`);
  }
  if (page.lines.length !== OCR_LINES.length) throw new Error('OCR 줄이 모두 놓이지 않았다');
  const truth: OcrTruth = {
    kind: 'ocr',
    width,
    height,
    sizePx: 38,
    lines: page.lines.map((l) => ({
      text: l.text,
      lang: l.lang,
      baselineY: l.baselineY,
      x0: Math.round(l.x0 * 100) / 100,
      x1: Math.round(l.x1 * 100) / 100,
    })),
    text: page.lines.map((l) => l.text).join('\n'),
  };
  return { image: page.image, truth };
}

export const NAMES: string[] = [...Object.keys(SCENES), 'ocr-ko'];

export function build(name: string): { image: RgbaImage; truth: SceneTruth | OcrTruth } {
  if (name === 'ocr-ko') return renderOcr();
  const spec = SCENES[name];
  if (!spec) throw new Error(`알 수 없는 이름: ${name} (가능: ${NAMES.join(', ')})`);
  return renderScene(spec);
}

function main(argv: string[]): void {
  let out = DEFAULT_OUT;
  const names: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--out') out = resolve(argv[++i] ?? '');
    else names.push(a);
  }
  const todo = names.length > 0 ? names : NAMES;
  mkdirSync(out, { recursive: true });
  let total = 0;
  for (const name of todo) {
    const t0 = Date.now();
    const { image, truth } = build(name);
    const bytes = savePng(resolve(out, `${name}.png`), image);
    writeFileSync(resolve(out, `${name}.json`), `${JSON.stringify({ name, ...truth }, null, 2)}\n`);
    total += bytes;
    console.log(`${name}.png  ${image.width}x${image.height}  ${(bytes / 1024).toFixed(0)} KB  (${Date.now() - t0} ms)`);
  }
  console.log(`합계 ${(total / 1024 / 1024).toFixed(2)} MB -> ${out}`);
}

// 직접 실행했을 때만 만든다 (vitest 가 import 할 때는 실행하지 않는다)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

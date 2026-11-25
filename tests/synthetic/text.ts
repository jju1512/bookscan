/**
 * fontkit 글리프 외곽선을 직접 래스터화하는 작은 글자 그리기 도구.
 *
 * - 곡선(2차·3차 베지어)을 선분으로 펴고, non-zero 감기 규칙의 스캔라인으로 채운다.
 * - 세로는 픽셀당 SUB_Y 개의 부분 스캔라인으로, 가로는 부분 스캔라인과 외곽선 교점 사이의 구간을 실수 좌표 그대로 면적 계산해
 *   (가로 무한 슈퍼샘플링과 같다) 안티앨리어싱한다.
 * - 줄 하나만큼의 작은 커버리지 버퍼를 쓴다. 큰 이미지 전체를 슈퍼샘플링하지 않으므로 메모리가 적게 든다.
 */
import { readFileSync } from 'node:fs';
import * as fontkitNs from '@pdf-lib/fontkit';
import type { Font } from '@pdf-lib/fontkit';
import { blendPixel } from './raster.ts';
import type { Rgb, RgbaImage } from './raster.ts';

/** 세로 방향 부분 스캔라인 수 */
const SUB_Y = 5;

// Node 는 CJS(UMD) 패키지를 default 로, vite 변환은 이름 있는 내보내기로 줄 수 있다. 둘 다 받는다.
const fontkit = ((fontkitNs as unknown as { default?: typeof fontkitNs }).default ?? fontkitNs) as typeof fontkitNs;

/** fontkit 타입 정의에는 없지만 실제 Path 객체가 가진 명령 배열 */
interface PathCommand {
  command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
  args: number[];
}

interface PlacedGlyph {
  id: number;
  /** 글꼴 단위의 펜 위치 (xOffset 포함) */
  x: number;
  y: number;
}

interface TextLayout {
  glyphs: PlacedGlyph[];
  /** 글꼴 단위의 전체 폭 */
  advance: number;
}

let fontCache: Font | undefined;
const layoutCache = new Map<string, TextLayout>();
const commandCache = new Map<number, PathCommand[]>();

/** 번들된 나눔고딕 (public/fonts, OFL). 처음 부를 때 한 번만 읽는다 */
export function getFont(): Font {
  if (!fontCache) {
    const buf = readFileSync(new URL('../../public/fonts/NanumGothic-Regular.ttf', import.meta.url));
    fontCache = fontkit.create(buf);
  }
  return fontCache;
}

function layoutOf(text: string): TextLayout {
  const hit = layoutCache.get(text);
  if (hit) return hit;
  const font = getFont();
  const run = font.layout(text);
  const glyphs: PlacedGlyph[] = [];
  let pen = 0;
  let penY = 0;
  run.glyphs.forEach((g, i) => {
    const p = run.positions[i]!;
    glyphs.push({ id: g.id, x: pen + p.xOffset, y: penY + p.yOffset });
    pen += p.xAdvance;
    penY += p.yAdvance;
    if (!commandCache.has(g.id)) {
      commandCache.set(g.id, (g.path as unknown as { commands: PathCommand[] }).commands);
    }
  });
  const layout = { glyphs, advance: pen };
  if (layoutCache.size > 5000) layoutCache.clear();
  layoutCache.set(text, layout);
  return layout;
}

/** sizePx 로 그렸을 때의 가로 폭(px) */
export function measureText(text: string, sizePx: number): number {
  return (layoutOf(text).advance * sizePx) / getFont().unitsPerEm;
}

/** 곡선을 평탄화하며 모은 모서리 목록. [x0, y0, x1, y1] 이 연달아 들어간다 */
function buildEdges(layout: TextLayout, x: number, baselineY: number, sizePx: number): number[] {
  const s = sizePx / getFont().unitsPerEm;
  const edges: number[] = [];
  for (const g of layout.glyphs) {
    const cmds = commandCache.get(g.id) ?? [];
    const ox = x + g.x * s;
    const oy = baselineY - g.y * s;
    let sx = 0;
    let sy = 0;
    let cx = 0;
    let cy = 0;
    let open = false;
    const line = (x1: number, y1: number): void => {
      if (y1 !== cy) edges.push(cx, cy, x1, y1);
      cx = x1;
      cy = y1;
    };
    const closeSub = (): void => {
      if (open) line(sx, sy);
      open = false;
    };
    for (const c of cmds) {
      const a = c.args;
      switch (c.command) {
        case 'moveTo':
          closeSub();
          sx = cx = ox + a[0]! * s;
          sy = cy = oy - a[1]! * s;
          open = true;
          break;
        case 'lineTo':
          line(ox + a[0]! * s, oy - a[1]! * s);
          break;
        case 'quadraticCurveTo': {
          const x1 = ox + a[0]! * s;
          const y1 = oy - a[1]! * s;
          const x2 = ox + a[2]! * s;
          const y2 = oy - a[3]! * s;
          const len = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1);
          const n = Math.max(2, Math.min(24, Math.ceil(len / 1.5)));
          const x0 = cx;
          const y0 = cy;
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            const u = 1 - t;
            line(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2);
          }
          break;
        }
        case 'bezierCurveTo': {
          const x1 = ox + a[0]! * s;
          const y1 = oy - a[1]! * s;
          const x2 = ox + a[2]! * s;
          const y2 = oy - a[3]! * s;
          const x3 = ox + a[4]! * s;
          const y3 = oy - a[5]! * s;
          const len = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
          const n = Math.max(2, Math.min(32, Math.ceil(len / 1.5)));
          const x0 = cx;
          const y0 = cy;
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            const u = 1 - t;
            const b0 = u * u * u;
            const b1 = 3 * u * u * t;
            const b2 = 3 * u * t * t;
            const b3 = t * t * t;
            line(b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3);
          }
          break;
        }
        case 'closePath':
          closeSub();
          break;
      }
    }
    closeSub();
  }
  return edges;
}

/**
 * 글자를 그린다. (x, baselineY) 는 첫 글자 펜 위치의 왼쪽과 기준선, sizePx 는 em 크기(px).
 * 그린 글자의 가로 폭(px)을 돌려준다.
 */
export function drawText(
  img: RgbaImage,
  text: string,
  x: number,
  baselineY: number,
  sizePx: number,
  color: Rgb,
  alpha = 1,
): number {
  const layout = layoutOf(text);
  const width = (layout.advance * sizePx) / getFont().unitsPerEm;
  const edges = buildEdges(layout, x, baselineY, sizePx);
  const ne = edges.length / 4;
  if (ne === 0) return width;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < edges.length; i += 2) {
    const ex = edges[i]!;
    const ey = edges[i + 1]!;
    if (ex < minX) minX = ex;
    if (ex > maxX) maxX = ex;
    if (ey < minY) minY = ey;
    if (ey > maxY) maxY = ey;
  }
  // 이미지 안쪽으로 자른 커버리지 버퍼 범위
  const bx0 = Math.max(0, Math.floor(minX) - 1);
  const bx1 = Math.min(img.width, Math.ceil(maxX) + 1);
  const by0 = Math.max(0, Math.floor(minY) - 1);
  const by1 = Math.min(img.height, Math.ceil(maxY) + 1);
  const bw = bx1 - bx0;
  const bh = by1 - by0;
  if (bw <= 0 || bh <= 0) return width;

  // 행마다 걸치는 모서리를 미리 모아 둔다
  const rowEdges: number[][] = Array.from({ length: bh }, () => []);
  for (let e = 0; e < ne; e++) {
    const ya = edges[e * 4 + 1]!;
    const yb = edges[e * 4 + 3]!;
    const r0 = Math.max(by0, Math.floor(Math.min(ya, yb)));
    const r1 = Math.min(by1 - 1, Math.floor(Math.max(ya, yb)));
    for (let r = r0; r <= r1; r++) rowEdges[r - by0]!.push(e);
  }

  const cov = new Float32Array(bw * bh);
  const wgt = 1 / SUB_Y;
  const xs: number[] = [];
  const ds: number[] = [];
  for (let row = 0; row < bh; row++) {
    const cand = rowEdges[row]!;
    if (cand.length === 0) continue;
    const base = row * bw;
    for (let k = 0; k < SUB_Y; k++) {
      const sy = by0 + row + (k + 0.5) / SUB_Y;
      xs.length = 0;
      ds.length = 0;
      for (const e of cand) {
        const x0 = edges[e * 4]!;
        const y0 = edges[e * 4 + 1]!;
        const x1 = edges[e * 4 + 2]!;
        const y1 = edges[e * 4 + 3]!;
        let dir = 0;
        if (y0 < y1) {
          if (sy >= y0 && sy < y1) dir = 1;
        } else if (sy >= y1 && sy < y0) dir = -1;
        if (dir === 0) continue;
        const cxp = x0 + ((sy - y0) * (x1 - x0)) / (y1 - y0);
        // 삽입 정렬 (교점은 줄당 많아야 수십 개)
        let j = xs.length;
        xs.push(cxp);
        ds.push(dir);
        while (j > 0 && xs[j - 1]! > cxp) {
          xs[j] = xs[j - 1]!;
          ds[j] = ds[j - 1]!;
          j--;
        }
        xs[j] = cxp;
        ds[j] = dir;
      }
      let wind = 0;
      let start = 0;
      for (let i = 0; i < xs.length; i++) {
        const before = wind;
        wind += ds[i]!;
        if (before === 0 && wind !== 0) start = xs[i]!;
        else if (before !== 0 && wind === 0) addSpan(cov, base, bw, bx0, start, xs[i]!, wgt);
      }
    }
  }

  for (let row = 0; row < bh; row++) {
    for (let col = 0; col < bw; col++) {
      const v = cov[row * bw + col]!;
      if (v <= 0.002) continue;
      blendPixel(img, bx0 + col, by0 + row, color[0], color[1], color[2], alpha * (v >= 1 ? 1 : v));
    }
  }
  return width;
}

/** [xa, xb) 구간이 덮는 면적 비율(× weight)을 한 행에 더한다 */
function addSpan(cov: Float32Array, base: number, bw: number, bx0: number, xa: number, xb: number, weight: number): void {
  let a = xa - bx0;
  let b = xb - bx0;
  if (b <= 0 || a >= bw) return;
  if (a < 0) a = 0;
  if (b > bw) b = bw;
  if (b <= a) return;
  const i0 = Math.floor(a);
  const i1 = Math.floor(b);
  if (i0 === i1) {
    cov[base + i0]! += (b - a) * weight;
    return;
  }
  cov[base + i0]! += (i0 + 1 - a) * weight;
  for (let i = i0 + 1; i < i1; i++) cov[base + i]! += weight;
  if (i1 < bw) cov[base + i1]! += (b - i1) * weight;
}

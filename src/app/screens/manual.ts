/**
 * 수동 보정 (SPEC 8장 자르기 "실패하면"): 원본 위에서 책 외곽 꼭짓점 4개와 (펼침이면) 분할선을 끌어 맞춘다.
 * 저장하면 같은 촬영의 두 페이지(왼쪽·오른쪽)에 같은 값을 넣고 자르기부터 다시 처리한다.
 * 좌표는 원본 비율(0~1). 분할선은 원근 보정한 이미지 폭에 대한 비율이라, 화면에는 호모그래피로 되돌려 그린다.
 */
import { applyH, homography, orderCorners, type Pt } from '../../process/geom';
import { processService } from '../../process/service';
import type { Page } from '../../storage/types';
import type { Screen } from '../context';
import { clear, h } from '../dom';
import { toast } from '../ui';

const SVG = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export const manualScreen: Screen = (ctx, route, root) => {
  if (route.name !== 'manual') return;
  const box = h('div', { class: 'manual-box' });
  const info = h('p', { class: 'muted small' }, '모서리의 동그라미를 끌어 책(또는 페이지) 외곽에 맞추세요. 펼친 책이면 가운데 세로선을 책등에 맞추세요.');
  const actions = h('div', { class: 'row-actions wrap' });
  root.append(h('section', { class: 'page' }, h('header', { class: 'page-head' }, h('h1', {}, '수동 보정')), info, box, actions));
  let url = '';
  /** 처리 중이면 시작하지 못한다 → 그렇다고 알린다 (조용히 무시하지 않는다) */
  const startOrTell = (bookId: string, pageIds: string[], okMsg: string) => {
    const svc = processService(ctx.repo);
    if (svc.state.running) {
      toast('보정값을 저장했습니다. 지금 다른 처리가 진행 중이라, 끝난 뒤 후처리 화면에서 "이어서 처리"를 누르세요.', 'info', 6000);
      return;
    }
    toast(okMsg, 'ok');
    void svc.start(bookId, { pageIds, makePdf: false });
  };

  void (async () => {
    const page = await ctx.repo.getPage(route.pageId);
    if (!page) {
      box.append(h('p', {}, '페이지를 찾을 수 없습니다.'));
      return;
    }
    const cap = await ctx.repo.getCapture(page.captureId);
    const blob = cap ? await ctx.repo.files.read(cap.file) : null;
    if (!cap || !blob) {
      box.append(h('p', {}, '원본이 이 기기에 없습니다 (로컬 정리됨). 드라이브에서 다시 불러온 뒤 보정하세요.'));
      return;
    }
    const bmp = await createImageBitmap(blob);
    const W = bmp.width;
    const H = bmp.height;
    bmp.close();
    url = URL.createObjectURL(blob);
    const spread = page.side !== 'single';
    const start = page.manual?.corners ?? page.auto?.corners ?? [0.05, 0.05, 0.95, 0.05, 0.95, 0.95, 0.05, 0.95];
    const corners: Pt[] = [0, 1, 2, 3].map((i) => [start[i * 2]! * W, start[i * 2 + 1]! * H]);
    let split = page.manual?.splitX ?? page.auto?.splitX ?? 0.5;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'manual-svg', 'aria-label': '꼭짓점과 분할선 맞추기' });
    svg.append(svgEl('image', { href: url, x: 0, y: 0, width: W, height: H }));
    const poly = svgEl('polygon', { class: 'm-poly', 'vector-effect': 'non-scaling-stroke' });
    const spine = svgEl('line', { class: 'm-spine', 'vector-effect': 'non-scaling-stroke' });
    svg.append(poly, spine);
    const r = Math.max(W, H) * 0.018;
    const handles = corners.map(() => svgEl('circle', { r, class: 'm-handle', tabindex: 0 }));
    const splitHandle = svgEl('circle', { r, class: 'm-handle m-split', tabindex: 0 });
    handles.forEach((c) => svg.append(c));
    if (spread) svg.append(splitHandle);
    box.append(svg);

    /** 원근 보정 좌표(단위 정사각형) → 원본 좌표 */
    const unitToImg = () => homography([[0, 0], [1, 0], [1, 1], [0, 1]], orderCorners(corners));
    const draw = () => {
      poly.setAttribute('points', corners.map((p) => p.join(',')).join(' '));
      corners.forEach((p, i) => {
        handles[i]!.setAttribute('cx', String(p[0]));
        handles[i]!.setAttribute('cy', String(p[1]));
      });
      const Hm = unitToImg();
      if (spread && Hm) {
        const top = applyH(Hm, [split, 0]);
        const bot = applyH(Hm, [split, 1]);
        spine.setAttribute('x1', String(top[0]));
        spine.setAttribute('y1', String(top[1]));
        spine.setAttribute('x2', String(bot[0]));
        spine.setAttribute('y2', String(bot[1]));
        const mid = applyH(Hm, [split, 0.5]);
        splitHandle.setAttribute('cx', String(mid[0]));
        splitHandle.setAttribute('cy', String(mid[1]));
      }
    };
    draw();

    const toImg = (ev: PointerEvent): Pt => {
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const m = svg.getScreenCTM();
      const p = m ? pt.matrixTransform(m.inverse()) : pt;
      return [Math.max(0, Math.min(W, p.x)), Math.max(0, Math.min(H, p.y))];
    };
    let drag: number | 'split' | null = null;
    handles.forEach((c, i) =>
      c.addEventListener('pointerdown', (ev) => {
        drag = i;
        svg.setPointerCapture(ev.pointerId);
      }),
    );
    splitHandle.addEventListener('pointerdown', (ev) => {
      drag = 'split';
      svg.setPointerCapture(ev.pointerId);
    });
    svg.addEventListener('pointermove', (ev) => {
      if (drag === null) return;
      const p = toImg(ev);
      if (drag === 'split') {
        const Hm = unitToImg();
        const inv = Hm && homography(orderCorners(corners), [[0, 0], [1, 0], [1, 1], [0, 1]]);
        if (inv) split = Math.max(0.2, Math.min(0.8, applyH(inv, p)[0]));
      } else {
        corners[drag] = p;
      }
      draw();
    });
    const endDrag = () => {
      drag = null;
    };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);

    const save = async () => {
      const ordered = orderCorners(corners);
      const norm = ordered.flatMap(([x, y]) => [x / W, y / H]);
      const siblings = (await ctx.repo.listPages(page.bookId)).filter((p) => p.captureId === page.captureId);
      for (const sp of siblings) {
        await ctx.repo.updatePage(sp.id, (p: Page) => ({ ...p, manual: { corners: norm, ...(spread ? { splitX: split } : {}) } }));
        await ctx.repo.resetPageSteps(sp.id, 'crop');
      }
      startOrTell(page.bookId, siblings.map((s) => s.id), '보정값을 저장했습니다. 이 촬영을 다시 처리합니다.');
      ctx.go({ name: 'compare', bookId: page.bookId, pageId: page.id });
    };
    const resetAuto = async () => {
      const siblings = (await ctx.repo.listPages(page.bookId)).filter((p) => p.captureId === page.captureId);
      for (const sp of siblings) {
        await ctx.repo.updatePage(sp.id, (p: Page) => {
          const n = { ...p };
          delete n.manual;
          return n;
        });
        await ctx.repo.resetPageSteps(sp.id, 'crop');
      }
      startOrTell(page.bookId, siblings.map((s) => s.id), '자동 검출로 되돌렸습니다. 다시 처리합니다.');
      ctx.go({ name: 'process', bookId: page.bookId });
    };
    clear(actions);
    actions.append(
      h('button', { type: 'button', class: 'btn btn-primary btn-big', onclick: () => void save() }, '저장하고 다시 처리'),
      page.manual ? h('button', { type: 'button', class: 'btn', onclick: () => void resetAuto() }, '자동 검출로 되돌리기') : '',
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => history.back() }, '취소'),
    );
  })();

  return () => {
    if (url) URL.revokeObjectURL(url);
  };
};

/** motion · change · sharpness 실시간 그래프 (SPEC 6장 디버그 패널). 캔버스에 직접 그린다. */

export interface GraphSample {
  t: number;
  motion: number;
  change: number;
  sharpness: number;
  state: string;
  /** 이 시점에 촬영했다 */
  shot?: boolean;
}

export interface GraphThresholds {
  STILL: number;
  MOVE: number;
  CHANGE_MIN: number;
}

const COLORS = { motion: '#60a5fa', change: '#f59e0b', sharpness: '#34d399', shot: '#f87171', grid: '#2c3746', text: '#a9b3c1' };
const STATE_COLORS: Record<string, string> = {
  WAIT_STABLE: '#334155',
  CHECK: '#7c3aed',
  CAPTURE: '#dc2626',
  ARMED: '#065f46',
  TURNING: '#b45309',
  PAUSED: '#1f2937',
};

/** motion/change 세로축 최대값 (비율). 이보다 크면 위에 붙인다 */
export const RATIO_MAX = 0.2;

export function drawGraph(canvas: HTMLCanvasElement, samples: readonly GraphSample[], th: GraphThresholds, windowMs = 10_000): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 140;
  if (canvas.width !== Math.round(cssW * dpr)) canvas.width = Math.round(cssW * dpr);
  if (canvas.height !== Math.round(cssH * dpr)) canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = cssW;
  const H = cssH;
  const plotH = H - 14;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, W, H);
  if (samples.length === 0) return;
  const tEnd = samples[samples.length - 1]!.t;
  const tStart = tEnd - windowMs;
  const x = (t: number) => ((t - tStart) / windowMs) * W;
  const yRatio = (v: number) => plotH - (Math.min(v, RATIO_MAX) / RATIO_MAX) * plotH;
  const visible = samples.filter((s) => s.t >= tStart);

  // 상태 띠 (아래 14px)
  for (let i = 0; i < visible.length; i++) {
    const s = visible[i]!;
    const next = visible[i + 1]?.t ?? tEnd;
    ctx.fillStyle = STATE_COLORS[s.state] ?? '#333';
    ctx.fillRect(x(s.t), plotH + 2, Math.max(1, x(next) - x(s.t)), 12);
  }
  // 기준선
  const hline = (v: number, color: string, label: string) => {
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yRatio(v));
    ctx.lineTo(W, yRatio(v));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = '10px system-ui';
    ctx.fillText(label, 4, yRatio(v) - 2);
  };
  hline(th.STILL, '#3b82f680', `STILL ${(th.STILL * 100).toFixed(1)}%`);
  hline(th.MOVE, '#3b82f6', `MOVE ${(th.MOVE * 100).toFixed(1)}%`);
  hline(th.CHANGE_MIN, '#f59e0b', `CHANGE_MIN ${(th.CHANGE_MIN * 100).toFixed(1)}%`);

  const line = (pick: (s: GraphSample) => number, color: string, scale: (v: number) => number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    visible.forEach((s, i) => {
      const px = x(s.t);
      const py = scale(pick(s));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  };
  const sharpMax = Math.max(1, ...visible.map((s) => s.sharpness));
  line((s) => s.motion, COLORS.motion, yRatio);
  line((s) => s.change, COLORS.change, yRatio);
  line((s) => s.sharpness / sharpMax, COLORS.sharpness, (v) => plotH - v * plotH * 0.95);
  // 촬영 시점
  ctx.strokeStyle = COLORS.shot;
  ctx.lineWidth = 2;
  for (const s of visible) {
    if (!s.shot) continue;
    ctx.beginPath();
    ctx.moveTo(x(s.t), 0);
    ctx.lineTo(x(s.t), plotH);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px system-ui';
  ctx.fillText(`motion ■  change ■  sharpness(최대 ${Math.round(sharpMax)}) ■  ▏촬영`, W - 300, 10);
}

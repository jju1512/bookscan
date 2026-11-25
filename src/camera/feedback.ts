/** 촬영 피드백: 짧은 셔터음(WebAudio), 진동, 화면 테두리 깜박임 (SPEC 6장). */

let ctx: AudioContext | null = null;

/** 사용자 동작(탭) 안에서 한 번 불러 오디오를 깨워 둔다. 자동 촬영 때도 소리가 나게 하려고 */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function shutterSound(): void {
  try {
    ctx ??= new AudioContext();
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, t);
    src.connect(gain).connect(ctx.destination);
    src.start(t);
  } catch {
    // 소리를 못 내도 촬영에는 영향 없음
  }
}

export function vibrate(ms = 40): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    // 지원 안 함
  }
}

export function flashBorder(el: HTMLElement): void {
  el.classList.remove('flash');
  // 강제로 다시 그려서 애니메이션을 처음부터
  void el.offsetWidth;
  el.classList.add('flash');
}

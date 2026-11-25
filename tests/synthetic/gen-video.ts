/**
 * 페이지 넘김 합성 영상(Y4M)을 만든다. 크롬의 가짜 카메라 입력용이다.
 *
 *   node tests/synthetic/gen-video.ts <출력경로.y4m> [--width 640 --height 480 --pages 4]
 *        [--fps 15] [--seed 1] [--events handOnly:2,shake:3,blur:1,slowTurn:2]
 *
 *   chrome --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<출력경로.y4m> ...
 *
 * 출력 경로는 기본값이 없다. 영상은 크므로 커밋하지 않는 경로(예: tests/fixtures/synthetic/out/)에 쓴다.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterTurnFrames, planTurns, writeY4M } from './frames.ts';
import type { TurnEventKind, TurnScript } from './frames.ts';

const USAGE =
  '사용법: node tests/synthetic/gen-video.ts <출력경로.y4m> [--width 640 --height 480 --pages 4] [--fps 15] [--seed 1] [--events handOnly:2,shake:3]';

const KINDS: TurnEventKind[] = ['handOnly', 'shake', 'blur', 'slowTurn'];

function intArg(name: string, v: string | undefined): number {
  const n = Number(v);
  if (v === undefined || !Number.isFinite(n)) throw new Error(`${name} 값이 필요하다 (숫자)`);
  return n;
}

export function parseArgs(argv: string[]): { out: string; script: TurnScript } {
  let out: string | undefined;
  let width = 640;
  let height = 480;
  let pages = 4;
  let fps: number | undefined;
  let seed: number | undefined;
  const events: NonNullable<TurnScript['events']> = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--width') width = intArg(a, argv[++i]);
    else if (a === '--height') height = intArg(a, argv[++i]);
    else if (a === '--pages') pages = intArg(a, argv[++i]);
    else if (a === '--fps') fps = intArg(a, argv[++i]);
    else if (a === '--seed') seed = intArg(a, argv[++i]);
    else if (a === '--events') {
      for (const item of (argv[++i] ?? '').split(',').filter(Boolean)) {
        const [kind, page] = item.split(':');
        if (!KINDS.includes(kind as TurnEventKind)) throw new Error(`알 수 없는 이벤트: ${item}`);
        events.push({ kind: kind as TurnEventKind, afterPage: intArg(item, page) });
      }
    } else if (a.startsWith('--')) throw new Error(`알 수 없는 옵션: ${a}`);
    else if (out === undefined) out = a;
    else throw new Error(`출력 경로가 둘 이상이다: ${a}`);
  }
  if (out === undefined) throw new Error('출력 경로가 필요하다');
  return {
    out: resolve(out),
    script: { width, height, pages, events, ...(fps !== undefined ? { fps } : {}), ...(seed !== undefined ? { seed } : {}) },
  };
}

function main(argv: string[]): void {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { out, script } = parsed;
  const plan = planTurns(script);
  mkdirSync(dirname(out), { recursive: true });
  const r = writeY4M(out, iterTurnFrames(script), plan.fps);
  console.log(
    `${out}\n  ${plan.width}x${plan.height} @ ${plan.fps}fps, 프레임 ${r.frames}개, 길이 ${(plan.durationMs / 1000).toFixed(1)}초, ` +
      `${(r.bytes / 1024 / 1024).toFixed(1)} MB\n  기대 촬영 횟수 ${plan.expectedCaptures} (slowTurn ${plan.slowTurnCount}개 포함)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

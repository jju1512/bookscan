/** 설정: 촬영 방식, 피드백, 기본 촬영 단위, 후처리 단계, 로컬 정리, 구글 드라이브 */
import { getSettings, updateSettings, type CaptureMethod, type Settings } from '../../config/settings';
import { hasImageCapture } from '../../camera/shoot';
import { log } from '../../debug/log';
import { PROCESS_STEPS, type ProcessStepName } from '../../storage/types';
import type { Screen } from '../context';
import { clear, h } from '../dom';
import { confirmDialog, toast } from '../ui';
import { syncStatusLine } from './common';

export const STEP_LABELS: Record<ProcessStepName, string> = {
  crop: '자르기·분할',
  finger: '손가락 지우기',
  dewarp: '펴기',
  enhance: '화질 보정',
  ocr: 'OCR (글자 인식)',
};

export const settingsScreen: Screen = (ctx, _route, root) => {
  const body = h('div', { class: 'settings' });
  root.append(h('section', { class: 'page' }, h('header', { class: 'page-head' }, h('a', { href: '#/', class: 'btn btn-quiet' }, '← 목록'), h('h1', {}, '설정')), body));

  const check = (label: string, value: boolean, onChange: (v: boolean) => void, help?: string) => {
    const input = h('input', { type: 'checkbox', checked: value });
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'check' }, input, h('span', {}, label, help ? h('small', {}, help) : null));
  };

  const render = () => {
    const s = getSettings();
    clear(body);
    const method = h('select', { class: 'input', 'aria-label': '촬영 방식' });
    const opts: [CaptureMethod, string][] = [
      ['auto', '자동 (takePhoto, 느리거나 미리보기가 끊기면 스트림 프레임)'],
      ['photo', 'takePhoto 만'],
      ['frame', '스트림 프레임 캡처만'],
    ];
    for (const [v, l] of opts) method.append(h('option', { value: v, selected: s.captureMethod === v }, l));
    method.addEventListener('change', () => updateSettings({ captureMethod: method.value as CaptureMethod }));

    const mode = h('select', { class: 'input', 'aria-label': '기본 촬영 단위' }, h('option', { value: 'spread', selected: s.defaultCaptureMode === 'spread' }, '양쪽 펼침'), h('option', { value: 'single', selected: s.defaultCaptureMode === 'single' }, '한 페이지'));
    mode.addEventListener('change', () => updateSettings({ defaultCaptureMode: mode.value as Settings['defaultCaptureMode'] }));

    body.append(
      h(
        'section',
        { class: 'set-group' },
        h('h2', {}, '촬영'),
        h('label', { class: 'field' }, '촬영 방식', method, h('small', { class: 'muted' }, hasImageCapture() ? 'ImageCapture 지원됨' : '이 브라우저는 ImageCapture 가 없어 스트림 프레임으로 찍습니다')),
        h('label', { class: 'field' }, '새 책의 기본 촬영 단위', mode),
        check('셔터음', s.shutterSound, (v) => updateSettings({ shutterSound: v })),
        check('진동', s.vibrate, (v) => updateSettings({ vibrate: v })),
      ),
      h(
        'section',
        { class: 'set-group' },
        h('h2', {}, '후처리 단계'),
        h('p', { class: 'muted small' }, '끈 단계는 건너뛰고 앞 단계 결과를 씁니다. 페이지별로 건너뛰기는 후처리 화면에서 고릅니다.'),
        ...PROCESS_STEPS.map((step) => check(STEP_LABELS[step], s.steps[step], (v) => updateSettings({ steps: { ...getSettings().steps, [step]: v } }))),
        check('화질 보정에서 흑백(적응형 임계값)으로 바꾸기', s.enhanceBinarize, (v) => updateSettings({ enhanceBinarize: v }), '글자만 있는 책에 좋습니다. 그림이 많으면 끄세요.'),
        h('p', { class: 'muted small' }, '처리할 때 긴 변 최대 길이(PROCESS_MAX_EDGE, 기본 3000px)는 디버그 패널의 파라미터에서 바꿉니다.'),
      ),
      h(
        'section',
        { class: 'set-group' },
        h('h2', {}, '저장'),
        check('"로컬 정리" 버튼 보이기', s.localCleanup, (v) => updateSettings({ localCleanup: v }), '드라이브 업로드와 후처리가 모두 끝난 원본만 이 기기에서 지울 수 있게 합니다. 기본은 꺼짐.'),
      ),
      driveSection(),
    );
  };

  const driveSection = () => {
    const box = h('section', { class: 'set-group' }, h('h2', {}, '구글 드라이브 백업'));
    if (!ctx.sync.configured) {
      box.append(h('p', { class: 'muted' }, '설정 필요 — 이 배포에는 구글 OAuth 클라이언트 ID(VITE_GOOGLE_CLIENT_ID)가 없어 드라이브 기능을 쓸 수 없습니다. README 의 "구글 설정"을 참고하세요.'));
      return box;
    }
    const status = h('p', { class: 'muted small' });
    syncStatusLine(ctx, status);
    const s = getSettings();
    box.append(
      h('p', {}, s.driveEnabled ? (ctx.sync.connected() ? '연동됨' : '연동함 · 이번 실행에서 아직 로그인하지 않음') : '연동 안 함'),
      status,
      h('p', { class: 'muted small' }, '권한은 drive.file 하나만 씁니다. 이 앱이 만든 파일(내 드라이브/BookScan/)만 보이고, 드라이브에 직접 올린 파일은 보이지 않습니다. 로그인 정보는 메모리에만 두므로 앱을 다시 열면 한 번 더 연결해야 할 수 있습니다.'),
      h(
        'div',
        { class: 'row-actions' },
        !s.driveEnabled || !ctx.sync.connected()
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary',
                onclick: async () => {
                  try {
                    await ctx.sync.connect();
                    toast('드라이브에 연결했습니다', 'ok');
                  } catch (e) {
                    log.warn('드라이브 연결 실패', e);
                    toast(`연결 실패: ${e instanceof Error ? e.message : String(e)}`, 'error');
                  }
                  render();
                },
              },
              s.driveEnabled ? '드라이브 다시 연결' : '연동하기',
            )
          : null,
        s.driveEnabled
          ? h(
              'button',
              {
                type: 'button',
                class: 'btn',
                onclick: async () => {
                  if (!(await confirmDialog('드라이브 연동을 해제할까요?', { detail: '토큰을 폐기하고 업로드를 멈춥니다. 이 기기의 데이터와 드라이브에 올라간 파일은 그대로 둡니다.', ok: '연동 해제' }))) return;
                  await ctx.sync.disconnect();
                  toast('연동을 해제했습니다', 'ok');
                  render();
                },
              },
              '연동 해제',
            )
          : null,
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => ctx.go({ name: 'driveImport' }) }, '다른 기기의 책 불러오기'),
      ),
    );
    return box;
  };

  render();
  const unsub = ctx.sync.onChange(() => render());
  return () => unsub();
};

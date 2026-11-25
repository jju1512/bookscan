/** 온보딩 (SPEC 7장 흐름 1): "구글 드라이브에 백업할까요?" [연동하기] [나중에]. 설정에서 언제든 바꿀 수 있다 */
import { updateSettings } from '../../config/settings';
import { log } from '../../debug/log';
import type { Screen } from '../context';
import { h } from '../dom';
import { toast } from '../ui';

export const onboardingScreen: Screen = (ctx, _route, root) => {
  const finish = () => {
    updateSettings({ onboardingDone: true });
    ctx.go({ name: 'books' }, true);
  };
  const linkBtn = h('button', { type: 'button', class: 'btn btn-primary btn-big' }, '연동하기');
  linkBtn.addEventListener('click', async () => {
    linkBtn.disabled = true;
    try {
      await ctx.sync.connect();
      toast('드라이브에 연결했습니다. 찍은 원본이 뒤에서 올라갑니다.', 'ok');
      finish();
    } catch (e) {
      log.warn('온보딩 연동 실패', e);
      toast(`연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`, 'error', 6000);
      linkBtn.disabled = false;
    }
  });
  root.append(
    h(
      'section',
      { class: 'card' },
      h('h1', {}, '북스캔'),
      h('p', { class: 'lead' }, '구글 드라이브에 백업할까요?'),
      h(
        'p',
        { class: 'muted small' },
        '찍은 원본과 완성한 PDF 를 내 드라이브의 BookScan/ 폴더에 올립니다. 다른 기기(PC)에서 같은 책을 불러와 후처리할 수 있습니다. ' +
          '권한은 이 앱이 만든 파일만 다루는 drive.file 하나입니다. 드라이브가 끊겨도 촬영은 막히지 않습니다.',
      ),
      h('div', { class: 'row-actions wrap' }, linkBtn, h('button', { type: 'button', class: 'btn btn-big', onclick: finish }, '나중에')),
      h('p', { class: 'muted small' }, '설정에서 언제든 바꿀 수 있습니다.'),
    ),
  );
};

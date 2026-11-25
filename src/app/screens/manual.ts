/** 수동 보정 (다음 Phase 에서 구현) */
import type { Screen } from '../context';
import { h } from '../dom';

export const manualScreen: Screen = (_ctx, _route, root) => {
  root.append(h('section', { class: 'card' }, h('h1', {}, '수동 보정'), h('p', { class: 'lead' }, '아직 준비 중입니다.'), h('a', { href: '#/', class: 'btn' }, '목록으로')));
};

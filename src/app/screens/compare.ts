/** 전후 비교 (다음 Phase 에서 구현) */
import type { Screen } from '../context';
import { h } from '../dom';

export const compareScreen: Screen = (_ctx, _route, root) => {
  root.append(h('section', { class: 'card' }, h('h1', {}, '전후 비교'), h('p', { class: 'lead' }, '아직 준비 중입니다.'), h('a', { href: '#/', class: 'btn' }, '목록으로')));
};

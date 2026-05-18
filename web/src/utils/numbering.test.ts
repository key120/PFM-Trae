import { describe, expect, it } from 'vitest';
import { calculateNumbering } from './numbering';
import type { HeadingNode } from './docParser';

const h = (key: string, title: string, level: number, children: HeadingNode[] = []): HeadingNode => ({
  id: key,
  key,
  title,
  level,
  children,
});

describe('calculateNumbering', () => {
  it('空目录返回空 Map', () => {
    const result = calculateNumbering([], []);
    expect(result.size).toBe(0);
  });

  it('未勾选任何节点时返回空 Map', () => {
    const headings = [h('h1', '标题一', 1)];
    const result = calculateNumbering(headings, []);
    expect(result.size).toBe(0);
  });

  it('单层勾选生成简单序号', () => {
    const headings = [h('h1', '标题一', 1), h('h2', '标题二', 1), h('h3', '标题三', 1)];
    const result = calculateNumbering(headings, ['h1', 'h2', 'h3']);
    expect(result.get('h1')).toBe('1 ');
    expect(result.get('h2')).toBe('2 ');
    expect(result.get('h3')).toBe('3 ');
  });

  it('多层嵌套生成层级序号', () => {
    const headings = [
      h('h1', '第一章', 1, [
        h('h1-1', '第一节', 2),
        h('h1-2', '第二节', 2),
      ]),
    ];
    const result = calculateNumbering(headings, ['h1', 'h1-1', 'h1-2']);
    expect(result.get('h1')).toBe('第一章 ');
    expect(result.get('h1-1')).toBe('1.1 ');
    expect(result.get('h1-2')).toBe('1.2 ');
  });

  it('父节点未勾选但有勾选后代时仍生成序号', () => {
    const headings = [
      h('h1', '第一章', 1, [
        h('h1-1', '第一节', 2),
      ]),
    ];
    const result = calculateNumbering(headings, ['h1-1']);
    expect(result.has('h1')).toBe(true);
    expect(result.get('h1')).toBe('第一章 ');
    expect(result.get('h1-1')).toBe('1.1 ');
  });

  it('深层嵌套勾选后代时祖先都生成序号', () => {
    const headings = [
      h('h1', '第一章', 1, [
        h('h1-1', '第一节', 2, [
          h('h1-1-1', '第一小节', 3),
        ]),
      ]),
    ];
    const result = calculateNumbering(headings, ['h1-1-1']);
    expect(result.has('h1')).toBe(true);
    expect(result.has('h1-1')).toBe(true);
    expect(result.has('h1-1-1')).toBe(true);
    expect(result.get('h1')).toBe('第一章 ');
    expect(result.get('h1-1')).toBe('1.1 ');
    expect(result.get('h1-1-1')).toBe('1.1.1 ');
  });

  it('同层多个未勾选分支之间不干扰计数', () => {
    const headings = [
      h('h1', '第一章', 1, [
        h('h1-1', '第一节', 2),
        h('h1-2', '第二节', 2),
      ]),
      h('h2', '第二章', 1, [
        h('h2-1', '第一节', 2),
      ]),
    ];
    // 只勾选 h1-2 和 h2-1
    const result = calculateNumbering(headings, ['h1-2', 'h2-1']);
    // h1 有勾选后代，应该有序号
    expect(result.has('h1')).toBe(true);
    expect(result.get('h1')).toBe('第一章 ');
    // h1-2 是第一个被遍历到的 level 2 节点
    expect(result.get('h1-2')).toBe('1.1 ');
    expect(result.has('h1-1')).toBe(false);
    expect(result.get('h2')).toBe('第二章 ');
    expect(result.get('h2-1')).toBe('2.1 ');
  });

  it('中文章节序号使用中文数字', () => {
    const headings = [
      h('h1', '第一章 引言', 1),
      h('h2', '第二章 背景', 1),
      h('h3', '第三章 方法', 1),
    ];
    const result = calculateNumbering(headings, ['h1', 'h2', 'h3']);
    expect(result.get('h1')).toBe('第一章 ');
    expect(result.get('h2')).toBe('第二章 ');
    expect(result.get('h3')).toBe('第三章 ');
  });

  it('阿拉伯数字章节序号使用阿拉伯数字', () => {
    const headings = [
      h('h1', '第1章 引言', 1),
      h('h2', '第2章 背景', 1),
    ];
    const result = calculateNumbering(headings, ['h1', 'h2']);
    expect(result.get('h1')).toBe('第1章 ');
    expect(result.get('h2')).toBe('第2章 ');
  });

  it('标题为"目录"时不生成序号', () => {
    const headings = [h('toc', '目录', 1), h('h1', '第一章', 1)];
    const result = calculateNumbering(headings, ['toc', 'h1']);
    expect(result.has('toc')).toBe(false);
    expect(result.get('h1')).toBe('第一章 ');
  });

  it('level 超出 1-6 范围时不生成序号', () => {
    const headings = [h('h0', '标题', 0), h('h7', '标题', 7)];
    const result = calculateNumbering(headings, ['h0', 'h7']);
    expect(result.size).toBe(0);
  });

  it('混合勾选：部分子节点勾选时计数正确', () => {
    const headings = [
      h('h1', '第一章', 1, [
        h('h1-1', '第一节', 2),
        h('h1-2', '第二节', 2),
        h('h1-3', '第三节', 2),
      ]),
    ];
    // 只勾选 h1-1 和 h1-3，跳过 h1-2
    const result = calculateNumbering(headings, ['h1-1', 'h1-3']);
    expect(result.has('h1')).toBe(true);
    expect(result.get('h1-1')).toBe('1.1 ');
    expect(result.has('h1-2')).toBe(false);
    expect(result.get('h1-3')).toBe('1.2 ');
  });
});

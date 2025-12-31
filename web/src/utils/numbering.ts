import { HeadingNode } from './docParser';

// 辅助函数：数字转中文数字 (支持 1-99)
const toChineseNum = (num: number): string => {
  const chars = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (num <= 0) return '';
  if (num <= 10) return chars[num];
  if (num < 20) return '十' + (num % 10 === 0 ? '' : chars[num % 10]);
  if (num < 100) {
    const ten = Math.floor(num / 10);
    const unit = num % 10;
    return chars[ten] + '十' + (unit === 0 ? '' : chars[unit]);
  }
  return num.toString();
};

/**
 * 计算动态序号 Map
 * @param headings 目录树节点
 * @param checkedKeys 选中的 Key 列表
 * @returns Map<nodeKey, numberString> (e.g. "heading-1" -> "1.1 ")
 */
export const calculateNumbering = (headings: HeadingNode[], checkedKeys: string[]): Map<string, string> => {
  const map = new Map<string, string>();
  const counters = [0, 0, 0, 0, 0, 0, 0]; // Index 1-6 for H1-H6
  const checkedSet = new Set<string>(checkedKeys);

  // 父标题即使半选（自身未勾选但有勾选后代），也应保留显示序号
  const isEffectiveChecked = (node: HeadingNode): boolean => {
    if (checkedSet.has(node.key)) return true;
    return (node.children || []).some(isEffectiveChecked);
  };

  const traverse = (nodes: HeadingNode[]) => {
    nodes.forEach((node) => {
      const shouldShow = isEffectiveChecked(node);
      if (shouldShow) {
        const level = node.level;
        const title = node.title.trim();
        const isTOC = /^目\s*录$/.test(title);
        const chineseMatch = title.match(/^第\s*([0-9]+|[零一二三四五六七八九十百千]+)\s*章/);

        if (level >= 1 && level <= 6 && !isTOC) {
          counters[level]++;
          for (let i = level + 1; i <= 6; i++) counters[i] = 0;

          if (chineseMatch) {
            const originalNumStr = chineseMatch[1];
            const isArabic = /^[0-9]+$/.test(originalNumStr);
            const currentCount = counters[level];
            const newNumStr = isArabic ? currentCount.toString() : toChineseNum(currentCount);
            const prefixMatch = title.match(/^第(\s*)/);
            const suffixMatch = title.match(/([0-9]+|[零一二三四五六七八九十百千]+)(\s*)章/);
            const space1 = prefixMatch ? prefixMatch[1] : '';
            const space2 = suffixMatch ? suffixMatch[2] : '';
            map.set(node.key, `第${space1}${newNumStr}${space2}章 `);
          } else {
            map.set(node.key, counters.slice(1, level + 1).join('.') + ' ');
          }
        }

        if (node.children && node.children.length > 0) {
          traverse(node.children);
        }
      }
    });
  };

  traverse(headings);
  return map;
};

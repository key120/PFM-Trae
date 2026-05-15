import { beforeEach, describe, expect, it } from 'vitest';
import type { HeadingNode } from '../utils/docHeadingExtraction';
import { createDocumentLoadCache } from './documentLoadCache';

const createFile = (name: string) => new File(['test'], name, {
  type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

const createHeadings = (title: string): HeadingNode[] => [
  {
    id: `${title}-id`,
    title,
    level: 1,
    children: [],
    key: `${title}-key`,
  },
];

describe('documentLoadCache', () => {
  let cache: ReturnType<typeof createDocumentLoadCache>;

  beforeEach(() => {
    cache = createDocumentLoadCache({ maxEntries: 3 });
  });

  it('set/get 基本读写', () => {
    const file = createFile('文档1.docx');
    const headings = createHeadings('文档1');

    cache.set('doc-1', 'ver-1', { file, headings, title: '文档1' });

    const entry = cache.get('doc-1', 'ver-1');

    expect(entry).not.toBeNull();
    expect(entry).toEqual({
      file,
      headings,
      title: '文档1',
    });
  });

  it('版本不匹配时返回 null', () => {
    cache.set('doc-1', 'ver-1', {
      file: createFile('文档1.docx'),
      headings: createHeadings('文档1'),
      title: '文档1',
    });

    expect(cache.get('doc-1', 'ver-2')).toBeNull();
  });

  it('超过 maxEntries 时触发 LRU 淘汰', () => {
    cache.set('doc-1', 'v1', { file: createFile('d1.docx'), headings: [], title: 'd1' });
    cache.set('doc-2', 'v1', { file: createFile('d2.docx'), headings: [], title: 'd2' });
    cache.set('doc-3', 'v1', { file: createFile('d3.docx'), headings: [], title: 'd3' });

    cache.set('doc-4', 'v1', { file: createFile('d4.docx'), headings: [], title: 'd4' });

    expect(cache.get('doc-1', 'v1')).toBeNull();
    expect(cache.get('doc-2', 'v1')?.title).toBe('d2');
    expect(cache.get('doc-3', 'v1')?.title).toBe('d3');
    expect(cache.get('doc-4', 'v1')?.title).toBe('d4');
  });

  it('get 会刷新 LRU 顺序', () => {
    cache.set('doc-1', 'v1', { file: createFile('d1.docx'), headings: [], title: 'd1' });
    cache.set('doc-2', 'v1', { file: createFile('d2.docx'), headings: [], title: 'd2' });
    cache.set('doc-3', 'v1', { file: createFile('d3.docx'), headings: [], title: 'd3' });

    expect(cache.get('doc-1', 'v1')?.title).toBe('d1');

    cache.set('doc-4', 'v1', { file: createFile('d4.docx'), headings: [], title: 'd4' });

    expect(cache.get('doc-1', 'v1')?.title).toBe('d1');
    expect(cache.get('doc-2', 'v1')).toBeNull();
    expect(cache.get('doc-3', 'v1')?.title).toBe('d3');
    expect(cache.get('doc-4', 'v1')?.title).toBe('d4');
  });

  it('clear 清空缓存', () => {
    cache.set('doc-1', 'v1', { file: createFile('d1.docx'), headings: [], title: 'd1' });
    cache.set('doc-2', 'v1', { file: createFile('d2.docx'), headings: [], title: 'd2' });

    cache.clear();

    expect(cache.get('doc-1', 'v1')).toBeNull();
    expect(cache.get('doc-2', 'v1')).toBeNull();
  });
});

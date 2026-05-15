import {
  parseDocumentHeadingsResultOnMainThread,
  type HeadingNode,
} from './docHeadingExtraction';

export type { HeadingNode } from './docHeadingExtraction';
export { DOC_HEADING_MAMMOTH_OPTIONS, extractHeadingsFromHtml } from './docHeadingExtraction';

export const parseDocumentHeadingsOnMainThread = async (file: Blob): Promise<HeadingNode[]> => {
  const result = await parseDocumentHeadingsResultOnMainThread(file);
  return result.headings;
};

export const parseDocumentHeadings = async (file: File): Promise<HeadingNode[]> => {
  try {
    const { extractHeadingsViaWorker } = await import('../services/docHeadingExtractWorker');
    const result = await extractHeadingsViaWorker(file, {
      fallback: () => parseDocumentHeadingsResultOnMainThread(file),
    });
    return result.headings;
  } catch (error) {
    console.warn('[docParser] Worker adapter unavailable, falling back to main-thread parsing', error);
    return parseDocumentHeadingsOnMainThread(file);
  }
};

/**
 * 扁平化目录树，用于查找和遍历
 */
export const flattenHeadings = (nodes: HeadingNode[]): HeadingNode[] => {
  let result: HeadingNode[] = [];
  nodes.forEach(node => {
    result.push(node);
    if (node.children.length > 0) {
      result = result.concat(flattenHeadings(node.children));
    }
  });
  return result;
};

export const getAllKeys = (nodes: HeadingNode[]): string[] => {
  return flattenHeadings(nodes).map(node => node.key);
};

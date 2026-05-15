import mammoth from 'mammoth';

export interface HeadingNode {
  id: string;
  title: string;
  level: number;
  children: HeadingNode[];
  key: string;
}

export interface DocumentHeadingExtractionResult {
  headings: HeadingNode[];
  title: string;
}

export const DOC_HEADING_MAMMOTH_OPTIONS = {
  ignoreEmptyParagraphs: true,
  includeDefaultStyleMap: true,
  styleMap: [
    "p[style-name='TOC 1'] => p.toc-entry.toc-level-1",
    "p[style-name='TOC 2'] => p.toc-entry.toc-level-2",
    "p[style-name='TOC 3'] => p.toc-entry.toc-level-3",
    "p[style-name='toc 1'] => p.toc-entry.toc-level-1",
    "p[style-name='toc 2'] => p.toc-entry.toc-level-2",
    "p[style-name='toc 3'] => p.toc-entry.toc-level-3",
  ],
};

const decodeHtmlEntities = (text: string): string => {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code: string) => {
    const normalizedCode = code.toLowerCase();

    if (normalizedCode.startsWith('#x')) {
      const value = Number.parseInt(normalizedCode.slice(2), 16);
      return Number.isNaN(value) ? entity : String.fromCodePoint(value);
    }

    if (normalizedCode.startsWith('#')) {
      const value = Number.parseInt(normalizedCode.slice(1), 10);
      return Number.isNaN(value) ? entity : String.fromCodePoint(value);
    }

    return namedEntities[normalizedCode] ?? entity;
  });
};

const htmlToPlainText = (html: string, preserveTabs = false): string => {
  const withoutTags = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<\/div>/gi, ' ')
    .replace(/<[^>]+>/g, '');

  let normalized = decodeHtmlEntities(withoutTags)
    .replace(/ /g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[ \f\v]+/g, ' ');

  if (preserveTabs) {
    normalized = normalized.replace(/ *\t */g, '\t');
  } else {
    normalized = normalized.replace(/\t+/g, ' ');
  }

  return normalized.trim();
};

const createTitleMapFromHtml = (html: string): Map<string, string[]> => {
  const titleMap = new Map<string, string[]>();
  const tocEntryRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;

  const processPotentialTitle = (fullTitle: string) => {
    const normalizedTitle = fullTitle.trim();
    const match = normalizedTitle.match(
      /^((?:第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)|(?:[0-9]+\.[0-9\.]*\s+))(.+)$/,
    );

    if (!match) {
      return;
    }

    const titleBody = match[2].trim();
    if (!titleBody) {
      return;
    }

    if (!titleMap.has(titleBody)) {
      titleMap.set(titleBody, []);
    }

    titleMap.get(titleBody)?.push(normalizedTitle);
  };

  let match: RegExpExecArray | null;
  while ((match = tocEntryRegex.exec(html)) !== null) {
    const attributes = match[1] ?? '';
    const classMatch = attributes.match(/class\s*=\s*["']([^"']*)["']/i);
    const classNames = (classMatch?.[1] ?? '').split(/\s+/).filter(Boolean);

    if (!classNames.includes('toc-entry')) {
      continue;
    }

    const text = htmlToPlainText(match[2] ?? '', true);
    if (!text) {
      continue;
    }

    if (text.includes('\t')) {
      const parts = text.split('\t');
      processPotentialTitle(parts[0] ?? '');

      for (let index = 1; index < parts.length - 1; index += 1) {
        const part = (parts[index] ?? '').replace(/^\d+/, '').trim();
        processPotentialTitle(part);
      }
    } else {
      const cleanText = text.replace(/\s*\d+$/, '').trim();
      processPotentialTitle(cleanText);
    }
  }

  return titleMap;
};

const sanitizeHeadingTitle = (title: string): string => {
  if (!/^第\s*[0-9零一二三四五六七八九十百千]+\s*章/.test(title)) {
    return title.replace(/^(\d+([\.、]\d+)*[\.、\s]+)(?=[^\d])/, '').trim();
  }

  return title.trim();
};

export const extractHeadingsFromHtml = (html: string): HeadingNode[] => {
  const titleMap = createTitleMapFromHtml(html);
  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];
  const headingRegex = /<(h([1-6]))\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let match: RegExpExecArray | null;
  let headerIndex = 0;

  while ((match = headingRegex.exec(html)) !== null) {
    const level = Number.parseInt(match[2] ?? '', 10);
    let title = htmlToPlainText(match[3] ?? '');

    const mappedTitles = titleMap.get(title.trim());
    if (mappedTitles && mappedTitles.length > 0) {
      title = mappedTitles.shift() ?? title;
    }

    title = sanitizeHeadingTitle(title);
    const currentIndex = headerIndex;
    headerIndex += 1;

    if (!title.trim()) {
      continue;
    }

    const node: HeadingNode = {
      id: `heading-${currentIndex}`,
      key: `heading-${currentIndex}`,
      title,
      level,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return root;
};

export const extractDocumentTitleFromHtml = (html: string, headings: HeadingNode[]): string => {
  if (headings.length > 0) {
    return headings[0]?.title ?? '';
  }

  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? htmlToPlainText(titleMatch[1] ?? '') : '';
};

export const extractHeadingsAndTitleFromHtml = (html: string): DocumentHeadingExtractionResult => {
  const headings = extractHeadingsFromHtml(html);
  return {
    headings,
    title: extractDocumentTitleFromHtml(html, headings),
  };
};

const blobToArrayBuffer = async (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }

  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const { result } = reader;
      if (result instanceof ArrayBuffer) {
        resolve(result);
        return;
      }

      reject(new Error('Unexpected FileReader result type'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
};

export const parseDocumentHeadingsResultOnMainThread = async (
  file: Blob,
): Promise<DocumentHeadingExtractionResult> => {
  const arrayBuffer = await blobToArrayBuffer(file);

  try {
    const result = await mammoth.convertToHtml({ arrayBuffer }, DOC_HEADING_MAMMOTH_OPTIONS);
    return extractHeadingsAndTitleFromHtml(result.value);
  } catch (error: any) {
    console.error('Failed to parse document headings:', error);
    console.error('Error details:', error.message, error.stack);
    throw error;
  }
};

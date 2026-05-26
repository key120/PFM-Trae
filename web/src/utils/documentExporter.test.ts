import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { exportDocumentToBlob } from './documentExporter';
import type { HeadingNode } from './docParser';

async function createTestDocx(
  documentXml: string,
  stylesXml?: string
): Promise<File> {
  const zip = new JSZip();
  zip.file('word/document.xml', documentXml);
  zip.file(
    'word/styles.xml',
    stylesXml ||
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>'
  );
  const blob = await zip.generateAsync({ type: 'blob' });
  return new File([blob], 'test.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new Error('Unexpected FileReader result'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

async function parseExportedDocx(blob: Blob): Promise<Document> {
  const arrayBuffer = await blobToArrayBuffer(blob);
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  return new DOMParser().parseFromString(xml, 'application/xml');
}

async function parseExportedSettings(blob: Blob): Promise<Document | null> {
  const arrayBuffer = await blobToArrayBuffer(blob);
  const zip = await JSZip.loadAsync(arrayBuffer);
  const settingsFile = zip.file('word/settings.xml');
  if (!settingsFile) return null;
  const xml = await settingsFile.async('string');
  return new DOMParser().parseFromString(xml, 'application/xml');
}

const HEADING_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
</w:styles>`;

const TOC_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/></w:style>
</w:styles>`;

function makeHeading(id: string, title: string, level: number): HeadingNode {
  return { id, title, level, children: [], key: id };
}

function buildDocumentXml(
  paragraphs: Array<{ styleId?: string; text: string }>
): string {
  const pElements = paragraphs
    .map(({ styleId, text }) => {
      const pPr = styleId
        ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>`
        : '';
      return `<w:p>${pPr}<w:r><w:t>${text}</w:t></w:r></w:p>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${pElements}</w:body>
</w:document>`;
}

describe('exportDocumentToBlob - TOC rebuild', () => {
  it('无 TOC 的文档导出后不含 TOC 段落', async () => {
    const documentXml = buildDocumentXml([
      { styleId: 'Heading1', text: '第一章 引言' },
      { styleId: 'Heading2', text: '1.1 背景' },
      { styleId: 'Heading1', text: '第二章 方法' },
    ]);
    const file = await createTestDocx(documentXml, HEADING_STYLES_XML);
    const headings = [
      makeHeading('h1', '第一章 引言', 1),
      makeHeading('h2', '1.1 背景', 2),
      makeHeading('h3', '第二章 方法', 1),
    ];

    const blob = await exportDocumentToBlob(file, ['h1', 'h2', 'h3'], headings, headings);
    const doc = await parseExportedDocx(blob);

    // 没有 TOC 样式定义，不会检测到 TOC，也不会生成 TOC 段落
    const allParagraphs = doc.getElementsByTagName('w:p');
    for (let i = 0; i < allParagraphs.length; i++) {
      const pStyle = allParagraphs[i].getElementsByTagName('w:pStyle')[0];
      if (pStyle) {
        const val = pStyle.getAttribute('w:val') || '';
        expect(val.toLowerCase()).not.toMatch(/^toc\s*\d$/);
        expect(val).not.toMatch(/^TOC\d$/);
      }
    }
  });

  it('含 TOC 的文档导出后 TOC 条目数与选中章节数一致', async () => {
    const documentXml = buildDocumentXml([
      { styleId: 'TOC1', text: '旧目录条目1' },
      { styleId: 'TOC2', text: '旧目录条目2' },
      { styleId: 'Heading1', text: '第一章 引言' },
      { styleId: 'Heading2', text: '1.1 背景' },
      { styleId: 'Heading1', text: '第二章 方法' },
    ]);
    const file = await createTestDocx(documentXml, TOC_STYLES_XML);
    const headings = [
      makeHeading('h1', '第一章 引言', 1),
      makeHeading('h2', '1.1 背景', 2),
      makeHeading('h3', '第二章 方法', 1),
    ];

    // 只选中前两个章节
    const blob = await exportDocumentToBlob(file, ['h1', 'h2'], headings, headings);
    const doc = await parseExportedDocx(blob);

    // 统计 TOC 样式段落数量
    let tocCount = 0;
    const allParagraphs = doc.getElementsByTagName('w:p');
    for (let i = 0; i < allParagraphs.length; i++) {
      const pStyle = allParagraphs[i].getElementsByTagName('w:pStyle')[0];
      if (pStyle) {
        const val = pStyle.getAttribute('w:val') || '';
        if (/^TOC\d$/i.test(val)) {
          tocCount++;
        }
      }
    }

    expect(tocCount).toBe(2);
  });

  it('含 TOC 的文档导出后 TOC 段落包含域代码', async () => {
    const documentXml = buildDocumentXml([
      { styleId: 'TOC1', text: '旧目录条目' },
      { styleId: 'Heading1', text: '第一章 引言' },
      { styleId: 'Heading2', text: '1.1 背景' },
      { styleId: 'Heading1', text: '第二章 方法' },
    ]);
    const file = await createTestDocx(documentXml, TOC_STYLES_XML);
    const headings = [
      makeHeading('h1', '第一章 引言', 1),
      makeHeading('h2', '1.1 背景', 2),
      makeHeading('h3', '第二章 方法', 1),
    ];

    const blob = await exportDocumentToBlob(file, ['h1', 'h2', 'h3'], headings, headings);
    const doc = await parseExportedDocx(blob);

    // 检查第一个 TOC 段落包含 instrText
    const allParagraphs = doc.getElementsByTagName('w:p');
    let foundInstrText = false;
    for (let i = 0; i < allParagraphs.length; i++) {
      const pStyle = allParagraphs[i].getElementsByTagName('w:pStyle')[0];
      if (pStyle && /^TOC\d$/i.test(pStyle.getAttribute('w:val') || '')) {
        const instrTexts = allParagraphs[i].getElementsByTagName('w:instrText');
        if (instrTexts.length > 0) {
          const text = instrTexts[0].textContent || '';
          if (text.includes('TOC')) {
            foundInstrText = true;
            break;
          }
        }
      }
    }

    expect(foundInstrText).toBe(true);
  });

  it('中文 TOC 样式名（目录 1）能正确识别', async () => {
    const CN_TOC_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="MLTOC1"><w:name w:val="目录 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="MLTOC2"><w:name w:val="目录 2"/></w:style>
</w:styles>`;

    const documentXml = buildDocumentXml([
      { styleId: 'MLTOC1', text: '旧目录条目' },
      { styleId: 'Heading1', text: '第一章 引言' },
      { styleId: 'Heading2', text: '1.1 背景' },
      { styleId: 'Heading1', text: '第二章 方法' },
    ]);
    const file = await createTestDocx(documentXml, CN_TOC_STYLES_XML);
    const headings = [
      makeHeading('h1', '第一章 引言', 1),
      makeHeading('h2', '1.1 背景', 2),
      makeHeading('h3', '第二章 方法', 1),
    ];

    const blob = await exportDocumentToBlob(file, ['h1', 'h2', 'h3'], headings, headings);
    const doc = await parseExportedDocx(blob);

    // 统计中文 TOC 样式段落
    let tocCount = 0;
    const allParagraphs = doc.getElementsByTagName('w:p');
    for (let i = 0; i < allParagraphs.length; i++) {
      const pStyle = allParagraphs[i].getElementsByTagName('w:pStyle')[0];
      if (pStyle) {
        const val = pStyle.getAttribute('w:val') || '';
        if (val === 'MLTOC1' || val === 'MLTOC2') {
          tocCount++;
        }
      }
    }

    expect(tocCount).toBe(3);
  });

  it('全选时 TOC 条目数等于章节数', async () => {
    const documentXml = buildDocumentXml([
      { styleId: 'TOC1', text: '旧目录条目1' },
      { styleId: 'TOC2', text: '旧目录条目2' },
      { styleId: 'Heading1', text: '第一章 引言' },
      { styleId: 'Heading2', text: '1.1 背景' },
      { styleId: 'Heading1', text: '第二章 方法' },
    ]);
    const file = await createTestDocx(documentXml, TOC_STYLES_XML);
    const headings = [
      makeHeading('h1', '第一章 引言', 1),
      makeHeading('h2', '1.1 背景', 2),
      makeHeading('h3', '第二章 方法', 1),
    ];

    // 全选
    const blob = await exportDocumentToBlob(file, ['h1', 'h2', 'h3'], headings, headings);
    const doc = await parseExportedDocx(blob);

    let tocCount = 0;
    const allParagraphs = doc.getElementsByTagName('w:p');
    for (let i = 0; i < allParagraphs.length; i++) {
      const pStyle = allParagraphs[i].getElementsByTagName('w:pStyle')[0];
      if (pStyle) {
        const val = pStyle.getAttribute('w:val') || '';
        if (/^TOC\d$/i.test(val)) {
          tocCount++;
        }
      }
    }

    expect(tocCount).toBe(3);
  });

  it('含 TOC 的文档导出后 settings.xml 中 updateFields 为 true', async () => {
    const documentXml = buildDocumentXml([
      { styleId: 'TOC1', text: '旧目录条目' },
      { styleId: 'Heading1', text: '第一章 引言' },
      { styleId: 'Heading1', text: '第二章 方法' },
    ]);
    const file = await createTestDocx(documentXml, TOC_STYLES_XML);
    const headings = [
      makeHeading('h1', '第一章 引言', 1),
      makeHeading('h2', '第二章 方法', 1),
    ];

    const blob = await exportDocumentToBlob(file, ['h1', 'h2'], headings, headings);
    const settingsDoc = await parseExportedSettings(blob);

    expect(settingsDoc).not.toBeNull();
    const updateFields = settingsDoc!.getElementsByTagName('w:updateFields')[0];
    expect(updateFields).toBeDefined();
    expect(updateFields.getAttribute('w:val')).toBe('true');
  });
});

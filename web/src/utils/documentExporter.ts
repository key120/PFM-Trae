import JSZip from 'jszip';
import { HeadingNode } from './docParser';
import { saveAs } from 'file-saver';
import { calculateNumbering } from './numbering';

interface PreparedExport {
  zip: JSZip;
  fileName: string;
}

const OLD_NUMBER_REGEX = /^[\s﻿\xA0]*(\d+([\.\、]\d+)*[\.\、\s﻿\xA0]*|第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s﻿\xA0]*)/;

const stripBomAndOldNumber = (title: string): string => {
  let clean = title.trim();
  if (clean.charCodeAt(0) === 0xFEFF) {
    clean = clean.slice(1);
  }
  const match = clean.match(OLD_NUMBER_REGEX);
  if (match) {
    clean = clean.substring(match[0].length).trim();
  }
  return clean;
};

const prepareExport = async (
  file: File,
  selectedKeys: string[],
  flatHeadings: HeadingNode[],
  rootHeadings: HeadingNode[]
): Promise<PreparedExport> => {
  const zip = await JSZip.loadAsync(file);
  const documentXmlStr = await zip.file('word/document.xml')?.async('string');
  const stylesXmlStr = await zip.file('word/styles.xml')?.async('string');
  if (!documentXmlStr || !stylesXmlStr) {
    throw new Error('Invalid DOCX file: missing document.xml or styles.xml');
  }
  const parser = new DOMParser();
  const docDom = parser.parseFromString(documentXmlStr, 'application/xml');
  const stylesDom = parser.parseFromString(stylesXmlStr, 'application/xml');
  const styleMap = buildStyleMap(stylesDom);
  const tocStyleMap = buildTocStyleMap(stylesDom);
  const parentMap = new Map<string, string>();
  const stack: HeadingNode[] = [];
  for (const node of flatHeadings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      parentMap.set(node.key, stack[stack.length - 1].key);
    }
    stack.push(node);
  }
  const effectiveSelectedSet = new Set(selectedKeys);
  for (const key of selectedKeys) {
    let current = key;
    while (parentMap.has(current)) {
      const parent = parentMap.get(current)!;
      if (effectiveSelectedSet.has(parent)) break;
      effectiveSelectedSet.add(parent);
      current = parent;
    }
  }
  const numberingMap = calculateNumbering(rootHeadings, Array.from(effectiveSelectedSet));
  const body = docDom.getElementsByTagName('w:body')[0];
  if (!body) {
    throw new Error('Invalid DOCX: no body found');
  }

  const tocDetected = hasToc(body, tocStyleMap);

  const children = Array.from(body.childNodes);
  let currentHeadingIndex = 0;
  let shouldKeep = true;
  for (const child of children) {
    if (child.nodeName === 'w:p') {
      if (tocDetected && isTocParagraph(child as Element, tocStyleMap)) {
        body.removeChild(child);
        continue;
      }
      const level = getHeadingLevel(child as Element, styleMap);
      if (level !== null) {
        if (currentHeadingIndex < flatHeadings.length) {
          const headingNode = flatHeadings[currentHeadingIndex];
          const isSelected = effectiveSelectedSet.has(headingNode.key);
          shouldKeep = isSelected;
          if (isSelected) {
            const newNumber = numberingMap.get(headingNode.key);
            if (newNumber) {
              applyNewNumbering(child as Element, newNumber, headingNode.title);
            }
          }
          currentHeadingIndex++;
        }
      }
    }
    if (!shouldKeep) {
      body.removeChild(child);
    }
  }

  if (tocDetected) {
    const selectedHeadings = flatHeadings
      .filter(h => effectiveSelectedSet.has(h.key))
      .map(h => {
        const num = numberingMap.get(h.key) || '';
        const cleanTitle = stripBomAndOldNumber(h.title);
        return { level: h.level, title: `${num}${cleanTitle}` };
      });
    rebuildToc(body, selectedHeadings, tocStyleMap, docDom);
    await updateSettingsForToc(zip);
  }

  const serializer = new XMLSerializer();
  const newDocumentXml = serializer.serializeToString(docDom);
  zip.file('word/document.xml', newDocumentXml);
  const base = file.name.endsWith('.docx') ? file.name.slice(0, -5) : file.name;
  const fileName = `${base}_exported.docx`;
  return { zip, fileName };
};

export const exportDocument = async (
  file: File,
  selectedKeys: string[],
  flatHeadings: HeadingNode[],
  rootHeadings: HeadingNode[]
): Promise<void> => {
  const { zip, fileName } = await prepareExport(file, selectedKeys, flatHeadings, rootHeadings);
  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, fileName);
};

export const exportDocumentToBlob = async (
  file: File,
  selectedKeys: string[],
  flatHeadings: HeadingNode[],
  rootHeadings: HeadingNode[]
): Promise<Blob> => {
  const { zip } = await prepareExport(file, selectedKeys, flatHeadings, rootHeadings);
  const blob = await zip.generateAsync({ type: 'blob' });
  return blob;
};

/**
 * 应用新的序号到标题段落
 */
const applyNewNumbering = (pNode: Element, newNumber: string, originalTitle: string) => {
  let pPr = pNode.getElementsByTagName('w:pPr')[0];
  if (!pPr) {
    pPr = pNode.ownerDocument.createElement('w:pPr');
    pNode.insertBefore(pPr, pNode.firstChild);
  }

  let numPr = pPr.getElementsByTagName('w:numPr')[0];
  if (!numPr) {
    numPr = pNode.ownerDocument.createElement('w:numPr');
    pPr.appendChild(numPr);
  }

  while (numPr.firstChild) {
    numPr.removeChild(numPr.firstChild);
  }

  const numId = pNode.ownerDocument.createElement('w:numId');
  numId.setAttribute('w:val', '0');
  numPr.appendChild(numId);

  const runs = Array.from(pNode.getElementsByTagName('w:r'));
  if (runs.length === 0) return;

  let targetRun = runs[0];
  let tNode = targetRun.getElementsByTagName('w:t')[0];

  if (!tNode) {
      const textRun = runs.find(r => r.getElementsByTagName('w:t').length > 0);
      if (textRun) {
          targetRun = textRun;
          tNode = targetRun.getElementsByTagName('w:t')[0];
      } else {
          tNode = pNode.ownerDocument.createElement('w:t');
          targetRun.appendChild(tNode);
      }
  }

  const displayTitle = stripBomAndOldNumber(originalTitle);
  const fullNewText = `${newNumber}${displayTitle}`;

  tNode.setAttribute('xml:space', 'preserve');
  tNode.textContent = fullNewText;

  for (let i = 0; i < runs.length; i++) {
      if (runs[i] === targetRun) continue;
      const otherTs = Array.from(runs[i].getElementsByTagName('w:t'));
      otherTs.forEach(t => t.textContent = '');
  }
};

/**
 * 解析 styles.xml，找出所有标题样式的 ID
 */
const buildStyleMap = (stylesDom: Document): Map<string, number> => {
  const map = new Map<string, number>();
  const styles = stylesDom.getElementsByTagName('w:style');

  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const styleId = style.getAttribute('w:styleId');
    if (!styleId) continue;

    const nameNode = style.getElementsByTagName('w:name')[0];
    const nameVal = nameNode ? nameNode.getAttribute('w:val') : '';

    if (nameVal) {
      const match = nameVal.match(/^heading\s*(\d)$/i);
      if (match) {
        map.set(styleId, parseInt(match[1]));
        continue;
      }

      const matchCN = nameVal.match(/^标题\s*(\d)$/);
      if (matchCN) {
        map.set(styleId, parseInt(matchCN[1]));
      }
    }
  }

  return map;
};

/**
 * 解析 styles.xml，找出所有 TOC 样式的 ID
 */
const buildTocStyleMap = (stylesDom: Document): Map<string, number> => {
  const map = new Map<string, number>();
  const styles = stylesDom.getElementsByTagName('w:style');
  for (let i = 0; i < styles.length; i++) {
    const style = styles[i];
    const styleId = style.getAttribute('w:styleId');
    if (!styleId) continue;
    const nameNode = style.getElementsByTagName('w:name')[0];
    const nameVal = nameNode ? nameNode.getAttribute('w:val') : '';
    if (nameVal) {
      const match = nameVal.match(/^toc\s*(\d)$/i);
      if (match) { map.set(styleId, parseInt(match[1])); continue; }
      const matchCN = nameVal.match(/^目录\s*(\d)$/);
      if (matchCN) { map.set(styleId, parseInt(matchCN[1])); }
    }
  }
  return map;
};

/**
 * 检查文档 body 中是否存在 TOC 段落
 */
const hasToc = (body: Element, tocStyleMap: Map<string, number>): boolean => {
  if (tocStyleMap.size === 0) return false;
  const paragraphs = body.getElementsByTagName('w:p');
  for (let i = 0; i < paragraphs.length; i++) {
    const pStyle = paragraphs[i].getElementsByTagName('w:pStyle')[0];
    if (pStyle) {
      const styleId = pStyle.getAttribute('w:val');
      if (styleId && tocStyleMap.has(styleId)) return true;
    }
  }
  return false;
};

/**
 * 判断一个段落节点是否是 TOC 段落
 */
const isTocParagraph = (pNode: Element, tocStyleMap: Map<string, number>): boolean => {
  const pStyle = pNode.getElementsByTagName('w:pStyle')[0];
  if (!pStyle) return false;
  const styleId = pStyle.getAttribute('w:val');
  return !!(styleId && tocStyleMap.has(styleId));
};

/**
 * 根据 heading level 查找对应的 TOC 样式 ID
 */
const getTocStyleId = (level: number, tocStyleMap: Map<string, number>): string | null => {
  for (const [styleId, styleLevel] of tocStyleMap) {
    if (styleLevel === level) return styleId;
  }
  let bestId: string | null = null;
  let bestLevel = 0;
  for (const [styleId, styleLevel] of tocStyleMap) {
    if (styleLevel <= level && styleLevel > bestLevel) {
      bestId = styleId;
      bestLevel = styleLevel;
    }
  }
  if (!bestId) {
    let maxLevel = 0;
    for (const [styleId, styleLevel] of tocStyleMap) {
      if (styleLevel > maxLevel) { bestId = styleId; maxLevel = styleLevel; }
    }
  }
  return bestId;
};

/**
 * 重建 TOC：使用单个多段落域结构
 * 第一个段落包含 begin/instrText/separate，最后一个段落包含 end
 */
const rebuildToc = (
  body: Element,
  selectedHeadings: Array<{ level: number; title: string }>,
  tocStyleMap: Map<string, number>,
  doc: Document
): void => {
  if (selectedHeadings.length === 0) return;

  const maxLevel = selectedHeadings.reduce((max, h) => Math.max(max, h.level), 1);
  const firstElementChild = body.children[0] || null;

  for (let i = 0; i < selectedHeadings.length; i++) {
    const heading = selectedHeadings[i];
    const styleId = getTocStyleId(heading.level, tocStyleMap);
    if (!styleId) continue;

    const p = doc.createElement('w:p');

    // w:pPr > w:pStyle
    const pPr = doc.createElement('w:pPr');
    const pStyle = doc.createElement('w:pStyle');
    pStyle.setAttribute('w:val', styleId);
    pPr.appendChild(pStyle);
    p.appendChild(pPr);

    // 第一个段落：begin + instrText + separate
    if (i === 0) {
      const runBegin = doc.createElement('w:r');
      const fldCharBegin = doc.createElement('w:fldChar');
      fldCharBegin.setAttribute('w:fldCharType', 'begin');
      runBegin.appendChild(fldCharBegin);
      p.appendChild(runBegin);

      const runInstr = doc.createElement('w:r');
      const instrText = doc.createElement('w:instrText');
      instrText.setAttribute('xml:space', 'preserve');
      instrText.textContent = ` TOC \\o "1-${maxLevel}" \\h \\z \\u `;
      runInstr.appendChild(instrText);
      p.appendChild(runInstr);

      const runSep = doc.createElement('w:r');
      const fldCharSep = doc.createElement('w:fldChar');
      fldCharSep.setAttribute('w:fldCharType', 'separate');
      runSep.appendChild(fldCharSep);
      p.appendChild(runSep);
    }

    // 标题文字
    const runText = doc.createElement('w:r');
    const tNode = doc.createElement('w:t');
    tNode.setAttribute('xml:space', 'preserve');
    tNode.textContent = heading.title;
    runText.appendChild(tNode);
    p.appendChild(runText);

    // 最后一个段落：end
    if (i === selectedHeadings.length - 1) {
      const runEnd = doc.createElement('w:r');
      const fldCharEnd = doc.createElement('w:fldChar');
      fldCharEnd.setAttribute('w:fldCharType', 'end');
      runEnd.appendChild(fldCharEnd);
      p.appendChild(runEnd);
    }

    body.insertBefore(p, firstElementChild);
  }
};

/**
 * 检查段落是否是标题
 */
const getHeadingLevel = (pNode: Element, styleMap: Map<string, number>): number | null => {
  const pPr = pNode.getElementsByTagName('w:pPr')[0];
  if (!pPr) return null;

  const pStyle = pPr.getElementsByTagName('w:pStyle')[0];
  if (!pStyle) return null;

  const styleId = pStyle.getAttribute('w:val');
  if (!styleId) return null;

  if (styleMap.has(styleId)) {
    return styleMap.get(styleId)!;
  }

  const match = styleId.match(/^Heading(\d)$/i);
  if (match) {
    return parseInt(match[1]);
  }

  return null;
};

/**
 * 修改 settings.xml 以强制更新字段 (TOC)
 */
const updateSettingsForToc = async (zip: JSZip) => {
  const settingsXml = await zip.file('word/settings.xml')?.async('string');
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  let doc: Document;

  if (settingsXml) {
    doc = parser.parseFromString(settingsXml, 'application/xml');
  } else {
    doc = parser.parseFromString(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>',
      'application/xml'
    );
  }

  const settings = doc.getElementsByTagName('w:settings')[0];
  if (settings) {
    let updateFields = doc.getElementsByTagName('w:updateFields')[0];
    if (!updateFields) {
      updateFields = doc.createElement('w:updateFields');
      settings.appendChild(updateFields);
    }
    updateFields.setAttribute('w:val', 'true');
  }

  zip.file('word/settings.xml', serializer.serializeToString(doc));
};

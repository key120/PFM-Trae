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

  // 找到 TOC 区块之后的第一个非 TOC 元素，作为插入参考点
  let tocInsertBeforeRef: Element | null = null;
  if (tocDetected) {
    const children = Array.from(body.childNodes);
    let pastToc = false;
    for (const child of children) {
      if (child.nodeName === 'w:p' && isTocParagraph(child as Element, tocStyleMap)) {
        pastToc = true;
        continue;
      }
      if (pastToc && child.nodeType === 1) {
        tocInsertBeforeRef = child as Element;
        break;
      }
    }
  }

  const children = Array.from(body.childNodes);
  let currentHeadingIndex = 0;
  let shouldKeep = true;
  const headingParagraphs: Element[] = [];
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
            headingParagraphs.push(child as Element);
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
    // 为选中的标题段落添加书签（用于超链接跳转）
    const selectedKeysList = flatHeadings
      .filter(h => effectiveSelectedSet.has(h.key))
      .map(h => h.key);
    addHeadingBookmarks(headingParagraphs, selectedKeysList, docDom);

    const selectedHeadings = flatHeadings
      .filter(h => effectiveSelectedSet.has(h.key))
      .map((h) => {
        const num = numberingMap.get(h.key) || '';
        const cleanTitle = stripBomAndOldNumber(h.title);
        return {
          level: h.level,
          title: `${num}${cleanTitle}`,
          bookmarkName: h.key
        };
      });

    // 管理超链接关系
    const rels = await manageHyperlinkRelationships(zip, selectedHeadings);

    rebuildToc(body, tocInsertBeforeRef, selectedHeadings, rels, tocStyleMap, docDom);
    await updateSettingsForToc(zip);
  }

  // 确保 r 命名空间已声明（w:hyperlink 的 r:id 需要它）
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  docDom.documentElement.setAttributeNS(
    'http://www.w3.org/2000/xmlns/',
    'xmlns:r',
    R_NS
  );

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
 * 为标题段落添加书签，供 TOC 超链接跳转使用
 */
const addHeadingBookmarks = (
  headingParagraphs: Element[],
  selectedKeys: string[],
  doc: Document
): void => {
  let bookmarkIndex = 0;
  for (const p of headingParagraphs) {
    const bookmarkName = selectedKeys[bookmarkIndex] || String(bookmarkIndex);
    const bookmarkId = String(bookmarkIndex + 1);

    const bookmarkStart = doc.createElement('w:bookmarkStart');
    bookmarkStart.setAttribute('w:id', bookmarkId);
    bookmarkStart.setAttribute('w:name', bookmarkName);
    p.insertBefore(bookmarkStart, p.firstChild);

    const bookmarkEnd = doc.createElement('w:bookmarkEnd');
    bookmarkEnd.setAttribute('w:id', bookmarkId);
    p.appendChild(bookmarkEnd);

    bookmarkIndex++;
  }
};

/**
 * 管理 word/_rels/document.xml.rels 中的超链接关系
 * 返回 Map<bookmarkName, relationshipId>
 */
const manageHyperlinkRelationships = async (
  zip: JSZip,
  selectedHeadings: Array<{ bookmarkName: string }>
): Promise<Map<string, string>> => {
  const relsMap = new Map<string, string>();
  const relsPath = 'word/_rels/document.xml.rels';
  const relsXmlStr = await zip.file(relsPath)?.async('string');

  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  let relsDoc: Document;

  if (relsXmlStr) {
    relsDoc = parser.parseFromString(relsXmlStr, 'application/xml');
  } else {
    relsDoc = parser.parseFromString(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
      'application/xml'
    );
  }

  const relsRoot = relsDoc.getElementsByTagName('Relationships')[0];

  // 找到当前最大的 rId
  const existingRels = relsRoot.getElementsByTagName('Relationship');
  let maxRid = 0;
  for (let i = 0; i < existingRels.length; i++) {
    const id = existingRels[i].getAttribute('Id') || '';
    const match = id.match(/^rId(\d+)$/);
    if (match) {
      maxRid = Math.max(maxRid, parseInt(match[1]));
    }
  }

  for (const heading of selectedHeadings) {
    maxRid++;
    const rid = `rId${maxRid}`;
    relsMap.set(heading.bookmarkName, rid);

    const rel = relsDoc.createElement('Relationship');
    rel.setAttribute('Id', rid);
    rel.setAttribute('Type', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink');
    rel.setAttribute('Target', `#${heading.bookmarkName}`);
    rel.setAttribute('TargetMode', 'Internal');
    relsRoot.appendChild(rel);
  }

  zip.file(relsPath, serializer.serializeToString(relsDoc));
  return relsMap;
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
 * 重建 TOC：
 * - 保留原始位置（insertBeforeRef）
 * - TOC 域标记直接放在内容段落上（符合 Word 原生 TOC 结构）
 * - 使用 w:hyperlink 实现 Ctrl+Click 跳转
 * - 使用 PAGE 域显示页码
 * - 使用 TOC 域让 Word/WPS 在打开时自动更新
 */
const rebuildToc = (
  body: Element,
  insertBeforeRef: Element | null,
  selectedHeadings: Array<{ level: number; title: string; bookmarkName: string }>,
  relsMap: Map<string, string>,
  tocStyleMap: Map<string, number>,
  doc: Document
): void => {
  if (selectedHeadings.length === 0) return;

  const maxLevel = selectedHeadings.reduce((max, h) => Math.max(max, h.level), 1);

  // 第一步：构建所有 TOC 条目段落
  const entryParagraphs: Element[] = [];
  for (const heading of selectedHeadings) {
    const styleId = getTocStyleId(heading.level, tocStyleMap);
    if (!styleId) continue;

    const p = doc.createElement('w:p');

    // 段落样式
    const pPr = doc.createElement('w:pPr');
    const pStyle = doc.createElement('w:pStyle');
    pStyle.setAttribute('w:val', styleId);
    pPr.appendChild(pStyle);
    p.appendChild(pPr);

    // 超链接包裹标题文字
    const rid = relsMap.get(heading.bookmarkName);
    if (rid) {
      const hyperlink = doc.createElement('w:hyperlink');
      hyperlink.setAttribute('w:anchor', heading.bookmarkName);
      hyperlink.setAttribute('r:id', rid);

      const runText = doc.createElement('w:r');
      const rPr = doc.createElement('w:rPr');
      const rStyle = doc.createElement('w:rStyle');
      rStyle.setAttribute('w:val', 'Hyperlink');
      rPr.appendChild(rStyle);
      runText.appendChild(rPr);
      const tNode = doc.createElement('w:t');
      tNode.setAttribute('xml:space', 'preserve');
      tNode.textContent = heading.title;
      runText.appendChild(tNode);
      hyperlink.appendChild(runText);

      p.appendChild(hyperlink);
    } else {
      const runText = doc.createElement('w:r');
      const tNode = doc.createElement('w:t');
      tNode.setAttribute('xml:space', 'preserve');
      tNode.textContent = heading.title;
      runText.appendChild(tNode);
      p.appendChild(runText);
    }

    // Tab 分隔符 + PAGE 域（页码）
    const runTab = doc.createElement('w:r');
    const tab = doc.createElement('w:tab');
    runTab.appendChild(tab);
    p.appendChild(runTab);

    // PAGE 域 begin
    const runPageBegin = doc.createElement('w:r');
    const pageFldBegin = doc.createElement('w:fldChar');
    pageFldBegin.setAttribute('w:fldCharType', 'begin');
    runPageBegin.appendChild(pageFldBegin);
    p.appendChild(runPageBegin);

    // PAGE 域指令
    const runPageInstr = doc.createElement('w:r');
    const pageInstrText = doc.createElement('w:instrText');
    pageInstrText.setAttribute('xml:space', 'preserve');
    pageInstrText.textContent = ' PAGE ';
    runPageInstr.appendChild(pageInstrText);
    p.appendChild(runPageInstr);

    // PAGE 域 separate
    const runPageSep = doc.createElement('w:r');
    const pageFldSep = doc.createElement('w:fldChar');
    pageFldSep.setAttribute('w:fldCharType', 'separate');
    runPageSep.appendChild(pageFldSep);
    p.appendChild(runPageSep);

    // PAGE 域占位文本
    const runPageText = doc.createElement('w:r');
    const pageTNode = doc.createElement('w:t');
    pageTNode.textContent = '1';
    runPageText.appendChild(pageTNode);
    p.appendChild(runPageText);

    // PAGE 域 end
    const runPageEnd = doc.createElement('w:r');
    const pageFldEnd = doc.createElement('w:fldChar');
    pageFldEnd.setAttribute('w:fldCharType', 'end');
    runPageEnd.appendChild(pageFldEnd);
    p.appendChild(runPageEnd);

    entryParagraphs.push(p);
  }

  if (entryParagraphs.length === 0) return;

  // 第二步：按顺序插入到 body
  let insertRef: Element | null = insertBeforeRef;
  for (const p of entryParagraphs) {
    body.insertBefore(p, insertRef);
  }

  // 第三步：在第一个条目段落的 pPr 之前插入 TOC 域 begin + instrText + separate
  const firstP = entryParagraphs[0];
  const pPr = firstP.getElementsByTagName('w:pPr')[0];

  const runBegin = doc.createElement('w:r');
  const fldCharBegin = doc.createElement('w:fldChar');
  fldCharBegin.setAttribute('w:fldCharType', 'begin');
  runBegin.appendChild(fldCharBegin);

  const runInstr = doc.createElement('w:r');
  const instrText = doc.createElement('w:instrText');
  instrText.setAttribute('xml:space', 'preserve');
  instrText.textContent = ` TOC \\o "1-${maxLevel}" \\h \\z \\u `;
  runInstr.appendChild(instrText);

  const runSep = doc.createElement('w:r');
  const fldCharSep = doc.createElement('w:fldChar');
  fldCharSep.setAttribute('w:fldCharType', 'separate');
  runSep.appendChild(fldCharSep);

  // 逆序 insertBefore：每个新元素插在 pPr 之前，最终顺序为 begin → instr → sep → pPr
  firstP.insertBefore(runSep, pPr);
  firstP.insertBefore(runInstr, runSep);
  firstP.insertBefore(runBegin, runInstr);

  // 第四步：在最后一个条目段落末尾追加 TOC 域 end
  const lastP = entryParagraphs[entryParagraphs.length - 1];
  const runEnd = doc.createElement('w:r');
  const fldCharEnd = doc.createElement('w:fldChar');
  fldCharEnd.setAttribute('w:fldCharType', 'end');
  runEnd.appendChild(fldCharEnd);
  lastP.appendChild(runEnd);
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

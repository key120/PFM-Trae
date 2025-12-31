import JSZip from 'jszip';
import { HeadingNode } from './docParser';
import { saveAs } from 'file-saver';
import { calculateNumbering } from './numbering';

/**
 * 导出经过筛选的文档
 * @param file 原始 DOCX 文件
 * @param selectedKeys 选中的标题 Key 列表
 * @param flatHeadings 扁平化的标题节点列表（按文档顺序）
 * @param rootHeadings 原始树形结构（用于计算序号）
 */
export const exportDocument = async (
  file: File,
  selectedKeys: string[],
  flatHeadings: HeadingNode[],
  rootHeadings: HeadingNode[]
): Promise<void> => {
  // 1. 加载 ZIP
  const zip = await JSZip.loadAsync(file);
  
  // 2. 读取关键文件
  const documentXmlStr = await zip.file('word/document.xml')?.async('string');
  const stylesXmlStr = await zip.file('word/styles.xml')?.async('string');
  
  if (!documentXmlStr || !stylesXmlStr) {
    throw new Error('Invalid DOCX file: missing document.xml or styles.xml');
  }

  // 3. 解析 XML
  const parser = new DOMParser();
  const docDom = parser.parseFromString(documentXmlStr, 'application/xml');
  const stylesDom = parser.parseFromString(stylesXmlStr, 'application/xml');

  // 4. 构建样式映射表 (StyleId -> HeadingLevel)
  const styleMap = buildStyleMap(stylesDom);

  // 5. 预处理：构建父子关系并扩充选中集合
  // 如果子节点被选中，父节点也必须被保留
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
  // 遍历所有被显式选中的 key，将其所有祖先加入集合
  for (const key of selectedKeys) {
    let current = key;
    while (parentMap.has(current)) {
      const parent = parentMap.get(current)!;
      if (effectiveSelectedSet.has(parent)) break;
      effectiveSelectedSet.add(parent);
      current = parent;
    }
  }

  // 计算新序号 Map
  // 注意：这里我们传入 effectiveSelectedSet，确保半选状态的父节点也能获得序号
  const numberingMap = calculateNumbering(rootHeadings, Array.from(effectiveSelectedSet));

  // 6. 遍历并过滤节点
  const body = docDom.getElementsByTagName('w:body')[0];
  if (!body) {
    throw new Error('Invalid DOCX: no body found');
  }

  // 子节点列表转换为数组
  const children = Array.from(body.childNodes);
  
  let currentHeadingIndex = 0;
  let shouldKeep = true; 

  for (const child of children) {
    if (child.nodeName === 'w:p') {
      const level = getHeadingLevel(child as Element, styleMap);
      
      if (level !== null) {
        // 这是一个标题段落
        if (currentHeadingIndex < flatHeadings.length) {
          const headingNode = flatHeadings[currentHeadingIndex];
          
          // 检查是否匹配 (使用扩充后的集合)
          const isSelected = effectiveSelectedSet.has(headingNode.key);
          shouldKeep = isSelected;
          
          if (isSelected) {
            // 如果保留，应用新的序号
            const newNumber = numberingMap.get(headingNode.key);
            if (newNumber) {
               applyNewNumbering(child as Element, newNumber, headingNode.title);
            }
          }

          currentHeadingIndex++;
        } else {
          // 超出了范围
        }
      }
    }
    
    // 如果决定不保留，则移除节点
    if (!shouldKeep) {
      body.removeChild(child);
    }
  }

  // 7. 更新 TOC 设置
  await updateSettingsForToc(zip);

  // 8. 序列化并打包
  const serializer = new XMLSerializer();
  const newDocumentXml = serializer.serializeToString(docDom);
  zip.file('word/document.xml', newDocumentXml);

  // 9. 生成并下载
  const blob = await zip.generateAsync({ type: 'blob' });
  const newFileName = file.name.replace('.docx', '_exported.docx');
  saveAs(blob, newFileName);
};

/**
 * 应用新的序号到标题段落
 * 1. 显式禁用自动编号 (w:numPr -> w:numId w:val="0")
 * 2. 更新 w:t 文本，添加新序号前缀
 */
const applyNewNumbering = (pNode: Element, newNumber: string, originalTitle: string) => {
  // 1. 处理自动编号属性 (w:numPr)
  // 为了彻底禁用来自样式的自动编号，我们需要显式设置 numId 为 0
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
  
  // 清除 numPr 下的所有子节点
  while (numPr.firstChild) {
    numPr.removeChild(numPr.firstChild);
  }
  
  // 添加 <w:numId w:val="0"/>
  const numId = pNode.ownerDocument.createElement('w:numId');
  numId.setAttribute('w:val', '0');
  numPr.appendChild(numId);

  // 2. 更新文本内容
  const runs = Array.from(pNode.getElementsByTagName('w:r'));
  if (runs.length === 0) return; 

  // 找到第一个包含文本的 run
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
  
  // 清洗 originalTitle (移除旧序号)
  // 增强正则：支持 BOM、NBSP 等
  // 匹配：数字序号 (1.1) 或 中文序号 (第X章)
  let displayTitle = originalTitle.trim();
  // 移除可能存在的 BOM
  if (displayTitle.charCodeAt(0) === 0xFEFF) {
      displayTitle = displayTitle.slice(1);
  }
  
  const oldNumberRegex = /^[\s\uFEFF\xA0]*(\d+([\.\、]\d+)*[\.\、\s\uFEFF\xA0]*|第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s\uFEFF\xA0]*)/;
  const match = displayTitle.match(oldNumberRegex);
  if (match) {
      displayTitle = displayTitle.substring(match[0].length).trim();
  }
  
  const fullNewText = `${newNumber}${displayTitle}`;
  
  // 设置新文本
  tNode.setAttribute('xml:space', 'preserve');
  tNode.textContent = fullNewText;
  
  // 移除其他 run 中的文本
  for (let i = 0; i < runs.length; i++) {
      if (runs[i] === targetRun) continue;
      const otherTs = Array.from(runs[i].getElementsByTagName('w:t'));
      otherTs.forEach(t => t.textContent = ''); 
  }
};

/**
 * 解析 styles.xml，找出所有标题样式的 ID
 * 返回 Map<styleId, level>
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
    
    // 检查是否是 heading 1-9
    // Word 的标准样式名通常是 "heading 1", "heading 2" 等 (大小写可能不同)
    if (nameVal) {
      const match = nameVal.match(/^heading\s*(\d)$/i);
      if (match) {
        map.set(styleId, parseInt(match[1]));
        continue;
      }
      
      // 中文 Word 可能是 "标题 1"
      const matchCN = nameVal.match(/^标题\s*(\d)$/);
      if (matchCN) {
        map.set(styleId, parseInt(matchCN[1]));
      }
    }
  }
  
  return map;
};

/**
 * 检查段落是否是标题，如果是返回层级(1-9)，否则返回 null
 */
const getHeadingLevel = (pNode: Element, styleMap: Map<string, number>): number | null => {
  const pPr = pNode.getElementsByTagName('w:pPr')[0];
  if (!pPr) return null;
  
  const pStyle = pPr.getElementsByTagName('w:pStyle')[0];
  if (!pStyle) return null;
  
  const styleId = pStyle.getAttribute('w:val');
  if (!styleId) return null;
  
  // 1. 查表
  if (styleMap.has(styleId)) {
    return styleMap.get(styleId)!;
  }
  
  // 2. 备用逻辑：直接看 styleId 字符串 (mammoth 也能识别 Heading1)
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
  let settingsXml = await zip.file('word/settings.xml')?.async('string');
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  let doc: Document;

  if (settingsXml) {
    doc = parser.parseFromString(settingsXml, 'application/xml');
  } else {
    // 如果没有 settings.xml，创建一个最基本的
    doc = parser.parseFromString(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:settings>',
      'application/xml'
    );
  }

  const settings = doc.getElementsByTagName('w:settings')[0];
  if (settings) {
    // 检查是否已有 updateFields
    let updateFields = doc.getElementsByTagName('w:updateFields')[0];
    if (!updateFields) {
      updateFields = doc.createElement('w:updateFields');
      settings.appendChild(updateFields);
    }
    updateFields.setAttribute('w:val', 'true');
  }

  zip.file('word/settings.xml', serializer.serializeToString(doc));
};

import mammoth from 'mammoth';

export interface HeadingNode {
  id: string;
  title: string;
  level: number;
  children: HeadingNode[];
  key: string; // For Ant Design Tree
}

export const parseDocumentHeadings = async (file: File): Promise<HeadingNode[]> => {
  const arrayBuffer = await file.arrayBuffer();
  
  // 使用 mammoth 提取原始文本和样式映射
  // 这里我们主要利用 mammoth 将文档转换为 HTML，然后通过正则提取 h1-h6
  // 注意：这是一个简化方案，mammoth 的默认转换规则会将 Word 标题转换为 h1-h6
  
  try {
    const result = await mammoth.convertToHtml({ arrayBuffer }, {
      ignoreEmptyParagraphs: true,
      includeDefaultStyleMap: true,
      styleMap: [
        "p[style-name='TOC 1'] => p.toc-entry.toc-level-1",
        "p[style-name='TOC 2'] => p.toc-entry.toc-level-2",
        "p[style-name='TOC 3'] => p.toc-entry.toc-level-3",
        "p[style-name='toc 1'] => p.toc-entry.toc-level-1",
        "p[style-name='toc 2'] => p.toc-entry.toc-level-2",
        "p[style-name='toc 3'] => p.toc-entry.toc-level-3"
      ]
    });
    
    const html = result.value;
    
    // 解析 HTML 提取标题
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // 尝试从目录中提取包含章节号的标题映射
    const tocEntries = doc.querySelectorAll('p.toc-entry');
    // 使用 Map<string, string[]> 处理相同标题出现多次的情况
    const titleMap = new Map<string, string[]>();
    
    const processPotentialTitle = (fullTitle: string) => {
        fullTitle = fullTitle.trim();
        // 匹配中文 "第X章" 或 数字序号 "1.1"
        const match = fullTitle.match(/^((?:第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)|(?:[0-9]+\.[0-9\.]*\s+))(.+)$/);
        
        if (match) {
            const titleBody = match[2].trim();
            
            if (titleBody) {
                if (!titleMap.has(titleBody)) {
                    titleMap.set(titleBody, []);
                }
                titleMap.get(titleBody)?.push(fullTitle);
            }
        }
    };

    tocEntries.forEach(entry => {
        const text = entry.textContent || '';
        // Check if the line contains tabs (indicating multiple entries or Title+Page structure)
        if (text.includes('\t')) {
            const parts = text.split('\t');
            // Process the first part (Title 1)
            processPotentialTitle(parts[0]);
            
            // Process middle parts (Page N + Title N+1)
            // The last part is just the Page number of the last entry, so we skip it.
            for (let i = 1; i < parts.length - 1; i++) {
                // Remove leading digits (page number of previous entry)
                // Since we are targeting Chinese titles (starting with "第"), removing digits is safe.
                let part = parts[i].replace(/^\d+/, '').trim();
                processPotentialTitle(part);
            }
        } else {
            // No tabs, treat as single entry (Title + Space + Page)
            // Handle case where page number is tightly coupled e.g. "Title4"
            let cleanText = text.replace(/\s*\d+$/, '').trim();
            processPotentialTitle(cleanText);
        }
    });
    
    // 补充：手动处理一些常见的 TOC 格式问题，比如多个 TOC 项连在了一起
    // (在 test_docParser_logic.js 中发现 "2.1.1 文件管理 62.1.2 Preferences")
    // 这通常是因为 mammoth 解析时将它们合并到了一个 p 标签中，或者样式映射问题。
    // 但由于我们无法轻易拆分，这里暂且只处理标准情况。

    const headers = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    
    const root: HeadingNode[] = [];
    const stack: HeadingNode[] = []; // 用于维护层级关系
    
    headers.forEach((header, index) => {
      const level = parseInt(header.tagName.substring(1));
      let title = header.textContent || '';
      
      // 尝试使用 TOC 映射来恢复完整的标题（包含章节号）
      // 优先精确匹配
      const mappedTitles = titleMap.get(title.trim());
      if (mappedTitles && mappedTitles.length > 0) {
          // 取出并移除第一个匹配项，以保持顺序（简单处理）
          title = mappedTitles.shift() || title;
      }
      
      // 特殊处理：如果标题本身不包含章节号，但我们知道它应该有（比如 "功能介绍" -> "第2章. 功能介绍"）
      // 上面的映射已经处理了这种情况。
      
      const originalTitle = title;
      
      // 去除标题开头可能存在的自动序号（如 "1. ", "1.1 ", "1、" 等）
      // 匹配模式：数字开头，可能包含点或顿号，最后以空白字符结束
      // 注意：不要误删 "第1章" 这种格式，所以我们要小心正则
      // 原正则: title = title.replace(/^(\d+([\.\、]\d+)*[\.\、\s]*)\s+/, '').trim();
      // 修改为：只去除纯数字类型的序号 (e.g. "1.", "1.1", "1、")
      // 不去除 "第一章", "第1章"
      // 只有当标题以纯数字编号开头时才去除，且必须小心不要误伤已经通过 TOC 映射恢复的标题
      // 如果标题包含中文 "第" 开头，则绝对不处理
      if (!/^第\s*[0-9零一二三四五六七八九十百千]+\s*章/.test(title)) {
        title = title.replace(/^(\d+([\.\、]\d+)*[\.\、\s]+)(?=[^\d])/, '').trim();
      }

      const id = `heading-${index}`;
      const key = id;
      
      if (!title.trim()) return; // 跳过空标题
      
      const node: HeadingNode = {
        id,
        title,
        level,
        children: [],
        key
      };
      
      // 寻找父节点
      // 栈顶元素如果层级 >= 当前节点，说明栈顶元素不是父节点（是兄弟或侄子），出栈
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      
      if (stack.length === 0) {
        // 栈为空，说明是顶层节点
        root.push(node);
      } else {
        // 栈顶元素是父节点
        stack[stack.length - 1].children.push(node);
      }
      
      // 当前节点入栈，可能成为后续节点的父节点
      stack.push(node);
    });
    
    return root;
  } catch (error: any) {
    console.error('Failed to parse document headings:', error);
    console.error('Error details:', error.message, error.stack);
    throw error;
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

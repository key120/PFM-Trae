import React, { useEffect, useRef, useState } from 'react';
import { renderAsync } from 'docx-preview';
import { Spin, Empty, Typography } from 'antd';
import { useDocStore } from '../store/useDocStore';
import { flattenHeadings, HeadingNode } from '../utils/docParser';
import { StyleMapper } from '../utils/styleMapper';

const { Title, Text } = Typography;

// 辅助函数：移除文章开头的空段落
// const removeEmptyParagraphs = (container: HTMLElement) => {
//   const articles = container.querySelectorAll('article, section');
//   articles.forEach(article => {
//     let child = article.firstElementChild;
//     while (child && child.tagName === 'P' && (child.textContent || '').trim() === '') {
//       // 检查是否包含重要内容（如图片）
//       if (child.querySelector('img, svg, table, iframe')) break;
//       
//       const next = child.nextElementSibling;
//       child.remove();
//       child = next;
//     }
//   });
// };

// 辅助函数：尝试拆分元素内部
// 返回值：如果拆分成功，返回包含后半部分内容的新元素；如果无法拆分或是整体移动，返回 null 或原元素
const splitInside = (element: HTMLElement, remainingHeight: number): HTMLElement | null => {
  const children = Array.from(element.children) as HTMLElement[];
  if (children.length === 0) return element; // 无法拆分无子元素的节点（视为整体）

  const style = window.getComputedStyle(element);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  const contentLimit = remainingHeight - paddingTop - paddingBottom;

  if (contentLimit < 20) return element; // 空间太小，整体移动

  let currentHeight = 0;
  
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childStyle = window.getComputedStyle(child);
    const childMarginTop = parseFloat(childStyle.marginTop) || 0;
    const childMarginBottom = parseFloat(childStyle.marginBottom) || 0;
    const childTotalHeight = child.offsetHeight + childMarginTop + childMarginBottom;

    if (currentHeight + childTotalHeight > contentLimit) {
      // Overflow at child i
      const spaceForChild = contentLimit - currentHeight - childMarginTop;
      
      let remainingPart: HTMLElement | null = null;
      let moveWholeChild = true;

      if (spaceForChild > 20) { 
          const result = splitInside(child, spaceForChild);
          if (result && result !== child) {
             moveWholeChild = false;
             remainingPart = result;
          }
      }

      const newContainer = element.cloneNode(false) as HTMLElement;
      newContainer.removeAttribute('id');

      if (moveWholeChild) {
         // 如果第一个子元素就放不下，说明整个 element 都放不下
         if (i === 0) return element;
         
         // 移动 child 及后续兄弟
         for (let j = i; j < children.length; j++) {
             newContainer.appendChild(children[j]);
         }
      } else {
         // child 被拆分了
         if (remainingPart) newContainer.appendChild(remainingPart);
         for (let j = i + 1; j < children.length; j++) {
             newContainer.appendChild(children[j]);
         }
      }
      
      return newContainer;
    }
    currentHeight += childTotalHeight;
  }
  
  return null;
};

// 辅助函数：处理单个页面的分页
const processPage = (page: HTMLElement, maxHeight: number) => {
  // 1. 识别并获取页眉和页脚
  const header = Array.from(page.children).find(c => c.tagName === 'HEADER') as HTMLElement;
  const footer = Array.from(page.children).find(c => c.tagName === 'FOOTER') as HTMLElement;

  // 2. 计算有效内容高度
  const headerHeight = header ? header.offsetHeight : 0;
  const footerHeight = footer ? footer.offsetHeight : 0;

  // 给一点容差
  if (page.scrollHeight <= maxHeight + 10) return;

  const style = window.getComputedStyle(page);
  let paddingTop = parseFloat(style.paddingTop) || 0;
  const paddingBottom = parseFloat(style.paddingBottom) || 0;
  
  // 预判 updatePageNumbers 中的样式调整：
  // 如果有页眉，确保 paddingTop 至少为 40(top) + headerHeight + 10(gap)
  if (header) {
    const requiredPadding = 40 + headerHeight + 10;
    if (paddingTop < requiredPadding) {
      paddingTop = requiredPadding;
    }
  }

  // 内容区域限制 = 总高度 - 上下内边距 - 页脚高度 (页眉通过 padding 占位)
  const contentLimit = maxHeight - paddingTop - paddingBottom - footerHeight;

  // 3. 筛选出内容子元素 (排除 Header 和 Footer)
  const allChildren = Array.from(page.children) as HTMLElement[];
  const contentChildren = allChildren.filter(c => c !== header && c !== footer);
  
  const isTocTitle = (text: string) => {
    const t = text.trim();
    if (!t) return false;
    return /^目\s*录$/.test(t) || /^Table of Contents$/i.test(t) || /^Contents$/i.test(t) || /^目錄$/.test(t);
  };

  let currentHeight = 0;
  
  for (let i = 0; i < contentChildren.length; i++) {
    const child = contentChildren[i];
    const childStyle = window.getComputedStyle(child);
    const childHeight = child.offsetHeight + parseFloat(childStyle.marginTop) + parseFloat(childStyle.marginBottom);

    // 新增：TOC 强制分页检测
    // 如果当前页面已经有内容 (currentHeight > 0 或 i > 0)，且遇到了 TOC 的开始，则强制分页
    // 这样可以确保 TOC 从新的一页开始
    if (i > 0) {
      const txt = (child.textContent || '').trim();
      const isTocStart = isTocTitle(txt) || !!child.querySelector('.docx-tab-stop') || !!child.querySelector('a[href^=\"#_Toc\"]') || !!child.querySelector('[id^=\"_Toc\"],[name^=\"_Toc\"]');
      
      if (isTocStart) {
         // 强制分页：将当前 child 及其后续移到新页面
         const newPage = page.cloneNode(false) as HTMLElement;
         newPage.removeAttribute('id');
         page.parentElement?.insertBefore(newPage, page.nextSibling);
         
         if (header) newPage.appendChild(header.cloneNode(true));
         
         // 移动当前节点及后续节点
         const nodesToMove = contentChildren.slice(i);
         nodesToMove.forEach(node => newPage.appendChild(node));
         
         if (footer) newPage.appendChild(footer.cloneNode(true));
         
         const firstContent = Array.from(newPage.children).find(c => c.tagName !== 'HEADER' && c.tagName !== 'FOOTER') as HTMLElement | undefined;
         if (firstContent) firstContent.style.marginTop = '0px';
         
         processPage(newPage, maxHeight);
         return;
      }
    }

    if (currentHeight + childHeight > contentLimit) {
      // 需要分页
      
      const newPage = page.cloneNode(false) as HTMLElement;
      newPage.removeAttribute('id');
      page.parentElement?.insertBefore(newPage, page.nextSibling);
      
      // A. 复制页眉到新页面
      if (header) {
          newPage.appendChild(header.cloneNode(true));
      }

      // B. 处理溢出的子元素
      const remainingPart = splitInside(child, contentLimit - currentHeight);
      
      if (remainingPart && remainingPart !== child) {
          // 拆分成功：将剩余部分添加到新页面
          newPage.appendChild(remainingPart);
          // 将后续的所有内容节点移动到新页面
          const nodesToMove = contentChildren.slice(i + 1);
          nodesToMove.forEach(node => newPage.appendChild(node));
      } else {
          // 无法拆分，整体移动
          if (i > 0) {
              // 将当前节点及后续节点都移到新页面
              const nodesToMove = contentChildren.slice(i);
              nodesToMove.forEach(node => newPage.appendChild(node));
          } else {
              // 第一个元素就放不下，且无法拆分 -> 只能任其溢出，避免死循环
              // 但为了新页面的完整性，我们还是要把 footer 加上（如果这时候 return，新页面可能就废弃了）
              // 这种情况下通常不创建新页面，直接 return
              newPage.remove();
              return;
          }
      }
      
      // C. 复制页脚到新页面
      // 注意：原页面的页脚保持不变 (它不在 contentChildren 中，所以不会被移动)
      if (footer) {
          newPage.appendChild(footer.cloneNode(true));
      }
      
      processPage(newPage, maxHeight);
      return;
    }
    currentHeight += childHeight;
  }
};

// 辅助函数：更新页码
const updatePageNumbers = (container: HTMLElement) => {
    const pages = Array.from(container.querySelectorAll('.docx')).filter(p => (p as HTMLElement).style.display !== 'none');
    const total = pages.length;
    
    pages.forEach((page, index) => {
        const pageEl = page as HTMLElement;
        // 确保页面容器相对定位，以便页脚绝对定位
        pageEl.style.position = 'relative';

        const header = page.querySelector('header') as HTMLElement | null;
        let headerHeight = 0;
        if (header) {
            header.style.position = 'absolute';
            header.style.top = '40px';
            header.style.left = '0';
            header.style.width = '100%';
            header.style.margin = '0';
            header.style.display = '';
            headerHeight = header.offsetHeight;
        }

        // 1. 处理首页 (index === 0)：隐藏页眉和页脚
        if (index === 0) {
            if (header) header.style.display = 'none';
            const footer = page.querySelector('footer');
            if (footer) footer.style.display = 'none';
            const blocks = Array.from(page.querySelectorAll('p, div')) as HTMLElement[];
            blocks.forEach((el) => {
              const hasTocMarker = !!el.querySelector('.docx-tab-stop') || !!el.querySelector('a[href^=\"#_Toc\"]') || !!el.querySelector('[id^=\"_Toc\"],[name^=\"_Toc\"]');
              if (hasTocMarker) {
                el.style.display = 'none';
              }
            });
            const firstVisible = Array.from(page.children).find((c) => getComputedStyle(c as HTMLElement).display !== 'none' && c.tagName !== 'HEADER' && c.tagName !== 'FOOTER') as HTMLElement | undefined;
            // 首页内容保持原有布局，不强制清除 marginTop
            // if (firstVisible) firstVisible.style.marginTop = '0px';
            return;
        }

        if (header) {
             const style = window.getComputedStyle(pageEl);
             const currentPaddingTop = parseFloat(style.paddingTop) || 0;
             const requiredPadding = 40 + headerHeight + 10;
             if (currentPaddingTop < requiredPadding) {
                 pageEl.style.paddingTop = `${requiredPadding}px`;
             }
        }

        const footer = page.querySelector('footer');
        if (footer) {
            // 2. 固定页脚位置到页面底部，并确保内容居中
            footer.style.position = 'absolute';
            footer.style.bottom = '0';
            footer.style.left = '0';
            footer.style.width = '100%';
            footer.style.margin = '0'; // 重置可能存在的负边距
            
            // 使用 Flexbox 实现水平居中
            footer.style.display = 'flex';
            footer.style.justifyContent = 'center'; // 水平居中
            footer.style.alignItems = 'center';     // 垂直居中（如果 footer 高度有富余）
            
            // 3. 更新页码逻辑
            const table = footer.querySelector('table');
            if (table) {
                // 确保表格本身也是居中的（如果它没有占满宽度）
                table.style.margin = '0 auto';

                const rows = table.querySelectorAll('tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    // 假设三栏布局：左侧可能包含旧页码，右侧是目标页码位置
                    if (cells.length >= 2) {
                        const firstCell = cells[0];
                        const lastCell = cells[cells.length - 1];

                        // 清除左侧单元格中的页码信息 (包含 "Page" 的文本)
                        if (firstCell && (firstCell.textContent || '').includes('Page')) {
                            firstCell.textContent = '';
                        }

                        // 更新右侧单元格为新页码，并右对齐
                        if (lastCell) {
                            // 尝试保留内部 p 标签以维持字体样式
                            const p = lastCell.querySelector('p');
                            const pageText = `Page ${index + 1} of ${total}`;
                            
                            if (p) {
                                p.textContent = pageText;
                                p.style.textAlign = 'right';
                            } else {
                                lastCell.textContent = pageText;
                                lastCell.style.textAlign = 'right';
                            }
                        }
                    } else if (cells.length === 1) {
                         // 单栏布局直接更新
                         const cell = cells[0];
                         const p = cell.querySelector('p');
                         const pageText = `Page ${index + 1} of ${total}`;
                         if (p) {
                             p.textContent = pageText;
                             p.style.textAlign = 'right';
                         } else {
                             cell.textContent = pageText;
                             cell.style.textAlign = 'right';
                         }
                    }
                });
            } else {
                // 非表格布局的回退处理
                const p = footer.querySelector('p');
                if (p) {
                    p.textContent = `Page ${index + 1} of ${total}`;
                    p.style.textAlign = 'center'; // 默认居中
                }
            }
        }
    });
};

// 辅助函数：对文档进行手动分页
const paginateDocument = (container: HTMLElement) => {
  // removeEmptyParagraphs(container);

  const pages = Array.from(container.querySelectorAll('.docx'));
  // A4 纸标准高度 (96DPI) 约为 1123px。
  // 调整高度以匹配 Word 的分页效果 (65页)
  const MAX_HEIGHT = 1165; 
  const forceBreakBeforeToc = (page: HTMLElement) => {
    const header = Array.from(page.children).find(c => c.tagName === 'HEADER') as HTMLElement | undefined;
    const footer = Array.from(page.children).find(c => c.tagName === 'FOOTER') as HTMLElement | undefined;
    const isHeaderOrFooter = (el: Element) => el === header || el === footer;
    const isTocTitle = (text: string) => {
      const t = text.trim();
      if (!t) return false;
      return /^目\s*录$/.test(t) || /^Table of Contents$/i.test(t) || /^Contents$/i.test(t) || /^目錄$/.test(t);
    };
    const isTocContainer = (el: HTMLElement) => {
      return !!el.querySelector('.docx-tab-stop') || !!el.querySelector('a[href^=\"#_Toc\"]') || !!el.querySelector('[id^=\"_Toc\"],[name^=\"_Toc\"]');
    };
    const walker = document.createTreeWalker(page, NodeFilter.SHOW_ELEMENT, null);
    let tocEl: HTMLElement | null = null;
    {
      let node: Node | null;
      while (node = walker.nextNode()) {
        const el = node as HTMLElement;
        if (isHeaderOrFooter(el)) continue;
        const txt = (el.textContent || '').trim();
        if (isTocTitle(txt) || !!el.querySelector('.docx-tab-stop') || !!el.querySelector('a[href^=\"#_Toc\"]') || !!el.querySelector('[id^=\"_Toc\"],[name^=\"_Toc\"]')) {
          tocEl = el;
          break;
        }
      }
    }
    if (!tocEl) return;
    const contentChildren = Array.from(page.children).filter(c => !isHeaderOrFooter(c)) as HTMLElement[];
    let rootChild = tocEl;
    while (rootChild.parentElement && rootChild.parentElement !== page) {
      rootChild = rootChild.parentElement as HTMLElement;
    }
    const idx = contentChildren.indexOf(rootChild);
    if (idx < 0) return;
    
    // 如果 TOC 是页面的第一个内容元素，则不需要强制分页（它已经在新页面的顶部了）
    // 除非页面前面有非内容元素（但这已经被 filter 排除）
    // 所以如果是第 0 个，直接返回
    if (idx === 0) return;

    const newPage = page.cloneNode(false) as HTMLElement;
    newPage.removeAttribute('id');
    page.parentElement?.insertBefore(newPage, page.nextSibling);
    if (header) newPage.appendChild(header.cloneNode(true));
    // 若根子元素本身是目录容器，则在其内部找到第一个包含 tocEl 的直接子节点索引并从该处拆分
    const containerToSplit = contentChildren[idx];
    let splitIndex = -1;
    const childrenOfContainer = Array.from(containerToSplit.children) as HTMLElement[];
    for (let k = 0; k < childrenOfContainer.length; k++) {
      if (childrenOfContainer[k].contains(tocEl)) { splitIndex = k; break; }
    }
    if (splitIndex >= 0) {
      const newContainer = containerToSplit.cloneNode(false) as HTMLElement;
      for (let k = splitIndex; k < childrenOfContainer.length; k++) {
        newContainer.appendChild(childrenOfContainer[k]);
      }
      newPage.appendChild(newContainer);
      for (let j = idx + 1; j < contentChildren.length; j++) {
        newPage.appendChild(contentChildren[j]);
      }
    } else {
      // 回退：直接将该子元素及其后续兄弟移到新页
      for (let j = idx; j < contentChildren.length; j++) {
        newPage.appendChild(contentChildren[j]);
      }
    }
    if (footer) newPage.appendChild(footer.cloneNode(true));
    const firstContent = Array.from(newPage.children).find(c => c.tagName !== 'HEADER' && c.tagName !== 'FOOTER') as HTMLElement | undefined;
    if (firstContent) firstContent.style.marginTop = '0px';
    processPage(newPage, MAX_HEIGHT);
  };
  pages.forEach((page, index) => {
    if (index === 0) {
      forceBreakBeforeToc(page as HTMLElement);
    }
    processPage(page as HTMLElement, MAX_HEIGHT);
  });
  
  // 所有分页处理完成后，统一更新页码
  updatePageNumbers(container);
};

const fillGaps = (container: HTMLElement) => {
  const pages = Array.from(container.querySelectorAll('.docx')) as HTMLElement[];
  const getLimit = (page: HTMLElement) => {
    const header = Array.from(page.children).find(c => c.tagName === 'HEADER') as HTMLElement | undefined;
    const footer = Array.from(page.children).find(c => c.tagName === 'FOOTER') as HTMLElement | undefined;
    const style = window.getComputedStyle(page);
    const pt = parseFloat(style.paddingTop) || 0;
    const pb = parseFloat(style.paddingBottom) || 0;
    const hh = header ? header.offsetHeight : 0;
    const fh = footer ? footer.offsetHeight : 0;
    return 1165 - pt - pb - hh - fh;
  };
  const getContentChildren = (page: HTMLElement) => {
    const header = Array.from(page.children).find(c => c.tagName === 'HEADER') as HTMLElement | undefined;
    const footer = Array.from(page.children).find(c => c.tagName === 'FOOTER') as HTMLElement | undefined;
    return Array.from(page.children).filter(c => c !== header && c !== footer) as HTMLElement[];
  };
  const totalHeight = (els: HTMLElement[]) => {
    let h = 0;
    for (const el of els) {
      if (getComputedStyle(el).display === 'none') continue;
      const s = getComputedStyle(el);
      h += el.offsetHeight + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
    }
    return h;
  };
  for (let i = 0; i < pages.length - 1; i++) {
    const cur = pages[i];
    const next = pages[i + 1];
    if (!cur || !next) continue;
    let limit = getLimit(cur);
    let children = getContentChildren(cur);
    let used = totalHeight(children);
    let remain = limit - used;
    if (remain < 20) continue;
    const nextChildren = getContentChildren(next).filter(c => getComputedStyle(c).display !== 'none');
    let idx = 0;
    while (remain >= 20 && idx < nextChildren.length) {
      const el = nextChildren[idx];
      const s = getComputedStyle(el);
      const h = el.offsetHeight + (parseFloat(s.marginTop) || 0) + (parseFloat(s.marginBottom) || 0);
      if (h <= remain) {
        cur.appendChild(el);
        remain -= h;
        idx++;
      } else {
        break;
      }
    }
  }
  updatePageNumbers(container);
};

const repaginateFromScratch = (container: HTMLElement) => {
  // removeEmptyParagraphs(container);
  const pages = Array.from(container.querySelectorAll('.docx')) as HTMLElement[];
  if (pages.length === 0) return;
  const first = pages[0];
  const header = Array.from(first.children).find(c => c.tagName === 'HEADER') as HTMLElement | undefined;
  const footer = Array.from(first.children).find(c => c.tagName === 'FOOTER') as HTMLElement | undefined;
  const getContentChildren = (page: HTMLElement) => {
    const h = Array.from(page.children).find(c => c.tagName === 'HEADER') as HTMLElement | undefined;
    const f = Array.from(page.children).find(c => c.tagName === 'FOOTER') as HTMLElement | undefined;
    return Array.from(page.children).filter(c => c !== h && c !== f) as HTMLElement[];
  };
  const allContent: HTMLElement[] = [];
  pages.forEach(p => {
    const children = getContentChildren(p);
    children.forEach(el => {
      if (getComputedStyle(el).display === 'none') return;
      allContent.push(el);
    });
  });
  // 清空所有页面内容，保留第一页和其头/脚
  pages.slice(1).forEach(p => p.remove());
  const contentChildren = getContentChildren(first);
  contentChildren.forEach(c => c.remove());
  // 重新装载内容到第一页
  allContent.forEach(el => first.appendChild(el));
  // 如缺失页脚，补上一个空 footer，以便分页后复制
  if (!footer) {
    const f = document.createElement('footer');
    f.style.display = 'block';
    first.appendChild(f);
  }
  // 执行分页与页码更新
  processPage(first, 1165);
  updatePageNumbers(container);
};

const DocumentPreview: React.FC = () => {
  const { currentFile, headings, checkedKeys } = useDocStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const headingElementsRef = useRef<{ element: HTMLElement, heading: HeadingNode }[]>([]);
  const [loading, setLoading] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const styleMapperRef = useRef<StyleMapper | null>(null);

  // 计算集合：自身勾选集合 + 标题可见集合（自身勾选或有勾选子孙）
  const checkedSet = React.useMemo(() => new Set<string>(checkedKeys), [checkedKeys]);
  const headingVisibleKeys = React.useMemo(() => {
    const visible = new Set<string>();
    const hasCheckedDescendant = (node: HeadingNode): boolean => {
      if (checkedSet.has(node.key)) return true;
      return (node.children || []).some(hasCheckedDescendant);
    };
    const collect = (nodes: HeadingNode[]) => {
      nodes.forEach((n) => {
        if (hasCheckedDescendant(n)) visible.add(n.key);
        collect(n.children || []);
      });
    };
    collect(headings);
    return visible;
  }, [headings, checkedSet]);

  // 1. 渲染文档
  useEffect(() => {
    if (!currentFile || !containerRef.current) return;

    let active = true;

    const renderDoc = async () => {
      try {
        setLoading(true);
        setError(null);
        setIsRendered(false);
        
        // Clear previous content
        if (containerRef.current) {
          containerRef.current.innerHTML = '';
        }
        headingElementsRef.current = []; // Reset mapping
        
        // Convert File to ArrayBuffer
        const arrayBuffer = await currentFile.arrayBuffer();

        if (!active) return;
        
        // Render options
        const options = {
          className: 'docx', // 保持默认类名 'docx'，这样 wrapper 类名就是 'docx-wrapper'，页面类名是 'docx'
          inWrapper: true, // 启用 wrapper 以获得更好的分页支持
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          experimental: true, // 开启实验性功能以获得更好的分页支持
          trimXmlDeclaration: true,
          useBase64URL: true, // 开启 Base64 URL 以确保图片稳定显示
          useMathMLPolyfill: false,
          debug: false,
        };

        if (containerRef.current) {
          await renderAsync(arrayBuffer, containerRef.current, undefined, options);
          
          if (active) {
            // 使用 requestAnimationFrame 确保 DOM 渲染完成
            requestAnimationFrame(() => {
              if (active) {
                // 执行手动分页逻辑，处理超长页面
                paginateDocument(containerRef.current!);
                if (!styleMapperRef.current) styleMapperRef.current = new StyleMapper();
                styleMapperRef.current.applyGeneric(containerRef.current!);
                setIsRendered(true);
              }
            });
          }
        }
      } catch (err) {
        console.error('Failed to render document:', err);
        if (active) {
          setError('文档预览失败，请检查文件是否损坏');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    renderDoc();

    return () => {
      active = false;
      if (styleMapperRef.current) {
        styleMapperRef.current.destroy();
        styleMapperRef.current = null;
      }
    };
  }, [currentFile]);

  // 2. 映射 DOM 元素到标题节点
  const mapDomToHeadings = () => {
    if (!containerRef.current || headings.length === 0) return;
    
    const isTocTitle = (text: string) => {
        const t = text.trim();
        if (!t) return false;
        return /^目\s*录$/.test(t) || /^Table of Contents$/i.test(t) || /^Contents$/i.test(t) || /^目錄$/.test(t);
    };

    const flatHeadings = flattenHeadings(headings);
    const mapped: { element: HTMLElement, heading: HeadingNode }[] = [];
    
    // 清除之前的标记和生成的序号
    if (containerRef.current) {
      // 1. 移除所有动态生成的序号 span
      const dynamicNumbers = containerRef.current.querySelectorAll('.dynamic-number');
      dynamicNumbers.forEach(span => span.remove());

      // 2. 移除 dynamic-numbered 类名
      const dynamicNumbered = containerRef.current.querySelectorAll('.dynamic-numbered');
      dynamicNumbered.forEach(el => el.classList.remove('dynamic-numbered'));

      // 3. 清除 DOM 属性
      const allElements = containerRef.current.querySelectorAll('*');
      allElements.forEach((el: any) => {
        delete el.__headingNode;
        delete el.__containsHeading;
      });
    }

    // 使用 TreeWalker 查找包含文本的块级元素
    const walker = document.createTreeWalker(
      containerRef.current, 
      NodeFilter.SHOW_ELEMENT, 
      {
        acceptNode: (node) => {
          // 过滤出可能的标题容器（忽略 span 等内联元素，关注 p, div, h1-h6 等）
          const tagName = (node as Element).tagName;
          // 移除 SECTION 和 ARTICLE，因为它们通常是页面容器，如果匹配了会导致子元素无法匹配
          if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tagName)) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    let node: Node | null;
    let headingIndex = 0;
    
    while ((node = walker.nextNode()) && headingIndex < flatHeadings.length) {
        const el = node as HTMLElement;
        
        // 检查是否是目录行 (TOC Line)
        // 目录行特征：
        // 1. 包含指向内部 TOC 锚点的链接 (href="#_Toc...") - 最强信号 (Source)
        // 只要包含这种链接，几乎肯定是目录行（或者是交叉引用，但在标题匹配上下文中，我们应优先跳过）
        const tocLink = el.querySelector('a[href^="#_Toc"]');
        if (tocLink) {
             continue; 
        }

        // 2. 包含目录引导符 (tab leader) - 强信号
        if (el.querySelector('.docx-tab-stop')) {
             continue;
        }

        // 检查是否包含 Word TOC 锚点 (Target) - 这是真实标题的最强信号
        // 注意：检查元素自身及其子元素
        const elId = el.getAttribute('id') || '';
        const elName = el.getAttribute('name') || '';
        const hasTocAnchor = 
             elId.startsWith('_Toc') || 
             elName.startsWith('_Toc') || 
             !!el.querySelector('[id^="_Toc"]') || 
             !!el.querySelector('[name^="_Toc"]');
        
        // 获取该元素的纯文本内容（合并子元素的文本）
        const text = el.textContent?.trim() || '';

        // 3. 文本模式匹配 (弱信号)
        // 如果没有 TOC 锚点，且文本看起来像目录 (标题 + ...... + 页码)
        if (!hasTocAnchor) {
             const isTocPattern = 
                 // 包含特殊空白符或制表符，且以数字结尾
                 ((/[\t\u2002\u2003]/.test(text)) && /\d+$/.test(text)) || 
                 // 连续点号 + 数字
                 /\.{4,}\s*\d+$/.test(text) ||
                 // 多个空格 + 数字
                 /\s{2,}\d+$/.test(text);
             
             if (isTocPattern) {
                 continue;
             }
        }

        // 识别 TOC 标题，并在 map 过程中特殊处理
        const isTocHeader = isTocTitle(text);

        const targetHeading = flatHeadings[headingIndex];
        
        // 清理标题文本（移除序号）以进行比较
        // 匹配: "1. ", "1.1 ", "1.1.1 ", "第1章 ", "第一章 "
        const cleanText = (str: string) => {
          return str
            .replace(/^[0-9]+(\.[0-9]+)*\s*/, '') // 移除数字序号 (e.g. "1.1 ")
            .replace(/^第\s*[0-9零一二三四五六七八九十百千]+\s*章[\s\.]*/, '') // 移除中文章节号
            .trim();
        };

        const cleanDomText = cleanText(text);
        const cleanTargetTitle = cleanText(targetHeading.title);

        // 如果是 TOC 标题，我们标记它为 TOC 区域开始，并且赋予 data-is-toc="true"
        // 同时，我们也尝试匹配 headings 中的条目（因为 docParser 可能没有跳过 TOC）
        // 如果 docParser 跳过了，那这里可能匹配不上，也没关系，我们依然强制显示它
        if (isTocHeader) {
           el.setAttribute('data-is-toc', 'true');
           // 标记后续直到下一个标题的内容都属于 TOC
           let next = el.nextElementSibling;
           while(next) {
              const nextTagName = next.tagName;
              if (['H1','H2','H3','H4','H5','H6'].includes(nextTagName)) {
                  // 遇到下一个可能的标题，停止
                  break; 
              }
              // 检查下一个元素是否是普通正文，或者是 TOC 内容
              // TOC 内容通常包含 tab stop
              if (next.querySelector('.docx-tab-stop') || nextTagName === 'P') {
                  next.setAttribute('data-is-toc', 'true');
              } else {
                  // 如果遇到其他大块元素，也可能是 TOC 容器，保守起见也标记
                  next.setAttribute('data-is-toc', 'true');
              }
              next = next.nextElementSibling;
           }
        }

        // 匹配逻辑：
        // 1. 清理后的文本完全相等
        // 2. 或者清理后的元素文本以清理后的目标标题开头（且长度差异不大，避免匹配到大容器）
        // 3. 或者清理后的元素文本包含清理后的目标标题（且长度差异不大）
        // 且该元素不是已匹配元素的子元素（防止重复匹配）
        if (cleanDomText && cleanTargetTitle) {
            let isMatch = false;
            
            // 严格匹配检查
            if (cleanDomText === cleanTargetTitle) {
                isMatch = true;
            } else if (cleanDomText.startsWith(cleanTargetTitle)) {
                 // 检查后缀
                 const suffix = cleanDomText.slice(cleanTargetTitle.length).trim();
                 // 如果后缀是纯数字或点+数字，且没有 TOC 锚点，很可能是目录行
                 const isPageNumSuffix = /^[\.\s]*\d+$/.test(suffix);
                 
                 if (!hasTocAnchor && isPageNumSuffix) {
                     isMatch = false;
                 } else if (cleanDomText.length < cleanTargetTitle.length + 50) {
                     isMatch = true;
                 }
            } else if (cleanDomText.includes(cleanTargetTitle) && cleanDomText.length < cleanTargetTitle.length + 50) {
                // 同样检查是否看起来像目录行
                if (!hasTocAnchor && /\.{4,}\s*\d+$/.test(cleanDomText)) {
                    isMatch = false;
                } else {
                    isMatch = true;
                }
            }

            if (isMatch) {
                 // 检查是否是之前匹配元素的子元素
                 let isChild = false;
                 for (const m of mapped) {
                   if (m.element.contains(el)) {
                     isChild = true;
                     break;
                   }
                 }
                 
                 if (!isChild) {
                     mapped.push({ element: el, heading: targetHeading });
                    (el as any).__headingNode = targetHeading;
                    el.setAttribute('data-heading-key', targetHeading.key);
                     
                     // 标记所有父级元素包含标题（避免被隐藏）
                     let parent = el.parentElement;
                     while (parent && parent !== containerRef.current) {
                       (parent as any).__containsHeading = true;
                       parent = parent.parentElement;
                     }
                     
                     headingIndex++;
                 }
            }
        }
    }
    
    console.log(`[DocumentPreview] Mapped ${mapped.length} / ${flatHeadings.length} headings.`);
    headingElementsRef.current = mapped;
    // 建立章节归属标记，便于后续快速显示/隐藏
    assignSectionOwnership();
    if (styleMapperRef.current) {
      styleMapperRef.current.applyHeadingClasses(headingElementsRef.current);
    }
    updateVisibilityAndNumbering();
  };

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
    return num.toString(); // 超过99直接返回数字，或者继续扩展
  };

  // 3. 更新可见性和序号
  const updateVisibilityAndNumbering = () => {
    if (!containerRef.current) return;
    
    // 序号计数器 (索引 1-6 对应 H1-H6)
    const counters = [0, 0, 0, 0, 0, 0, 0];
    
    const walker = document.createTreeWalker(containerRef.current, NodeFilter.SHOW_ELEMENT, null);
    let node: Node | null;
    
    while (node = walker.nextNode()) {
      const el = node as HTMLElement;
      
      if (el === containerRef.current) continue;
      
      // 优先处理 TOC 元素：强制显示
      if (el.getAttribute('data-is-toc') === 'true') {
        el.style.display = '';
        continue;
      }

      const headingNode = (el as any).__headingNode as HeadingNode | undefined;
      
      if (headingNode) {
        // 标题元素：显示条件 = 自身勾选或有勾选子孙
        const isHeadingVisible = headingVisibleKeys.has(headingNode.key);
        const isSelfChecked = checkedSet.has(headingNode.key);
        
        if (isHeadingVisible) {
          // 计算动态序号
          const level = headingNode.level;
          const title = headingNode.title.trim();

          // 规则1: "目录" 标题不生成序号，也不参与计数
          const isTOC = /^目\s*录$/.test(title);

          // 规则2: 中文章节 (如 "第一章", "第1章") 
          const chineseMatch = title.match(/^第\s*([0-9]+|[零一二三四五六七八九十百千]+)\s*章/);
          const isChineseChapter = !!chineseMatch;

          if (level >= 1 && level <= 6 && !isTOC) {
            counters[level]++;
            // 重置低级序号
            for (let i = level + 1; i <= 6; i++) counters[i] = 0;
            
            let numberStr = '';
            
            // 如果是中文章节，根据计数器动态生成新的中文序号
            if (isChineseChapter && chineseMatch) {
              const originalNumStr = chineseMatch[1];
              const isArabic = /^[0-9]+$/.test(originalNumStr);
              const currentCount = counters[level];
              
              let newNumStr = '';
              if (isArabic) {
                newNumStr = currentCount.toString();
              } else {
                newNumStr = toChineseNum(currentCount);
              }
              
              // 保持原有的空格格式
              // 原始: "第 1 章" -> match[0] = "第 1 章"
              // 我们需要重构这个字符串
              // 简单做法：直接替换 match[0] 中的数字部分
              // 但为了稳健，我们重新构建 "第" + num + "章"
              // 并尝试保留原始的间隔
              
              // 提取间隔
              const prefixMatch = title.match(/^第(\s*)/);
              const suffixMatch = title.match(/([0-9]+|[零一二三四五六七八九十百千]+)(\s*)章/);
              const space1 = prefixMatch ? prefixMatch[1] : '';
              const space2 = suffixMatch ? suffixMatch[2] : '';
              
              numberStr = `第${space1}${newNumStr}${space2}章 `; // 结尾加个空格与标题隔开
            } else {
              // 否则生成数字序号
              numberStr = counters.slice(1, level + 1).join('.') + ' ';
            }

            if (numberStr) {
              // 检查 DOM 文本是否已经包含该序号
              // 获取元素的纯文本内容（用于正则匹配），排除我们自己添加的动态元素
              const getOriginalText = (root: HTMLElement): string => {
                 let text = '';
                 const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                    acceptNode: (node) => {
                       const parent = node.parentElement;
                       if (parent && (parent.classList.contains('dynamic-number') || parent.classList.contains('dynamic-title-text'))) {
                           return NodeFilter.FILTER_REJECT;
                       }
                       return NodeFilter.FILTER_ACCEPT;
                    }
                 });
                 let node;
                 while(node = walker.nextNode()) {
                    text += node.textContent || '';
                 }
                 return text;
              };

              const fullText = getOriginalText(el);
              
              // 匹配旧序号：数字序号 (1.1) 或 中文序号 (第X章)
              // 必须在文本开头
              const oldNumberRegex = /^(\d+([\.\、]\d+)*[\.\、\s]*|第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)/;
              const match = fullText.match(oldNumberRegex);
              
              if (match) {
                // 如果匹配到旧序号，需要从 DOM 中移除这部分文本
                // 安全检查：如果 regex 匹配了整个文本，可能是误判，或者文本只有序号。
                // 如果是映射到的标题，通常应该包含标题文本。
                // 我们只在匹配长度小于总文本长度时执行移除，或者当总文本很长时（避免误删短文本）
                // 这里的逻辑是：保留至少一个字符的标题文本
                if (match[0].length < fullText.trim().length) {
                    let charsToRemove = match[0].length;
                    
                    const removeTextFromNode = (node: Node): boolean => {
                      if (charsToRemove <= 0) return true; // 完成
    
                      if (node.nodeType === Node.TEXT_NODE) {
                        const text = node.textContent || '';
                        if (text.length <= charsToRemove) {
                          // 该节点文本全部属于旧序号，清空
                          charsToRemove -= text.length;
                          node.textContent = '';
                        } else {
                          // 该节点包含旧序号的一部分和后续内容
                          node.textContent = text.substring(charsToRemove);
                          charsToRemove = 0;
                        }
                      } else if (node.nodeType === Node.ELEMENT_NODE) {
                         // 递归处理子节点
                         const childNodes = Array.from(node.childNodes);
                         for (const child of childNodes) {
                           // 跳过我们自己生成的 dynamic-number span
                           if ((child as HTMLElement).classList && (child as HTMLElement).classList.contains('dynamic-number')) {
                             continue;
                           }
                           if (removeTextFromNode(child)) return true;
                         }
                      }
                      return charsToRemove <= 0;
                    };
    
                    removeTextFromNode(el);
                }
              }

              // 隐藏原有的自动序号（CSS 方式，针对 list-style）
              if (!el.classList.contains('dynamic-numbered')) {
                el.classList.add('dynamic-numbered');
              }

              // 更新或创建 dynamic-number span
              let numberSpan = el.querySelector('.dynamic-number') as HTMLElement;
            if (!numberSpan) {
              numberSpan = document.createElement('span');
              numberSpan.className = 'dynamic-number';
              numberSpan.style.marginRight = '8px';
              el.prepend(numberSpan);
            }
            numberSpan.textContent = numberStr;

              // 标题文案补全：如果移除旧序号后文本为空，则使用目录中的标题
              const titleOldNumberRegex = /^(\d+([\.\、]\d+)*[\.\、\s]*|第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)/;
              const fullTextForTitle = getOriginalText(el);
              const textAfterRemoval = fullTextForTitle.replace(titleOldNumberRegex, '').trim();
              const tocTitle = headingNode.title.replace(titleOldNumberRegex, '').trim();

              if (!textAfterRemoval || textAfterRemoval !== tocTitle) {
                let titleSpan = el.querySelector('.dynamic-title-text') as HTMLElement;
                if (!titleSpan) {
                  titleSpan = document.createElement('span');
                  titleSpan.className = 'dynamic-title-text';
                  el.appendChild(titleSpan);
                }
                titleSpan.textContent = tocTitle;
                const children = Array.from(el.childNodes);
                children.forEach((child) => {
                  const elChild = child as HTMLElement;
                  const cls = elChild && elChild.classList ? elChild.classList : null;
                  const isKeep = cls && (cls.contains('dynamic-number') || cls.contains('dynamic-title-text'));
                  if (!isKeep && child.nodeType === Node.TEXT_NODE) {
                    child.textContent = '';
                  }
                });
              }
            }
          }

        }
        
        el.style.display = isHeadingVisible ? '' : 'none';
        // 同步对应章节内容的可见性
        const ownerSelector = `[data-section-owner="${headingNode.key}"]`;
        const owned = Array.from(containerRef.current.querySelectorAll(ownerSelector));
        owned.forEach((ownedEl: Element) => {
          (ownedEl as HTMLElement).style.display = isSelfChecked ? '' : 'none';
        });

        // 如果该标题被隐藏，压缩其后首个可见兄弟的顶部间距，避免大片留白
        if (!isHeadingVisible) {
          let next = el.nextElementSibling as HTMLElement | null;
          while (next && getComputedStyle(next).display === 'none') {
            next = next.nextElementSibling as HTMLElement | null;
          }
          if (next) {
            next.style.marginTop = '0px';
          }
        }
        
      } else {
        // 非标题元素：不做全局父级 gating，只依靠章节归属控制
      }
    }
    // 可见性更新后，压缩空页面并清理顶部间距
    const pages = Array.from(containerRef.current.querySelectorAll('.docx')) as HTMLElement[];
    pages.forEach((page, index) => {
      const header = page.querySelector('header');
      const footer = page.querySelector('footer');
      const children = Array.from(page.children).filter(c => c !== header && c !== footer) as HTMLElement[];
      const visibleChildren = children.filter(c => getComputedStyle(c).display !== 'none');
      if (visibleChildren.length === 0) {
        page.style.display = 'none';
      } else {
        page.style.display = '';
        const first = visibleChildren[0];
        // 仅对非首页执行顶部间距压缩，保留首页（封面）的原始布局
        if (first && index > 0) {
          first.style.marginTop = '0px';
        }
        // 清理仅包含隐藏子元素的可见包裹层，压缩间距
        children.forEach((c) => {
          const elc = c as HTMLElement;
          if (getComputedStyle(elc).display !== 'none') {
            const sub = Array.from(elc.children) as HTMLElement[];
            const visibleSub = sub.filter(s => getComputedStyle(s).display !== 'none');
            if (visibleSub.length === 0 && (elc.textContent || '').trim() === '') {
              elc.style.display = 'none';
            }
          }
        });
      }
    });
    // 先尝试直接回填，若仍有明显空白可继续使用完全重排
    fillGaps(containerRef.current);
    // 全量重排，确保中间页空白被彻底压缩
    repaginateFromScratch(containerRef.current);
  };

  // 依据标题映射结果，为后续兄弟元素标记归属章节 key
  const assignSectionOwnership = () => {
    if (!containerRef.current) return;
    const walker = document.createTreeWalker(containerRef.current, NodeFilter.SHOW_ELEMENT, null);
    let node: Node | null;
    let currentOwnerKey: string | null = null;

    while (node = walker.nextNode()) {
      const el = node as HTMLElement;
      if (el === containerRef.current) continue;

      const headingKey = el.getAttribute('data-heading-key');
      if (headingKey) {
        currentOwnerKey = headingKey;
        continue;
      }

      // 跳过包含标题的父容器，避免整体隐藏页面结构
      if ((el as any).__containsHeading) continue;

      // 仅为常见块级内容标记归属
      const isBlock = ['P','DIV','TABLE','UL','OL','LI','SECTION','ARTICLE','BLOCKQUOTE','PRE','FIGURE','DL','DT','DD'].includes(el.tagName);
      if (isBlock && currentOwnerKey) {
        el.setAttribute('data-section-owner', currentOwnerKey);
      }
    }
  };

  // 注入隐藏原有序号的样式
  useEffect(() => {
    const styleId = 'dynamic-numbering-style';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.innerHTML = `
        .dynamic-numbered {
          list-style: none !important;
        }
        .dynamic-numbered::before, .dynamic-numbered::after {
          content: none !important;
          display: none !important;
        }
        @keyframes highlight-pulse {
          0% { background-color: transparent; }
          20% { background-color: #fff1b8; }
          80% { background-color: #fff1b8; }
          100% { background-color: transparent; }
        }
        .highlight-effect {
          animation: highlight-pulse 3s ease-in-out;
        }
        /* 尝试隐藏可能存在的内部序号 span (通常 docx-preview 不会这样，但以防万一) */
        /* 这一步比较危险，可能会误伤，先只处理 list-style 和 pseudo-elements */
      `;
      document.head.appendChild(style);
    }
  }, []);

  // 当文档渲染完成且解析出目录后，建立映射
  useEffect(() => {
    if (isRendered && headings.length > 0) {
      mapDomToHeadings();
      
      // 双重保险：稍微延迟后再映射一次，防止首次渲染 DOM 不稳定或字体加载导致的布局偏移
      const timer = setTimeout(() => {
        mapDomToHeadings();
      }, 500);
      
      return () => clearTimeout(timer);
    }
  }, [isRendered, headings]);

  // 当勾选状态改变时，更新可见性
  useEffect(() => {
    updateVisibilityAndNumbering();
  }, [checkedKeys]);

  // 监听滚动事件 (保持原有逻辑)
  useEffect(() => {
    const handleScrollToHeading = (event: any) => {
      const key = event.detail?.key as string | undefined;
      const title = event.detail?.title as string | undefined;
      if (!containerRef.current) return;

      let targetElement: HTMLElement | null = null;

      // 1. 优先按 data-heading-key 精确定位
      if (key) {
        targetElement = containerRef.current.querySelector(`[data-heading-key="${key}"]`) as HTMLElement | null;
      }

      // 2. 退化为已映射缓存匹配（标题完全相等）
      if (!targetElement && title) {
        const mapped = headingElementsRef.current.find(h => h.heading.title === title);
        if (mapped) targetElement = mapped.element;
      }

      // 3. 最后兜底：文本查找（不可靠，仅作为紧急退化）
      if (!targetElement && title) {
        const findElementByText = (root: HTMLElement, text: string): HTMLElement | null => {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
          let node;
          while (node = walker.nextNode()) {
            if (node.textContent?.trim() === text.trim()) {
              return node.parentElement as HTMLElement;
            }
          }
          return null;
        };
        targetElement = findElementByText(containerRef.current, title);
      }

      if (targetElement && containerRef.current) {
        // 计算目标元素相对于容器的偏移量
        const containerRect = containerRef.current.getBoundingClientRect();
        const elementRect = targetElement.getBoundingClientRect();
        
        // 当前容器的 scrollTop
        const currentScrollTop = containerRef.current.scrollTop;
        
        // 目标位置 = 当前 scrollTop + (元素相对视口顶部 - 容器相对视口顶部) - 容器高度的一半(居中) + 元素高度的一半
        // 简化：scrollTop + (elementTop - containerTop)
        // 为了居中：scrollTop + (elementTop - containerTop) - (containerHeight / 2) + (elementHeight / 2)
        
        const relativeTop = elementRect.top - containerRect.top;
        const targetScrollTop = currentScrollTop + relativeTop - (containerRect.height / 2) + (elementRect.height / 2);

        containerRef.current.scrollTo({
          top: targetScrollTop,
          behavior: 'smooth'
        });

        // 移除之前的动画类（如果存在），以便重新触发动画
        targetElement.classList.remove('highlight-effect');
        // 触发重排 (Reflow) 以便重置动画
        void targetElement.offsetWidth;
        // 添加动画类
        targetElement.classList.add('highlight-effect');

        // 动画结束后移除类（可选，保持 DOM 整洁）
        const removeHandler = () => {
          if (targetElement) {
            targetElement.classList.remove('highlight-effect');
            targetElement.removeEventListener('animationend', removeHandler);
          }
        };
        targetElement.addEventListener('animationend', removeHandler);
      }
    };

    window.addEventListener('scrollToHeading', handleScrollToHeading);
    return () => window.removeEventListener('scrollToHeading', handleScrollToHeading);
  }, []);

  if (!currentFile) {
    return (
      <div style={{ 
        display: 'flex', 
        flexDirection: 'column', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100%', 
        textAlign: 'center', 
        padding: '40px 0' 
      }}>
        <Title level={4} style={{ color: '#595959', marginBottom: 8 }}>欢迎使用项目文档管理器</Title>
        <Text type="secondary" style={{ display: 'block', marginBottom: 24 }}>
          请点击左侧上传 DOCX 文档开始使用
        </Text>
        <Text type="secondary" style={{ fontSize: '12px', color: '#1677ff' }}>
          支持页眉页脚、图片、表格的高保真预览和章节筛选
        </Text>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {loading && (
        <div style={{ 
          position: 'absolute', 
          top: 0, 
          left: 0, 
          right: 0, 
          bottom: 0, 
          zIndex: 10, 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center',
          background: 'rgba(255, 255, 255, 0.8)'
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <Spin size="large" />
            <span style={{ color: '#1677ff' }}>正在渲染预览...</span>
          </div>
        </div>
      )}

      {error && (
        <div style={{ 
          position: 'absolute', 
          top: 0, 
          left: 0, 
          right: 0, 
          bottom: 0, 
          zIndex: 10, 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center',
          background: '#fff'
        }}>
          <Empty description={error} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      )}

      <div 
        ref={containerRef} 
        className="docx-container"
        style={{ 
          width: '100%', 
          height: '100%', 
          overflow: 'auto', 
          background: '#f0f2f5' // 灰色背景，与白色纸张形成对比
        }}
      />
    </div>
  );
};

export default DocumentPreview;

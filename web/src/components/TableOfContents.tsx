import React, { useMemo } from 'react';
import { Tree, Empty, Spin, Tooltip } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import { useDocStore } from '../store/useDocStore';
import type { HeadingNode } from '../utils/docParser';
import { calculateNumbering } from '../utils/numbering';

interface TableOfContentsProps {
  onSelect?: (node: HeadingNode) => void;
}

const TableOfContents: React.FC<TableOfContentsProps> = ({ onSelect }) => {
  const { headings, isParsing, checkedKeys, setCheckedKeys } = useDocStore();

  // 计算动态序号 Map
  const numberingMap = useMemo(() => {
    return calculateNumbering(headings, checkedKeys);
  }, [headings, checkedKeys]);

  if (isParsing) {
    return (
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
        <Spin />
        <span style={{ color: '#666' }}>正在解析目录...</span>
      </div>
    );
  }

  if (!headings || headings.length === 0) {
    return (
      <div style={{ padding: '20px' }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无目录信息" />
      </div>
    );
  }

  const handleSelect = (selectedKeys: React.Key[], info: any) => {
    if (selectedKeys.length > 0 && onSelect) {
      onSelect(info.node as HeadingNode);
    }
  };

  const handleCheck = (checked: React.Key[] | { checked: React.Key[]; halfChecked: React.Key[] }) => {
    const nextKeys = Array.isArray(checked) ? checked : checked.checked;
    (window as any).__lastCheckedKeys = nextKeys;
    setCheckedKeys(nextKeys as string[]);
  };

  const titleRender = (node: any) => {
    const headingNode = node as HeadingNode;
    const numberStr = numberingMap.get(headingNode.key);
    let displayTitle = headingNode.title;

    // 总是尝试移除 displayTitle 开头的旧序号，确保未选中时不显示静态序号
    // 匹配：数字序号 (1.1) 或 中文序号 (第X章)
    const oldNumberRegex = /^(\d+([\.\、]\d+)*[\.\、\s]*|第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)/;
    const match = displayTitle.match(oldNumberRegex);
    if (match) {
            displayTitle = displayTitle.substring(match[0].length).trim();
    }
    
    return (
      <Tooltip title={headingNode.title} mouseEnterDelay={1}>
        <span style={{ 
          overflow: 'hidden', 
          textOverflow: 'ellipsis', 
          whiteSpace: 'nowrap', 
          display: 'inline-block',
          verticalAlign: 'bottom',
          maxWidth: 'calc(100% - 24px)' // Leave some space for icons/checkbox
        }}>
          {numberStr && <span style={{ marginRight: '4px' }}>{numberStr}</span>}
          {displayTitle}
        </span>
      </Tooltip>
    );
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', width: '100%' }}>
      <Tree
        blockNode
        checkable
        showLine
        switcherIcon={<DownOutlined />}
        defaultExpandAll
        treeData={headings}
        onSelect={handleSelect}
        onCheck={handleCheck}
        checkedKeys={checkedKeys}
        titleRender={titleRender}
        style={{ background: 'transparent' }}
      />
    </div>
  );
};

export default TableOfContents;

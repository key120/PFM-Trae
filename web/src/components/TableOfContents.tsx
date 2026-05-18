import React, { useMemo, useCallback } from 'react';
import { Tree, Empty, Spin, Tooltip } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { DownOutlined } from '@ant-design/icons';
import { useDocStore } from '../store/useDocStore';
import { useTeamStore } from '../store/useTeamStore';
import type { HeadingNode } from '../utils/docParser';
import { calculateNumbering } from '../utils/numbering';

interface TableOfContentsProps {
  onSelect?: (node: HeadingNode) => void;
}

const OLD_NUMBER_REGEX = /^(\d+([\.\、]\d+)*[\.\、\s]*|第\s*[0-9零一二三四五六七八九十百千]+\s*章[\.\s]*)/;

const TableOfContents: React.FC<TableOfContentsProps> = ({ onSelect }) => {
  const headings = useDocStore((s) => s.headings);
  const isParsing = useDocStore((s) => s.isParsing);
  const checkedKeys = useDocStore((s) => s.checkedKeys);
  const setCheckedKeys = useDocStore((s) => s.setCheckedKeys);
  const documentMode = useDocStore((s) => s.documentMode);
  const currentUserRole = useTeamStore((s) => s.currentUserRole);
  const checkDisabled = documentMode === 'shared' && currentUserRole === 'reader';

  const numberingMap = useMemo(() => {
    return calculateNumbering(headings, checkedKeys);
  }, [headings, checkedKeys]);

  const handleSelect = useCallback(
    (selectedKeys: React.Key[], info: { node: DataNode }) => {
      if (selectedKeys.length > 0 && onSelect) {
        onSelect(info.node as HeadingNode);
      }
    },
    [onSelect],
  );

  const handleCheck = useCallback(
    (checked: React.Key[] | { checked: React.Key[]; halfChecked: React.Key[] }) => {
      if (checkDisabled) return;
      const nextKeys = Array.isArray(checked) ? checked : checked.checked;
      setCheckedKeys(nextKeys as string[]);
    },
    [checkDisabled, setCheckedKeys],
  );

  const titleRender = useCallback(
    (node: DataNode) => {
      const headingNode = node as HeadingNode;
      const numberStr = numberingMap.get(headingNode.key);
      let displayTitle = headingNode.title;
      const match = displayTitle.match(OLD_NUMBER_REGEX);
      if (match) {
        displayTitle = displayTitle.substring(match[0].length).trim();
      }
      return (
        <Tooltip title={headingNode.title} mouseEnterDelay={0.3}>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'inline-block',
            verticalAlign: 'bottom',
            maxWidth: 'calc(100% - 24px)',
          }}>
            {numberStr && <span style={{ marginRight: '4px' }}>{numberStr}</span>}
            {displayTitle}
          </span>
        </Tooltip>
      );
    },
    [numberingMap],
  );

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

  return (
    <div style={{ flex: 1, overflow: 'auto', width: '100%' }}>
      <Tree
        blockNode
        checkable
        checkStrictly={false}
        showLine
        switcherIcon={<DownOutlined />}
        defaultExpandAll
        treeData={headings}
        onSelect={handleSelect}
        onCheck={handleCheck}
        checkedKeys={checkedKeys}
        disabled={checkDisabled}
        titleRender={titleRender}
        style={{ background: 'transparent' }}
      />
    </div>
  );
};

export default TableOfContents;

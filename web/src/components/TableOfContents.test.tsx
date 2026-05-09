import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import TableOfContents from './TableOfContents';

const docStoreState = {
  headings: [
    { id: 'h1', key: 'h1', title: '第一章', level: 1, children: [] },
    { id: 'h2', key: 'h2', title: '第二章', level: 1, children: [] },
  ],
  isParsing: false,
  checkedKeys: ['h1'],
  setCheckedKeys: vi.fn(),
  documentMode: 'shared' as 'shared' | 'personal' | null,
};

const teamStoreState = {
  currentUserRole: 'reader' as 'reader' | 'editor' | 'admin' | null,
};

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => docStoreState,
}));

vi.mock('../store/useTeamStore', () => ({
  useTeamStore: () => teamStoreState,
}));

vi.mock('../utils/numbering', () => ({
  calculateNumbering: vi.fn(() => new Map<string, string>()),
}));

describe('TableOfContents 权限联动', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    docStoreState.documentMode = 'shared';
    teamStoreState.currentUserRole = 'reader';
    docStoreState.checkedKeys = ['h1'];
  });

  it('reader 在共享文档下禁用目录多选框', () => {
    const { container } = render(<TableOfContents />);

    const checkbox = container.querySelector('.ant-tree-checkbox');
    expect(checkbox?.className).toContain('ant-tree-checkbox-disabled');
  });

  it('reader 在共享文档下不会触发勾选变更', () => {
    render(<TableOfContents />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select 第一章' }));
    expect(docStoreState.setCheckedKeys).not.toHaveBeenCalled();
  });

  it('editor 在共享文档下允许操作目录多选框', () => {
    teamStoreState.currentUserRole = 'editor';
    const { container } = render(<TableOfContents />);

    const checkbox = container.querySelector('.ant-tree-checkbox');
    expect(checkbox?.className).not.toContain('ant-tree-checkbox-disabled');
  });
});

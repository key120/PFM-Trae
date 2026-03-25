import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PersonalDocumentList from './PersonalDocumentList';
import * as documentService from '../services/documentService';

const mockAuthState = {
  user: { id: 'user-1', email: 'tester@example.com' },
};

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => mockAuthState,
}));

const setFile = vi.fn();
const setCurrentDocumentId = vi.fn();
const setCurrentDocumentVersion = vi.fn();
const setInitialCheckedKeys = vi.fn();

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => ({
    setFile,
    setCurrentDocumentId,
    setCurrentDocumentVersion,
    setInitialCheckedKeys,
  }),
}));

vi.mock('../services/documentService');

describe('PersonalDocumentList', () => {
  it('无数据时展示空态', async () => {
    const loader = vi.fn().mockResolvedValue([]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('暂无个人文档')).toBeTruthy();
    });

    expect(loader).toHaveBeenCalledWith('user-1');
  });

  it('有数据时展示文档卡片和字段', async () => {
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024 * 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      },
    ]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    expect(screen.getByText('版本号：—')).toBeTruthy();
    expect(screen.getByText('作者：tester@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /载.*入/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /共.*享/ })).toBeTruthy();
  });

  it('有版本信息时展示最新版本号', async () => {
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024 * 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
        version: 'V1.0.0',
        remark: '第一次保存',
      },
    ]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    expect(screen.getByText('版本号：V1.0.0')).toBeTruthy();
    expect(screen.getByText('备注：第一次保存')).toBeTruthy();
  });

  it('共享按钮切换文案并控制共享设置弹窗', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024 * 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      },
    ]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    const shareButton = await screen.findByRole('button', { name: /共.*享/ });
    await user.click(shareButton);

    await waitFor(() => {
      expect(screen.getByText('共享设置')).toBeTruthy();
    });

    expect(screen.getByRole('button', { name: '取消共享' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /关.*闭/ }));

    await user.click(screen.getByRole('button', { name: '取消共享' }));

    expect(screen.getByRole('button', { name: /共.*享/ })).toBeTruthy();
  });

  it('收到保存事件时重新加载列表', async () => {
    const loader = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'doc-1',
          name: '第一次文档',
          size: 1024,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'doc-1',
          name: '第二次文档',
          size: 2048,
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-02T00:00:00Z',
        },
      ]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('第一次文档')).toBeTruthy();
    });

    window.dispatchEvent(new Event('personalDocumentsChanged'));

    await waitFor(() => {
      expect(screen.getByText('第二次文档')).toBeTruthy();
    });

    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('点击载入按钮时加载最新版本并写入文档 store', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
        version: 'V1.0.3',
        remark: '最新备注',
        versions: [
          {
            version: 'V1.0.3',
            remark: '最新备注',
            author: 'tester@example.com',
            createdAt: '2025-01-02T00:00:00Z',
          },
        ],
      },
    ]);

    const loadMock = documentService.loadPersonalDocument as unknown as MockFn;
    loadMock.mockResolvedValue({
      file: new File(['test'], 'loaded.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      version: 'V1.0.3',
      remark: '最新备注',
      selectedKeys: ['k1', 'k2'],
    });

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /载.*入/ }));

    await waitFor(() => {
      expect(loadMock).toHaveBeenCalledWith('user-1', 'doc-1');
    });

    expect(setFile).toHaveBeenCalledTimes(1);
    expect(setCurrentDocumentId).toHaveBeenCalledWith('doc-1');
    expect(setCurrentDocumentVersion).toHaveBeenCalledWith('V1.0.3');
    expect(setInitialCheckedKeys).toHaveBeenCalledWith(['k1', 'k2']);
  });

  it('版本下拉条目中展示版本大小', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 2048,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
        version: 'V1.1.0',
        remark: '第二次',
        versions: [
          {
            version: 'V1.1.0',
            remark: '第二次',
            author: 'tester@example.com',
            createdAt: '2025-01-02T00:00:00Z',
            sizeBytes: 2048,
          },
          {
            version: 'V1.0.0',
            remark: '第一次',
            author: 'tester@example.com',
            createdAt: '2025-01-01T00:00:00Z',
            sizeBytes: 1024,
          },
        ],
      },
    ]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    // 点击版本号展开下拉
    await user.click(screen.getByText(/版本号：V1\.1\.0/));

    await waitFor(() => {
      expect(screen.getByText('最新')).toBeTruthy();
    });

    // 两个版本的大小均应显示（下拉中）
    const sizes = screen.getAllByText(/大小：/);
    // sizes[0] 是卡片本身的大小，sizes[1] 和 sizes[2] 是下拉中两个版本的大小
    const sizeTexts = sizes.map((el) => el.textContent ?? '');
    expect(sizeTexts.some((t) => t.includes('2.0 KB'))).toBe(true);
    expect(sizeTexts.some((t) => t.includes('1.0 KB'))).toBe(true);
  });
});

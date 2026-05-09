import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, act, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';import userEvent from '@testing-library/user-event';
import { message, Modal } from 'antd';
import PersonalDocumentList from './PersonalDocumentList';
import * as documentService from '../services/documentService';
import * as cryptoKeyService from '../services/cryptoKeyService';
import * as teamService from '../services/teamService';

type MessageErrorReturn = ReturnType<typeof message.error>;
type ModalConfirmReturn = ReturnType<typeof Modal.confirm>;

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
const setDocumentMode = vi.fn();
const setDocumentAccessRole = vi.fn();
const setCurrentTeamScopedShare = vi.fn();

vi.mock('../store/useDocStore', () => ({
  useDocStore: () => ({
    setFile,
    setCurrentDocumentId,
    setCurrentDocumentVersion,
    setInitialCheckedKeys,
    setDocumentMode,
    setDocumentAccessRole,
    setCurrentTeamScopedShare,
  }),
}));

vi.mock('../services/documentService');
vi.mock('../services/cryptoKeyService', () => ({
  ensureUserKeyPair: vi.fn(),
  restoreUserPrivateKey: vi.fn(),
}));
vi.mock('../services/teamService', () => ({
  fetchTeamGroups: vi.fn(),
  fetchTeamMembers: vi.fn(),
}));

const mockTeamState = {
  currentTeamId: 'team-1',
};

vi.mock('../store/useTeamStore', () => ({
  useTeamStore: () => mockTeamState,
}));

describe('PersonalDocumentList', () => {
  it('无数据时展示空态', async () => {
    const loader = vi.fn().mockResolvedValue([]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('暂无个人文档')).toBeTruthy();
    });

    expect(loader).toHaveBeenCalledWith('user-1');
  });

  it('打开当前团队时使用当前团队范围的个人文档查询', async () => {
    vi.mocked(documentService.fetchPersonalDocumentsForCurrentTeam).mockResolvedValue([]);

    render(<PersonalDocumentList open />);

    await waitFor(() => {
      expect(documentService.fetchPersonalDocumentsForCurrentTeam).toHaveBeenCalledWith('user-1', 'team-1');
    });
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

  it('共享按钮打开弹窗，关闭后保持未共享状态', async () => {
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

    vi.mocked(documentService.isDocumentSharedInTeam).mockResolvedValue(false);
    vi.mocked(teamService.fetchTeamGroups).mockResolvedValue([]);
    vi.mocked(teamService.fetchTeamMembers).mockResolvedValue([]);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    const shareButton = await screen.findByRole('button', { name: /共.*享/ });
    await user.click(shareButton);

    await waitFor(() => {
      expect(screen.getByText('共享设置')).toBeTruthy();
    });

    expect(screen.queryByRole('button', { name: '取消共享' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /关.*闭/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '共享设置' })).toBeNull();
    });

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

    await act(async () => {
      window.dispatchEvent(new Event('personalDocumentsChanged'));
    });

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
    expect(setDocumentMode).toHaveBeenCalledWith('personal');
    expect(setDocumentAccessRole).toHaveBeenCalledWith('owner');
    expect(setCurrentTeamScopedShare).toHaveBeenCalledWith(false);
  });

  it('首次载入抛出 KEY_NOT_READY 时会初始化密钥并自动重试', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      },
    ]);

    const loadMock = documentService.loadPersonalDocument as unknown as MockFn;
    const keyNotReadyError = Object.assign(new Error('key not ready'), { code: 'KEY_NOT_READY' });
    loadMock
      .mockRejectedValueOnce(keyNotReadyError)
      .mockResolvedValueOnce({
        file: new File(['test'], 'loaded.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        version: 'V1.0.3',
        remark: '最新备注',
        selectedKeys: ['k1', 'k2'],
      });

    const ensureMock = vi.mocked(cryptoKeyService.ensureUserKeyPair);
    ensureMock.mockResolvedValue(undefined);
    const restoreMock = vi.mocked(cryptoKeyService.restoreUserPrivateKey);
    restoreMock.mockResolvedValueOnce(null);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /载.*入/ }));

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledTimes(1);
      expect(loadMock).toHaveBeenCalledTimes(2);
    });

    expect(setFile).toHaveBeenCalledTimes(1);
    expect(setCurrentDocumentId).toHaveBeenCalledWith('doc-1');
    expect(setCurrentDocumentVersion).toHaveBeenCalledWith('V1.0.3');
    expect(setInitialCheckedKeys).toHaveBeenCalledWith(['k1', 'k2']);
  });

  it('首次载入非 KEY_NOT_READY 错误时也会先尝试 key-restore 后再重试一次', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      },
    ]);

    const loadMock = documentService.loadPersonalDocument as unknown as MockFn;
    loadMock
      .mockRejectedValueOnce(new Error('R2 download failed'))
      .mockResolvedValueOnce({
        file: new File(['test'], 'loaded.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        version: 'V1.0.3',
        remark: '最新备注',
        selectedKeys: ['k1', 'k2'],
      });

    const ensureMock = vi.mocked(cryptoKeyService.ensureUserKeyPair);
    ensureMock.mockResolvedValue(undefined);
    const restoreMock = vi.mocked(cryptoKeyService.restoreUserPrivateKey);
    restoreMock.mockResolvedValueOnce(null);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /载.*入/ }));

    await waitFor(() => {
      expect(restoreMock).toHaveBeenCalledTimes(1);
      expect(loadMock).toHaveBeenCalledTimes(2);
    });

    expect(setFile).toHaveBeenCalledTimes(1);
    expect(setCurrentDocumentId).toHaveBeenCalledWith('doc-1');
    expect(setCurrentDocumentVersion).toHaveBeenCalledWith('V1.0.3');
    expect(setInitialCheckedKeys).toHaveBeenCalledWith(['k1', 'k2']);
  });

  it('重试后仍失败时提示具体错误并打印异常栈', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '测试文档',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-02T00:00:00Z',
      },
    ]);

    const loadMock = documentService.loadPersonalDocument as unknown as MockFn;
    loadMock
      .mockRejectedValueOnce(new Error('R2 download failed: 403 Forbidden'))
      .mockRejectedValueOnce(new Error('R2 download failed: 403 Forbidden'));

    const ensureMock = vi.mocked(cryptoKeyService.ensureUserKeyPair);
    ensureMock.mockResolvedValue(undefined);
    const restoreMock = vi.mocked(cryptoKeyService.restoreUserPrivateKey);
    restoreMock.mockResolvedValueOnce(null);

    const messageErrorSpy = vi.spyOn(message, 'error').mockImplementation(() => {
      return undefined as MessageErrorReturn;
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      return undefined;
    });

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('测试文档')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /载.*入/ }));

    await waitFor(() => {
      expect(loadMock).toHaveBeenCalledTimes(2);
      expect(restoreMock).toHaveBeenCalledTimes(1);
    });

    expect(messageErrorSpy).toHaveBeenCalledWith('载入文档失败：R2 download failed: 403 Forbidden');
    expect(consoleErrorSpy).toHaveBeenCalled();

    messageErrorSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('按当前团队共享状态显示“共享/取消共享”按钮文案', async () => {
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '文档A',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
      {
        id: 'doc-2',
        name: '文档B',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ]);

    vi.mocked(documentService.isDocumentSharedInTeam)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('文档A')).toBeTruthy();
      expect(screen.getByText('文档B')).toBeTruthy();
    });

    expect(screen.getAllByRole('button', { name: /取消共享/ }).length).toBe(1);
    expect(screen.getAllByRole('button', { name: /共 享/ }).length).toBe(1);
  });

  it('共享弹窗左侧勾选成员组/成员后，右侧按层级只读展示且无复选框', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '文档A',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ]);

    vi.mocked(teamService.fetchTeamGroups).mockResolvedValue([
      { id: 'group-a', name: '研发组' },
    ]);
    vi.mocked(teamService.fetchTeamMembers).mockResolvedValue([
      { id: 'm1', userId: 'user-a', name: '张三', email: 'a@test.com', role: 'reader', groupId: 'group-a', groupName: '研发组' },
      { id: 'm2', userId: 'user-b', name: '李四', email: 'b@test.com', role: 'editor', groupId: 'group-a', groupName: '研发组' },
      { id: 'm3', userId: 'user-c', name: '王五', email: 'c@test.com', role: 'reader', groupId: null, groupName: null },
    ]);

    vi.mocked(documentService.isDocumentSharedInTeam).mockResolvedValue(false);

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('文档A')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /共.*享/ }));

    await waitFor(() => {
      expect(screen.getByText('共享设置')).toBeTruthy();
      expect(screen.getByText('研发组')).toBeTruthy();
      expect(screen.getByText('王五')).toBeTruthy();
    });

    const groupCheckbox = screen.getByRole('checkbox', { name: '研发组' });
    await user.click(groupCheckbox);

    const selectedPanel = screen.getByText('已选目标').closest('div') as HTMLElement;

    await waitFor(() => {
      expect(within(selectedPanel).getByText('研发组')).toBeTruthy();
      expect(within(selectedPanel).getByText('张三')).toBeTruthy();
      expect(within(selectedPanel).getByText('李四')).toBeTruthy();
    });

    expect(selectedPanel.querySelectorAll('input[type="checkbox"]').length).toBe(0);
  });



  it('确认共享时会排除当前用户本人，避免把 owner 自己作为共享目标再次提交', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '文档A',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ]);

    vi.mocked(teamService.fetchTeamGroups).mockResolvedValue([
      { id: 'group-a', name: '研发组' },
    ]);
    vi.mocked(teamService.fetchTeamMembers).mockResolvedValue([
      { id: 'm-owner', userId: 'user-1', name: '我自己', email: 'tester@example.com', role: 'admin', groupId: 'group-a', groupName: '研发组' },
      { id: 'm2', userId: 'user-b', name: '李四', email: 'b@test.com', role: 'editor', groupId: 'group-a', groupName: '研发组' },
    ]);
    vi.mocked(documentService.isDocumentSharedInTeam).mockResolvedValue(false);
    vi.mocked(documentService.shareDocument).mockResolvedValue({
      distributed: ['user-b'],
      failed: [],
    });

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('文档A')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /共.*享/ }));
    await user.click(await screen.findByRole('checkbox', { name: '研发组' }));
    await user.click(screen.getByRole('button', { name: '确认共享' }));

    await waitFor(() => {
      expect(documentService.shareDocument).toHaveBeenCalledWith({
        documentId: 'doc-1',
        ownerUserId: 'user-1',
        targetUserIds: ['user-b'],
        teamId: 'team-1',
      });
    });
  });

  it('共享成功后会同时刷新个人文档和共享文档页签', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '文档A',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ]);

    vi.mocked(teamService.fetchTeamGroups).mockResolvedValue([
      { id: 'group-a', name: '研发组' },
    ]);
    vi.mocked(teamService.fetchTeamMembers).mockResolvedValue([
      { id: 'm2', userId: 'user-b', name: '李四', email: 'b@test.com', role: 'editor', groupId: 'group-a', groupName: '研发组' },
    ]);
    vi.mocked(documentService.isDocumentSharedInTeam).mockResolvedValue(false);
    vi.mocked(documentService.shareDocument).mockResolvedValue({
      distributed: ['user-b'],
      failed: [],
    });

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('文档A')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: /共.*享/ }));
    await user.click(await screen.findByRole('checkbox', { name: '研发组' }));
    await user.click(screen.getByRole('button', { name: '确认共享' }));

    await waitFor(() => {
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'personalDocumentsChanged' }));
      expect(dispatchSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'sharedDocumentsChanged' }));
    });

    dispatchSpy.mockRestore();
  });

  it('点击取消共享后会排除当前用户本人，仅撤销其他团队成员并传入 teamId', async () => {
    const user = userEvent.setup();
    const loader = vi.fn().mockResolvedValue([
      {
        id: 'doc-1',
        name: '文档A',
        size: 1024,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
    ]);

    vi.mocked(documentService.isDocumentSharedInTeam).mockResolvedValue(true);
    vi.mocked(documentService.unshareDocument).mockResolvedValue(undefined);
    vi.mocked(teamService.fetchTeamMembers).mockResolvedValue([
      { id: 'm-owner', userId: 'user-1', name: '我自己', email: 'tester@example.com', role: 'admin', groupId: null, groupName: null },
      { id: 'm2', userId: 'user-a', name: '张三', email: 'a@test.com', role: 'reader', groupId: null, groupName: null },
      { id: 'm3', userId: 'user-b', name: '李四', email: 'b@test.com', role: 'editor', groupId: null, groupName: null },
      { id: 'm4', userId: null, name: '访客', email: 'guest@test.com', role: 'reader', groupId: null, groupName: null },
    ]);

    const confirmSpy = vi.spyOn(Modal, 'confirm').mockImplementation(({ onOk }) => {
      void onOk?.();
      return {
        destroy: vi.fn(),
        update: vi.fn(),
      } as ModalConfirmReturn;
    });

    render(<PersonalDocumentList open loader={loader} />);

    await waitFor(() => {
      expect(screen.getByText('文档A')).toBeTruthy();
    });

    await user.click(screen.getByRole('button', { name: '取消共享' }));

    await waitFor(() => {
      expect(documentService.unshareDocument).toHaveBeenCalledWith('doc-1', ['user-a', 'user-b'], 'team-1');
    });

    confirmSpy.mockRestore();
  });
});

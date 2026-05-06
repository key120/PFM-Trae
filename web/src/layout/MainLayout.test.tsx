import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MainLayout from './MainLayout';

const mockSignOut = vi.fn();
const mockCreateTeam = vi.fn();
const mockFetchUserTeams = vi.fn();
const mockFetchInvitationNotifications = vi.fn();
const mockAcceptTeamInvitation = vi.fn();
const mockRejectTeamInvitation = vi.fn();
const mockTeamInfoModal = vi.fn();
const mockStorageGetItem = vi.fn();
const mockStorageSetItem = vi.fn();
const mockAddTeam = vi.fn();
const mockTeamState = {
  teams: [] as Array<{ id: string; name: string }>,
  currentTeamId: null as string | null,
  setCurrentTeamId: vi.fn(),
  setTeams: vi.fn(),
  addTeam: mockAddTeam,
};

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => ({
    user: { id: 'user-1', email: 'tester@example.com' },
    signOut: mockSignOut,
  }),
}));

vi.mock('../store/useTeamStore', () => ({
  useTeamStore: () => mockTeamState,
}));

vi.mock('../services/teamService', () => ({
  createTeam: (...args: unknown[]) => mockCreateTeam(...args),
  fetchUserTeams: (...args: unknown[]) => mockFetchUserTeams(...args),
  fetchInvitationNotifications: (...args: unknown[]) => mockFetchInvitationNotifications(...args),
  acceptTeamInvitation: (...args: unknown[]) => mockAcceptTeamInvitation(...args),
  rejectTeamInvitation: (...args: unknown[]) => mockRejectTeamInvitation(...args),
}));

vi.mock('../components/TeamInfoModal', () => ({
  default: (props: { open: boolean; teamId: string | null; onClose: () => void }) => {
    mockTeamInfoModal(props);
    return props.open ? <div>团队信息弹窗</div> : null;
  },
}));

const renderMainLayout = () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<MainLayout />}>
          <Route index element={<div />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
};

const resetMainLayoutMocks = () => {
  mockSignOut.mockReset();
  mockCreateTeam.mockReset();
  mockFetchUserTeams.mockReset();
  mockFetchInvitationNotifications.mockReset();
  mockAcceptTeamInvitation.mockReset();
  mockRejectTeamInvitation.mockReset();
  mockTeamInfoModal.mockReset();
  mockStorageGetItem.mockReset();
  mockStorageSetItem.mockReset();
  mockAddTeam.mockReset();
  mockTeamState.teams = [];
  mockTeamState.currentTeamId = null;
  mockTeamState.setCurrentTeamId = vi.fn();
  mockTeamState.setTeams = vi.fn();
  mockTeamState.addTeam = mockAddTeam;
  mockFetchUserTeams.mockResolvedValue([]);
  mockFetchInvitationNotifications.mockResolvedValue([]);
};

describe('MainLayout 文档列表 Drawer', () => {
  beforeEach(() => {
    resetMainLayoutMocks();
  });

  it('打开后展示个人/共享两个 Tabs，并默认加载个人文档列表', async () => {
    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByRole('button', { name: /文档列表/ }));

    expect(await screen.findByRole('tab', { name: '个人文档' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '共享文档' })).toBeTruthy();
  });

  it('切换到共享 Tabs 后显示共享占位', async () => {
    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByRole('button', { name: /文档列表/ }));
    await user.click(await screen.findByRole('tab', { name: '共享文档' }));

    expect(await screen.findByText('共享文档功能开发中')).toBeTruthy();
  });
});

describe('MainLayout 通知中心', () => {
  beforeEach(() => {
    resetMainLayoutMocks();
  });

  it('Bell 按钮显示未读红点并可打开通知抽屉', async () => {
    const user = userEvent.setup();
    mockFetchInvitationNotifications.mockResolvedValue([
      {
        type: 'team_invitation',
        notificationId: 'notice-1',
        invitationId: 'invite-1',
        teamId: 'team-2',
        teamName: '团队 B',
        role: 'editor',
        invitedBy: 'owner@example.com',
        inviteeEmail: 'tester@example.com',
        createdAt: '2026-04-23T10:00:00.000Z',
        status: 'pending',
        isRead: false,
      },
    ]);

    renderMainLayout();

    await waitFor(() => {
      expect(mockFetchInvitationNotifications).toHaveBeenCalledWith('user-1', 'tester@example.com');
    });

    const bell = await screen.findByText('消息通知');
    await user.click(bell);

    expect(await screen.findByRole('dialog', { name: '消息通知' })).toBeTruthy();
    expect(await screen.findByText('你被 owner@example.com 邀请加入 团队 B')).toBeTruthy();
    expect(document.querySelector('.ant-badge-dot')).toBeTruthy();
  });

  it('已接受邀请保留原通知并显示已接受状态', async () => {
    const user = userEvent.setup();
    mockFetchInvitationNotifications.mockResolvedValue([
      {
        type: 'team_invitation',
        notificationId: 'notice-1',
        invitationId: 'invite-1',
        teamId: 'team-2',
        teamName: '团队 B',
        role: 'editor',
        invitedBy: 'owner@example.com',
        inviteeEmail: 'tester@example.com',
        createdAt: '2026-04-23T10:00:00.000Z',
        status: 'accepted',
        isRead: true,
      },
    ]);

    renderMainLayout();

    await user.click(await screen.findByText('消息通知'));

    expect(await screen.findByText('你被 owner@example.com 邀请加入 团队 B')).toBeTruthy();
    expect(screen.getByText('已接受')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*受/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /拒\s*绝/ })).toBeNull();
  });

  it('结果通知只显示纯结果文案', async () => {
    const user = userEvent.setup();
    mockFetchInvitationNotifications.mockResolvedValue([
      {
        type: 'team_invitation_result',
        notificationId: 'notice-2',
        inviteeEmail: 'yaobowen120@126.com',
        result: 'rejected',
        createdAt: '2026-04-23T12:00:00.000Z',
        isRead: false,
      },
    ]);

    renderMainLayout();

    await user.click(await screen.findByText('消息通知'));

    expect(await screen.findByText('yaobowen120@126.com 已拒绝邀请')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /接\s*受/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /拒\s*绝/ })).toBeNull();
  });

  it('接受邀请后本地保留通知并显示已接受', async () => {
    const user = userEvent.setup();
    mockFetchInvitationNotifications.mockResolvedValue([
      {
        type: 'team_invitation',
        notificationId: 'notice-1',
        invitationId: 'invite-1',
        teamId: 'team-2',
        teamName: '团队 B',
        role: 'editor',
        invitedBy: 'owner@example.com',
        inviteeEmail: 'tester@example.com',
        createdAt: '2026-04-23T10:00:00.000Z',
        status: 'pending',
        isRead: false,
      },
    ]);
    mockFetchUserTeams
      .mockResolvedValueOnce([{ id: 'team-1', name: '团队 A' }])
      .mockResolvedValueOnce([
        { id: 'team-1', name: '团队 A' },
        { id: 'team-2', name: '团队 B' },
      ]);

    renderMainLayout();

    await user.click(await screen.findByText('消息通知'));
    await user.click(await screen.findByRole('button', { name: /接\s*受/ }));

    await waitFor(() => {
      expect(mockAcceptTeamInvitation).toHaveBeenCalledWith({ invitationId: 'invite-1' });
    });
    expect(await screen.findByText('已接受')).toBeTruthy();
    expect(screen.getByText('你被 owner@example.com 邀请加入 团队 B')).toBeTruthy();
  });

  it('拒绝邀请后本地保留通知并显示已拒绝', async () => {
    const user = userEvent.setup();
    mockFetchInvitationNotifications.mockResolvedValue([
      {
        type: 'team_invitation',
        notificationId: 'notice-1',
        invitationId: 'invite-1',
        teamId: 'team-2',
        teamName: '团队 B',
        role: 'editor',
        invitedBy: 'owner@example.com',
        inviteeEmail: 'tester@example.com',
        createdAt: '2026-04-23T10:00:00.000Z',
        status: 'pending',
        isRead: false,
      },
    ]);

    renderMainLayout();

    await user.click(await screen.findByText('消息通知'));
    await user.click(await screen.findByRole('button', { name: /拒\s*绝/ }));

    await waitFor(() => {
      expect(mockRejectTeamInvitation).toHaveBeenCalledWith({ invitationId: 'invite-1' });
    });
    expect(await screen.findByText('已拒绝')).toBeTruthy();
    expect(screen.getByText('你被 owner@example.com 邀请加入 团队 B')).toBeTruthy();
  });

  it('已处理邀请不计入红点，但未读结果通知计入红点', async () => {
    mockFetchInvitationNotifications.mockResolvedValue([
      {
        type: 'team_invitation',
        notificationId: 'notice-1',
        invitationId: 'invite-1',
        teamId: 'team-2',
        teamName: '团队 B',
        role: 'editor',
        invitedBy: 'owner@example.com',
        inviteeEmail: 'tester@example.com',
        createdAt: '2026-04-23T10:00:00.000Z',
        status: 'accepted',
        isRead: true,
      },
      {
        type: 'team_invitation_result',
        notificationId: 'notice-2',
        inviteeEmail: 'yaobowen120@126.com',
        result: 'accepted',
        createdAt: '2026-04-23T12:00:00.000Z',
        isRead: false,
      },
    ]);

    renderMainLayout();

    expect(await screen.findByText('消息通知')).toBeTruthy();
    expect(document.querySelector('.ant-badge-dot')).toBeTruthy();
  });
});

describe('MainLayout 团队菜单', () => {
  beforeEach(() => {
    resetMainLayoutMocks();
  });

  it('初始化后会从后端加载当前用户团队列表', async () => {
    mockFetchUserTeams.mockResolvedValue([{ id: 'team-1', name: '团队 A' }]);

    renderMainLayout();

    await waitFor(() => {
      expect(mockFetchUserTeams).toHaveBeenCalledWith('user-1');
    });

    expect(mockTeamState.setTeams).toHaveBeenCalledWith([{ id: 'team-1', name: '团队 A' }]);
  });

  it('无团队时团队信息和切换团队为禁用状态', async () => {
    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByLabelText('user'));

    expect(await screen.findByText('新建团队')).toBeTruthy();
    const teamInfo = screen.getByText('团队信息').closest('.ant-dropdown-menu-item');
    const switchTeam = screen.getByText('切换团队').closest('.ant-dropdown-menu-submenu');

    expect(teamInfo?.className).toContain('ant-dropdown-menu-item-disabled');
    expect(switchTeam?.className).toContain('ant-dropdown-menu-submenu-disabled');
  });

  it('有团队时点击团队信息会打开弹窗并传入当前团队 id', async () => {
    mockTeamState.teams = [
      { id: 'team-1', name: '团队 A' },
      { id: 'team-2', name: '团队 B' },
    ];
    mockTeamState.currentTeamId = 'team-2';

    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByLabelText('user'));
    await user.click(await screen.findByText('团队信息'));

    expect(await screen.findByText('团队信息弹窗')).toBeTruthy();
    expect(mockTeamInfoModal).toHaveBeenLastCalledWith({
      open: true,
      teamId: 'team-2',
      onClose: expect.any(Function),
    });
  });

  it('有团队时展示切换团队二级菜单，并切换 currentTeamId', async () => {
    mockTeamState.teams = [
      { id: 'team-1', name: '团队 A' },
      { id: 'team-2', name: '团队 B' },
    ];
    mockTeamState.currentTeamId = 'team-2';

    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByLabelText('user'));
    await user.hover(await screen.findByText('切换团队'));

    expect(await screen.findByText('团队 B ✓')).toBeTruthy();

    await user.click(await screen.findByText('团队 A'));

    expect(mockTeamState.setCurrentTeamId).toHaveBeenCalledWith('team-1');
  });

  it('登录后如果存在上次选中的团队，会恢复该团队选择', async () => {
    mockFetchUserTeams.mockResolvedValue([
      { id: 'team-1', name: '团队 A' },
      { id: 'team-2', name: '团队 B' },
    ]);
    mockStorageGetItem.mockReturnValue('team-2');

    const localStorageSpy = vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: mockStorageGetItem,
      setItem: mockStorageSetItem,
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as Storage);

    renderMainLayout();

    await waitFor(() => {
      expect(mockFetchUserTeams).toHaveBeenCalledWith('user-1');
    });

    await waitFor(() => {
      expect(mockTeamState.setCurrentTeamId).toHaveBeenCalledWith('team-2');
    });

    expect(mockStorageGetItem).toHaveBeenCalledWith('pfm-current-team-id:user-1');
    localStorageSpy.mockRestore();
  });

  it('currentTeamId 未变化时不重复写入 localStorage', async () => {
    mockTeamState.currentTeamId = 'team-2';
    mockFetchUserTeams.mockResolvedValue([
      { id: 'team-1', name: '团队 A' },
      { id: 'team-2', name: '团队 B' },
    ]);
    mockStorageGetItem.mockReturnValue('team-2');

    const localStorageSpy = vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: mockStorageGetItem,
      setItem: mockStorageSetItem,
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    } as Storage);

    renderMainLayout();

    await waitFor(() => {
      expect(mockFetchUserTeams).toHaveBeenCalledWith('user-1');
    });

    expect(mockStorageSetItem).not.toHaveBeenCalled();
    localStorageSpy.mockRestore();
  });

  it('点击新建团队后打开弹窗，取消时关闭弹窗', async () => {
    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByLabelText('user'));
    await user.click(await screen.findByText('新建团队'));

    expect(await screen.findByRole('dialog', { name: '新建团队' })).toBeTruthy();
    expect(screen.getByLabelText('团队名称')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: /取.*消/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建团队' })).toBeNull();
    });
  });

  it('团队名称为空时不能提交', async () => {
    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByLabelText('user'));
    await user.click(await screen.findByText('新建团队'));
    await user.click(screen.getByRole('button', { name: /确\s*定/ }));

    expect(await screen.findByText('请输入团队名称')).toBeTruthy();
    expect(mockCreateTeam).not.toHaveBeenCalled();
  });

  it('创建成功后写入团队并自动切换当前团队', async () => {
    mockCreateTeam.mockResolvedValue({ id: 'team-3', name: '新团队' });
    const user = userEvent.setup();

    renderMainLayout();

    await user.click(screen.getByLabelText('user'));
    await user.click(await screen.findByText('新建团队'));
    await user.type(screen.getByLabelText('团队名称'), '新团队');
    await user.click(screen.getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockCreateTeam).toHaveBeenCalledWith({
        userId: 'user-1',
        teamName: '新团队',
      });
    });

    expect(mockAddTeam).toHaveBeenCalledWith({ id: 'team-3', name: '新团队' });
    expect(mockTeamState.setTeams).not.toHaveBeenCalledWith([{ id: 'team-3', name: '新团队' }]);
    expect(mockTeamState.setCurrentTeamId).toHaveBeenCalledWith('team-3');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建团队' })).toBeNull();
    });
  });
});

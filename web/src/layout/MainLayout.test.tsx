import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MainLayout from './MainLayout';

const mockSignOut = vi.fn();
const mockCreateTeam = vi.fn();
const mockTeamInfoModal = vi.fn();
const mockTeamState = {
  teams: [] as Array<{ id: string; name: string }>,
  currentTeamId: null as string | null,
  setCurrentTeamId: vi.fn(),
  setTeams: vi.fn(),
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
}));

vi.mock('../components/TeamInfoModal', () => ({
  default: (props: { open: boolean; teamId: string | null; onClose: () => void }) => {
    mockTeamInfoModal(props);
    return props.open ? <div>团队信息弹窗</div> : null;
  },
}));

describe('MainLayout 文档列表 Drawer', () => {
  beforeEach(() => {
    mockSignOut.mockReset();
    mockCreateTeam.mockReset();
    mockTeamInfoModal.mockReset();
    mockTeamState.teams = [];
    mockTeamState.currentTeamId = null;
    mockTeamState.setCurrentTeamId = vi.fn();
    mockTeamState.setTeams = vi.fn();
  });

  it('打开后展示个人/共享两个 Tabs，并默认加载个人文档列表', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /文档列表/ }));

    expect(await screen.findByRole('tab', { name: '个人文档' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '共享文档' })).toBeTruthy();
  });

  it('切换到共享 Tabs 后显示共享占位', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /文档列表/ }));
    await user.click(await screen.findByRole('tab', { name: '共享文档' }));

    expect(await screen.findByText('共享文档功能开发中')).toBeTruthy();
  });
});

describe('MainLayout 团队菜单', () => {
  beforeEach(() => {
    mockSignOut.mockReset();
    mockCreateTeam.mockReset();
    mockTeamInfoModal.mockReset();
    mockTeamState.teams = [];
    mockTeamState.currentTeamId = null;
    mockTeamState.setCurrentTeamId = vi.fn();
    mockTeamState.setTeams = vi.fn();
  });

  it('无团队时团队信息和切换团队为禁用状态', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

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

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

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

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByLabelText('user'));
    await user.hover(await screen.findByText('切换团队'));

    expect(await screen.findByText('团队 B ✓')).toBeTruthy();

    await user.click(await screen.findByText('团队 A'));

    expect(mockTeamState.setCurrentTeamId).toHaveBeenCalledWith('team-1');
  });

  it('点击新建团队后打开弹窗，取消时关闭弹窗', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

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

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByLabelText('user'));
    await user.click(await screen.findByText('新建团队'));
    await user.click(screen.getByRole('button', { name: /确\s*定/ }));

    expect(await screen.findByText('请输入团队名称')).toBeTruthy();
    expect(mockCreateTeam).not.toHaveBeenCalled();
  });

  it('创建成功后写入团队并自动切换当前团队', async () => {
    mockCreateTeam.mockResolvedValue({ id: 'team-3', name: '新团队' });
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<MainLayout />}>
            <Route index element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

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

    expect(mockTeamState.setTeams).toHaveBeenCalledWith([{ id: 'team-3', name: '新团队' }]);
    expect(mockTeamState.setCurrentTeamId).toHaveBeenCalledWith('team-3');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '新建团队' })).toBeNull();
    });
  });
});

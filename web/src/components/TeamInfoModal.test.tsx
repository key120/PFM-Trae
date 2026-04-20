import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamInfoModal from './TeamInfoModal';

const mockGetCurrentUserTeamRole = vi.fn();
const mockFetchTeamGroups = vi.fn();
const mockFetchTeamMembers = vi.fn();
const mockInviteMembers = vi.fn();
const mockUpdateMember = vi.fn();
const mockRemoveMember = vi.fn();
const mockCreateGroup = vi.fn();
const mockUpdateGroup = vi.fn();
const mockDeleteGroup = vi.fn();

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => ({
    user: { id: 'user-1', email: 'tester@example.com' },
  }),
}));

vi.mock('../services/teamService', () => ({
  getCurrentUserTeamRole: (...args: unknown[]) => mockGetCurrentUserTeamRole(...args),
  fetchTeamGroups: (...args: unknown[]) => mockFetchTeamGroups(...args),
  fetchTeamMembers: (...args: unknown[]) => mockFetchTeamMembers(...args),
  inviteMembers: (...args: unknown[]) => mockInviteMembers(...args),
  updateMember: (...args: unknown[]) => mockUpdateMember(...args),
  removeMember: (...args: unknown[]) => mockRemoveMember(...args),
  createGroup: (...args: unknown[]) => mockCreateGroup(...args),
  updateGroup: (...args: unknown[]) => mockUpdateGroup(...args),
  deleteGroup: (...args: unknown[]) => mockDeleteGroup(...args),
}));

function renderModal() {
  return render(<TeamInfoModal open teamId="team-1" onClose={vi.fn()} />);
}

async function findTeamInfoDialog() {
  return screen.findByRole('dialog', { name: '团队信息' });
}

async function findAntdModalByTitle(title: string) {
  const titleNode = await screen.findAllByText(title);
  const modal = titleNode[titleNode.length - 1]?.closest('.ant-modal');
  if (!modal) {
    throw new Error(`Unable to find Ant Design modal for title: ${title}`);
  }
  return modal as HTMLElement;
}

describe('TeamInfoModal', () => {
  beforeEach(() => {
    mockGetCurrentUserTeamRole.mockReset();
    mockFetchTeamGroups.mockReset();
    mockFetchTeamMembers.mockReset();
    mockInviteMembers.mockReset();
    mockUpdateMember.mockReset();
    mockRemoveMember.mockReset();
    mockCreateGroup.mockReset();
    mockUpdateGroup.mockReset();
    mockDeleteGroup.mockReset();

    mockGetCurrentUserTeamRole.mockResolvedValue('admin');
    mockFetchTeamGroups.mockResolvedValue([
      { id: 'group-1', name: '管理组' },
      { id: 'group-2', name: '研发组' },
    ]);
    mockFetchTeamMembers.mockResolvedValue([
      {
        id: 'member-1',
        userId: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'admin',
        groupId: 'group-1',
        groupName: '管理组',
      },
      {
        id: 'member-2',
        userId: null,
        name: '访客',
        email: 'guest@example.com',
        role: 'reader',
        groupId: null,
        groupName: null,
      },
    ]);
    mockInviteMembers.mockResolvedValue({ insertedCount: 2 });
    mockUpdateMember.mockResolvedValue(undefined);
    mockRemoveMember.mockResolvedValue(undefined);
    mockCreateGroup.mockResolvedValue({ id: 'group-3', name: '测试组' });
    mockUpdateGroup.mockResolvedValue(undefined);
    mockDeleteGroup.mockResolvedValue(undefined);
  });

  it('邮箱为空时不能提交邀请', async () => {
    const user = userEvent.setup();
    renderModal();

    const dialog = await findTeamInfoDialog();
    expect(within(dialog).getByRole('heading', { name: '通过邮箱邀请' })).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: /确\s*定/ }));

    expect(await within(dialog).findByText('请输入邮箱')).toBeTruthy();
    expect(mockInviteMembers).not.toHaveBeenCalled();
  });

  it('支持多行邀请并提交给 inviteMembers', async () => {
    const user = userEvent.setup();
    renderModal();

    const dialog = await findTeamInfoDialog();
    expect(within(dialog).getByRole('heading', { name: '通过邮箱邀请' })).toBeTruthy();

    await user.type(within(dialog).getAllByLabelText('邮箱')[0], 'owner@example.com');
    await user.type(within(dialog).getAllByLabelText('姓名')[0], 'Owner');

    await user.click(within(dialog).getByRole('button', { name: '再加一个' }));
    await user.type(within(dialog).getAllByLabelText('邮箱')[1], 'guest@example.com');
    await user.type(within(dialog).getAllByLabelText('姓名')[1], 'Guest');

    await user.click(within(dialog).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockInviteMembers).toHaveBeenCalledWith({
        teamId: 'team-1',
        invitedBy: 'user-1',
        rows: [
          { email: 'owner@example.com', name: 'Owner', groupId: null, role: 'reader' },
          { email: 'guest@example.com', name: 'Guest', groupId: null, role: 'reader' },
        ],
      });
    });
  });

  it('非 admin 不显示邀请入口', async () => {
    mockGetCurrentUserTeamRole.mockResolvedValue('reader');
    renderModal();

    const dialog = await findTeamInfoDialog();
    expect(within(dialog).getByRole('heading', { name: '成员管理' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: '通过邮箱邀请' })).toBeNull();
    expect(within(dialog).getByText('访客')).toBeTruthy();
  });

  it('显示成员列表，admin 可编辑和删除成员', async () => {
    const user = userEvent.setup();
    renderModal();

    const dialog = await findTeamInfoDialog();
    expect(within(dialog).getByRole('heading', { name: '通过邮箱邀请' })).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '未分组' }));
    expect(await within(dialog).findByText('访客')).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '编辑成员 guest@example.com' }));
    const editDialog = await findAntdModalByTitle('编辑成员');
    expect(editDialog).toBeTruthy();

    const memberNameInput = within(editDialog).getByLabelText('姓名');
    await user.clear(memberNameInput);
    await user.type(memberNameInput, 'Guest Updated');
    await user.click(within(editDialog).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockUpdateMember).toHaveBeenCalledWith('member-2', {
        name: 'Guest Updated',
        groupId: null,
        role: 'reader',
      });
    });

    await user.click(within(dialog).getByRole('button', { name: '删除成员 guest@example.com' }));
    const popconfirm = await screen.findByText('确认移除该成员吗？');
    const popconfirmRoot = popconfirm.closest('.ant-popconfirm') ?? document.body;
    await user.click(within(popconfirmRoot as HTMLElement).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockRemoveMember).toHaveBeenCalledWith('member-2');
    });
  });

  it('非 admin 时成员操作按钮为禁用', async () => {
    mockGetCurrentUserTeamRole.mockResolvedValue('reader');
    const user = userEvent.setup();
    renderModal();

    const dialog = await findTeamInfoDialog();
    expect(within(dialog).getByRole('heading', { name: '成员管理' })).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '未分组' }));
    const editButton = await within(dialog).findByRole('button', { name: '编辑成员 guest@example.com' });
    const removeButton = within(dialog).getByRole('button', { name: '删除成员 guest@example.com' });

    expect((editButton as HTMLButtonElement).disabled).toBe(true);
    expect((removeButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('支持成员组新增、编辑和删除', async () => {
    const user = userEvent.setup();
    mockFetchTeamGroups
      .mockResolvedValueOnce([
        { id: 'group-1', name: '管理组' },
        { id: 'group-2', name: '研发组' },
      ])
      .mockResolvedValueOnce([
        { id: 'group-1', name: '管理组' },
        { id: 'group-2', name: '研发组' },
      ])
      .mockResolvedValueOnce([
        { id: 'group-1', name: '管理组' },
        { id: 'group-3', name: '测试组-已更新' },
      ]);

    renderModal();

    const dialog = await findTeamInfoDialog();
    expect(within(dialog).getByRole('heading', { name: '通过邮箱邀请' })).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '新建成员组' }));
    const createDialog = await findAntdModalByTitle('新建成员组');
    expect(createDialog).toBeTruthy();
    await user.type(within(createDialog).getByLabelText('成员组名称'), '测试组');
    await user.click(within(createDialog).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockCreateGroup).toHaveBeenCalledWith({
        teamId: 'team-1',
        createdBy: 'user-1',
        name: '测试组',
      });
    });

    expect(await within(dialog).findByRole('button', { name: '测试组' })).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '编辑成员组 测试组' }));
    const editDialog = await findAntdModalByTitle('编辑成员组');
    expect(editDialog).toBeTruthy();
    const groupNameInput = within(editDialog).getByLabelText('成员组名称');
    await user.clear(groupNameInput);
    await user.type(groupNameInput, '测试组-已更新');
    await user.click(within(editDialog).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockUpdateGroup).toHaveBeenCalledWith('group-3', '测试组-已更新');
    });

    expect(await within(dialog).findByRole('button', { name: '测试组-已更新' })).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: '删除成员组 测试组-已更新' }));
    const popconfirm = await screen.findByText('确认删除该成员组吗？');
    const popconfirmRoot = popconfirm.closest('.ant-popconfirm') ?? document.body;
    await user.click(within(popconfirmRoot as HTMLElement).getByRole('button', { name: /确\s*定/ }));

    await waitFor(() => {
      expect(mockDeleteGroup).toHaveBeenCalledWith('group-3');
    });
  });
});

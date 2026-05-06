import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptTeamInvitation,
  createGroup,
  createTeam,
  deleteGroup,
  fetchInvitationNotifications,
  fetchTeamGroups,
  fetchTeamMembers,
  fetchUserTeams,
  getCurrentUserTeamRole,
  inviteMembers,
  rejectTeamInvitation,
  removeMember,
  updateGroup,
  updateMember,
} from './teamService';
import { supabase } from '../lib/supabase';

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: {
      getUser: vi.fn(),
    },
  },
}));

function mockTables(handlers: Record<string, unknown>) {
  (supabase.from as unknown as MockFn).mockImplementation((table: string) => {
    const handler = handlers[table];
    if (!handler) {
      throw new Error(`Unexpected table: ${table}`);
    }

    return handler;
  });
}

const teamMemberRows = [
  {
    id: 'member-1',
    user_id: 'user-1',
    name: null,
    role: 'admin',
    group_id: 'group-1',
    team_groups: { name: '管理组' },
  },
  {
    id: 'member-2',
    user_id: null,
    name: '访客',
    role: 'reader',
    group_id: null,
    team_groups: null,
  },
];

const teamMemberSummaries = [
  {
    id: 'member-1',
    userId: 'user-1',
    name: '',
    email: 'owner@example.com',
    role: 'admin',
    groupId: 'group-1',
    groupName: '管理组',
  },
  {
    id: 'member-2',
    userId: null,
    name: '访客',
    email: '—',
    role: 'reader',
    groupId: null,
    groupName: null,
  },
];

function createProfilesBuilder(data: Array<{ id: string; email: string | null }>, error: unknown = null) {
  const builder = {
    select: vi.fn(() => builder),
    in: vi.fn().mockResolvedValue({ data, error }),
  };

  return builder;
}

function createNotificationsBuilder(data: unknown[], error: unknown = null) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn().mockImplementationOnce(() => builder).mockImplementationOnce(() => builder),
    order: vi.fn().mockResolvedValue({ data, error }),
  };

  return builder;
}

function createTeamMembersQueryBuilder(data: unknown[], error: unknown = null) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn()
      .mockImplementationOnce(() => builder)
      .mockResolvedValueOnce({ data, error }),
  };

  return builder;
}

function createExistingMembersBuilder(data: unknown[], error: unknown = null) {
  const builder: { select: MockFn; eq: MockFn; in: MockFn } = {
    select: vi.fn(),
    eq: vi.fn(),
    in: vi.fn().mockResolvedValue({ data, error }),
  };
  builder.select.mockImplementation(() => builder);
  builder.eq
    .mockImplementationOnce(() => builder)
    .mockImplementationOnce(() => builder);

  return builder;
}

describe('teamService', () => {
  beforeEach(() => {
    (supabase.from as unknown as MockFn).mockReset();
    (supabase.rpc as unknown as MockFn).mockReset();
    (supabase.auth.getUser as unknown as MockFn).mockReset();
  });

  describe('createTeam', () => {
    it('团队名为空时抛出明确错误', async () => {
      await expect(createTeam({ userId: 'user-1', teamName: '   ' })).rejects.toThrow('请输入团队名称');
    });

    it('RPC 失败时抛出明确错误', async () => {
      (supabase.rpc as unknown as MockFn).mockResolvedValue({
        data: null,
        error: { message: 'Database error creating new user' },
      });

      await expect(createTeam({ userId: 'user-1', teamName: '新团队' })).rejects.toThrow('创建团队失败：Database error creating new user');
      expect(supabase.rpc).toHaveBeenCalledWith('create_team_with_owner', { p_name: '新团队' });
    });

    it('创建成功时调用 rpc 并返回团队摘要', async () => {
      (supabase.rpc as unknown as MockFn).mockResolvedValue({
        data: { id: 'team-1', name: '新团队' },
        error: null,
      });

      await expect(createTeam({ userId: 'user-1', teamName: ' 新团队 ' })).resolves.toEqual({
        id: 'team-1',
        name: '新团队',
      });

      expect(supabase.rpc).toHaveBeenCalledWith('create_team_with_owner', { p_name: '新团队' });
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('RPC 函数不存在时使用当前登录用户降级写 teams 和 team_members', async () => {
      (supabase.rpc as unknown as MockFn).mockResolvedValue({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.create_team_with_owner(p_name) in the schema cache',
        },
      });
      (supabase.auth.getUser as unknown as MockFn).mockResolvedValue({
        data: { user: { id: 'current-user-1' } },
        error: null,
      });

      const teamsInsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'team-fallback-1', name: '新团队' },
            error: null,
          }),
        }),
      });
      const teamMembersInsert = vi.fn().mockResolvedValue({ error: null });

      mockTables({
        teams: { insert: teamsInsert },
        team_members: { insert: teamMembersInsert },
      });

      await expect(createTeam({ userId: 'spoofed-user', teamName: ' 新团队 ' })).resolves.toEqual({
        id: 'team-fallback-1',
        name: '新团队',
      });

      expect(teamsInsert).toHaveBeenCalledWith({
        name: '新团队',
        created_by: 'current-user-1',
      });
      expect(teamMembersInsert).toHaveBeenCalledWith({
        team_id: 'team-fallback-1',
        user_id: 'current-user-1',
        role: 'admin',
        status: 'active',
        joined_at: expect.any(String),
      });
    });

    it('降级路径在成员写入失败时会回滚已创建的团队', async () => {
      (supabase.rpc as unknown as MockFn).mockResolvedValue({
        data: null,
        error: {
          code: 'PGRST202',
          message: 'Could not find the function public.create_team_with_owner(p_name) in the schema cache',
        },
      });
      (supabase.auth.getUser as unknown as MockFn).mockResolvedValue({
        data: { user: { id: 'current-user-1' } },
        error: null,
      });

      const deleteEq = vi.fn().mockResolvedValue({ error: null });
      const teamsInsert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'team-fallback-1', name: '新团队' },
            error: null,
          }),
        }),
      });
      const teamsDelete = vi.fn().mockReturnValue({ eq: deleteEq });
      const teamMembersInsert = vi.fn().mockResolvedValue({ error: { message: 'insert member failed' } });

      mockTables({
        teams: { insert: teamsInsert, delete: teamsDelete },
        team_members: { insert: teamMembersInsert },
      });

      await expect(createTeam({ userId: 'user-1', teamName: ' 新团队 ' })).rejects.toThrow('创建团队失败：insert member failed');
      expect(teamsDelete).toHaveBeenCalledTimes(1);
      expect(deleteEq).toHaveBeenCalledWith('id', 'team-fallback-1');
    });
  });

  describe('fetchUserTeams', () => {
    it('返回当前用户的 active 团队列表', async () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn()
          .mockImplementationOnce(() => builder)
          .mockImplementationOnce(() => Promise.resolve({
            data: [
              { team_id: 'team-1', teams: { id: 'team-1', name: '团队 A' } },
              { team_id: 'team-2', teams: [{ id: 'team-2', name: '团队 B' }] },
            ],
            error: null,
          })),
      };

      mockTables({
        team_members: builder,
      });

      await expect(fetchUserTeams('user-1')).resolves.toEqual([
        { id: 'team-1', name: '团队 A' },
        { id: 'team-2', name: '团队 B' },
      ]);
      expect(builder.select).toHaveBeenCalledWith('team_id, teams!inner(id, name)');
      expect(builder.eq).toHaveBeenNthCalledWith(1, 'user_id', 'user-1');
      expect(builder.eq).toHaveBeenNthCalledWith(2, 'status', 'active');
    });

    it('查询失败时抛出中文错误', async () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn()
          .mockImplementationOnce(() => builder)
          .mockImplementationOnce(() => Promise.resolve({
            data: null,
            error: { message: 'permission denied' },
          })),
      };

      mockTables({
        team_members: builder,
      });

      await expect(fetchUserTeams('user-1')).rejects.toThrow('获取团队列表失败：permission denied');
    });
  });

  describe('getCurrentUserTeamRole', () => {
    it('返回当前用户在团队中的角色', async () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({
          data: { role: 'editor' },
          error: null,
        }),
      };

      mockTables({
        team_members: builder,
      });

      await expect(getCurrentUserTeamRole('team-1', 'user-1')).resolves.toBe('editor');
      expect(builder.select).toHaveBeenCalledWith('role');
      expect(builder.eq).toHaveBeenNthCalledWith(1, 'team_id', 'team-1');
      expect(builder.eq).toHaveBeenNthCalledWith(2, 'user_id', 'user-1');
      expect(builder.eq).toHaveBeenNthCalledWith(3, 'status', 'active');
    });

    it('查询失败时返回 null', async () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        maybeSingle: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'boom' },
        }),
      };

      mockTables({
        team_members: builder,
      });

      await expect(getCurrentUserTeamRole('team-1', 'user-1')).resolves.toBeNull();
    });
  });

  describe('fetchTeamGroups', () => {
    it('按创建时间升序返回成员组摘要', async () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 'group-1', name: '管理组' },
            { id: 'group-2', name: '研发组' },
          ],
          error: null,
        }),
      };

      mockTables({
        team_groups: builder,
      });

      await expect(fetchTeamGroups('team-1')).resolves.toEqual([
        { id: 'group-1', name: '管理组' },
        { id: 'group-2', name: '研发组' },
      ]);
      expect(builder.order).toHaveBeenCalledWith('created_at', { ascending: true });
    });

    it('查询失败时抛出中文错误', async () => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'db down' },
        }),
      };

      mockTables({
        team_groups: builder,
      });

      await expect(fetchTeamGroups('team-1')).rejects.toThrow('获取成员组失败：db down');
    });
  });

  describe('inviteMembers', () => {
    it('同一批邀请中归一化邮箱重复时立即报错', async () => {
      await expect(
        inviteMembers({
          teamId: 'team-1',
          invitedBy: 'admin-1',
          rows: [
            { email: ' A@Example.COM ', name: 'Alice', groupId: 'group-1', role: 'editor' },
            { email: 'a@example.com', name: 'Alice 2', groupId: null, role: 'reader' },
          ],
        }),
      ).rejects.toThrow('同一批邀请中存在重复邮箱');

      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('归一化邮箱后创建邀请', async () => {
      const profilesBuilder = createProfilesBuilder([{ id: 'user-1', email: 'A@Example.COM' }]);
      const teamMembersBuilder = createExistingMembersBuilder([]);
      const insertInvitations = vi.fn().mockResolvedValue({ error: null });

      mockTables({
        profiles: profilesBuilder,
        team_members: teamMembersBuilder,
        team_invitations: { insert: insertInvitations },
      });

      await expect(
        inviteMembers({
          teamId: 'team-1',
          invitedBy: 'admin-1',
          rows: [
            { email: '  A@Example.COM ', name: 'Alice', groupId: 'group-1', role: 'editor' },
            { email: ' Guest@Example.com ', name: 'Guest', groupId: null, role: 'reader' },
          ],
        }),
      ).resolves.toEqual({ insertedCount: 2 });

      expect(profilesBuilder.in).toHaveBeenCalledWith('email', ['a@example.com', 'guest@example.com']);
      expect(teamMembersBuilder.eq).toHaveBeenNthCalledWith(1, 'team_id', 'team-1');
      expect(teamMembersBuilder.eq).toHaveBeenNthCalledWith(2, 'status', 'active');
      expect(teamMembersBuilder.in).toHaveBeenCalledWith('user_id', ['user-1']);
      expect(insertInvitations).toHaveBeenCalledWith([
        {
          team_id: 'team-1',
          invitee_email: 'a@example.com',
          invitee_user_id: 'user-1',
          role: 'editor',
          group_id: 'group-1',
          invited_by: 'admin-1',
          status: 'pending',
        },
        {
          team_id: 'team-1',
          invitee_email: 'guest@example.com',
          invitee_user_id: null,
          role: 'reader',
          group_id: null,
          invited_by: 'admin-1',
          status: 'pending',
        },
      ]);
    });

    it('发现已存在的团队成员时抛出明确错误', async () => {
      const profilesBuilder = createProfilesBuilder([{ id: 'user-1', email: 'member@example.com' }]);
      const teamMembersBuilder = createExistingMembersBuilder([{ user_id: 'user-1' }]);
      const insertInvitations = vi.fn();

      mockTables({
        profiles: profilesBuilder,
        team_members: teamMembersBuilder,
        team_invitations: { insert: insertInvitations },
      });

      await expect(
        inviteMembers({
          teamId: 'team-1',
          invitedBy: 'admin-1',
          rows: [{ email: 'member@example.com', name: '已有成员', groupId: null, role: 'reader' }],
        }),
      ).rejects.toThrow('该用户已是团队成员');

      expect(insertInvitations).not.toHaveBeenCalled();
    });
  });

  describe('fetchTeamMembers', () => {
    it('通过单独查询 profiles 补全成员邮箱，避免依赖联表关系', async () => {
      const teamMembersBuilder = createTeamMembersQueryBuilder(teamMemberRows);
      const profilesBuilder = createProfilesBuilder([{ id: 'user-1', email: 'owner@example.com' }]);

      mockTables({
        team_members: teamMembersBuilder,
        profiles: profilesBuilder,
      });

      await expect(fetchTeamMembers('team-1')).resolves.toEqual(teamMemberSummaries);

      expect(teamMembersBuilder.select).toHaveBeenCalledWith('id, user_id, name, role, group_id, team_groups(name)');
      expect(profilesBuilder.in).toHaveBeenCalledWith('id', ['user-1']);
    });

    it('返回激活成员列表并补齐默认值', async () => {
      const teamMembersBuilder = createTeamMembersQueryBuilder(teamMemberRows);
      const profilesBuilder = createProfilesBuilder([{ id: 'user-1', email: 'owner@example.com' }]);

      mockTables({
        team_members: teamMembersBuilder,
        profiles: profilesBuilder,
      });

      await expect(fetchTeamMembers('team-1')).resolves.toEqual(teamMemberSummaries);
      expect(teamMembersBuilder.select).toHaveBeenCalledWith('id, user_id, name, role, group_id, team_groups(name)');
      expect(teamMembersBuilder.eq).toHaveBeenNthCalledWith(1, 'team_id', 'team-1');
      expect(teamMembersBuilder.eq).toHaveBeenNthCalledWith(2, 'status', 'active');
      expect(profilesBuilder.in).toHaveBeenCalledWith('id', ['user-1']);
    });
  });

  describe('updateMember', () => {
    it('更新成员时会 trim 名称并写入角色和分组', async () => {
      const eq = vi.fn().mockResolvedValue({ error: null });
      const update = vi.fn().mockReturnValue({ eq });

      mockTables({
        team_members: { update },
      });

      await expect(
        updateMember('member-1', { name: ' Alice ', role: 'editor', groupId: 'group-1' }),
      ).resolves.toBeUndefined();

      expect(update).toHaveBeenCalledWith({
        name: 'Alice',
        role: 'editor',
        group_id: 'group-1',
      });
      expect(eq).toHaveBeenCalledWith('id', 'member-1');
    });
  });

  describe('removeMember', () => {
    it('移除成员时将状态标记为 removed', async () => {
      const eq = vi.fn().mockResolvedValue({ error: null });
      const update = vi.fn().mockReturnValue({ eq });

      mockTables({
        team_members: { update },
      });

      await expect(removeMember('member-1')).resolves.toBeUndefined();
      expect(update).toHaveBeenCalledWith({ status: 'removed' });
      expect(eq).toHaveBeenCalledWith('id', 'member-1');
    });
  });

  describe('createGroup', () => {
    it('组名为空时抛出明确错误', async () => {
      await expect(createGroup({ teamId: 'team-1', createdBy: 'user-1', name: '   ' })).rejects.toThrow('请输入成员组名称');
    });

    it('创建成功时返回裁剪后的成员组摘要', async () => {
      const insert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: { id: 'group-1', name: '研发组' },
            error: null,
          }),
        }),
      });

      mockTables({
        team_groups: { insert },
      });

      await expect(createGroup({ teamId: 'team-1', createdBy: 'user-1', name: ' 研发组 ' })).resolves.toEqual({
        id: 'group-1',
        name: '研发组',
      });
      expect(insert).toHaveBeenCalledWith({
        team_id: 'team-1',
        created_by: 'user-1',
        name: '研发组',
      });
    });
  });

  describe('updateGroup', () => {
    it('组名为空时抛出明确错误', async () => {
      await expect(updateGroup('group-1', '   ')).rejects.toThrow('请输入成员组名称');
    });

    it('更新时会 trim 组名', async () => {
      const eq = vi.fn().mockResolvedValue({ error: null });
      const update = vi.fn().mockReturnValue({ eq });

      mockTables({
        team_groups: { update },
      });

      await expect(updateGroup('group-1', ' 研发组 ')).resolves.toBeUndefined();
      expect(update).toHaveBeenCalledWith({ name: '研发组' });
      expect(eq).toHaveBeenCalledWith('id', 'group-1');
    });
  });

  describe('invitationNotifications', () => {
    it('返回已处理邀请通知时保留状态字段并标记为已读', async () => {
      const notificationsBuilder = createNotificationsBuilder([
        {
          id: 'notice-1',
          type: 'team_invitation',
          is_read: true,
          created_at: '2026-04-23T11:00:00.000Z',
          payload: {
            invitationId: 'invite-1',
            teamId: 'team-1',
            teamName: '团队 A',
            role: 'editor',
            invitedBy: 'owner@example.com',
            inviteeEmail: 'user@example.com',
            status: 'accepted',
          },
        },
      ]);

      mockTables({ notifications: notificationsBuilder });

      await expect(fetchInvitationNotifications('user-1', 'user@example.com')).resolves.toEqual([
        {
          type: 'team_invitation',
          notificationId: 'notice-1',
          invitationId: 'invite-1',
          teamId: 'team-1',
          teamName: '团队 A',
          role: 'editor',
          invitedBy: 'owner@example.com',
          inviteeEmail: 'user@example.com',
          createdAt: '2026-04-23T11:00:00.000Z',
          status: 'accepted',
          isRead: true,
        },
      ]);
    });

    it('返回邀请结果通知时映射为 team_invitation_result', async () => {
      const notificationsBuilder = createNotificationsBuilder([
        {
          id: 'notice-2',
          type: 'team_invitation_result',
          is_read: false,
          created_at: '2026-04-23T12:00:00.000Z',
          payload: {
            inviteeEmail: 'yaobowen120@126.com',
            result: 'rejected',
          },
        },
      ]);

      mockTables({ notifications: notificationsBuilder });

      await expect(fetchInvitationNotifications('user-1', 'owner@example.com')).resolves.toEqual([
        {
          type: 'team_invitation_result',
          notificationId: 'notice-2',
          inviteeEmail: 'yaobowen120@126.com',
          result: 'rejected',
          createdAt: '2026-04-23T12:00:00.000Z',
          isRead: false,
        },
      ]);
    });

    it('接受邀请时调用 respond_to_team_invitation rpc', async () => {
      (supabase.rpc as unknown as MockFn).mockResolvedValue({ data: null, error: null });

      await expect(acceptTeamInvitation({ invitationId: 'invite-1' })).resolves.toBeUndefined();

      expect(supabase.rpc).toHaveBeenCalledWith('respond_to_team_invitation', {
        p_invitation_id: 'invite-1',
        p_action: 'accepted',
      });
    });

    it('拒绝邀请时调用 respond_to_team_invitation rpc', async () => {
      (supabase.rpc as unknown as MockFn).mockResolvedValue({ data: null, error: null });

      await expect(rejectTeamInvitation({ invitationId: 'invite-1' })).resolves.toBeUndefined();

      expect(supabase.rpc).toHaveBeenCalledWith('respond_to_team_invitation', {
        p_invitation_id: 'invite-1',
        p_action: 'rejected',
      });
    });

    it('历史通知 payload 中 invitedBy 为 UUID 时会回填邀请人邮箱', async () => {
      const notificationsBuilder = createNotificationsBuilder([
        {
          id: 'notice-legacy-1',
          type: 'team_invitation',
          is_read: false,
          created_at: '2026-04-29T10:00:00.000Z',
          payload: {
            invitationId: 'invite-legacy-1',
            teamId: 'team-1',
            teamName: '团队 A',
            role: 'editor',
            invitedBy: '633771d1-0832-402f-af90-3e9b922a7d87',
            inviteeEmail: 'yaobowen120@126.com',
          },
        },
      ]);

      const profileFromBuilder = createProfilesBuilder([
        { id: '633771d1-0832-402f-af90-3e9b922a7d87', email: 'key120@126.com' },
      ]);

      mockTables({ notifications: notificationsBuilder, profiles: profileFromBuilder });

      await expect(fetchInvitationNotifications('user-1', 'yaobowen120@126.com')).resolves.toEqual([
        {
          type: 'team_invitation',
          notificationId: 'notice-legacy-1',
          invitationId: 'invite-legacy-1',
          teamId: 'team-1',
          teamName: '团队 A',
          role: 'editor',
          invitedBy: 'key120@126.com',
          inviteeEmail: 'yaobowen120@126.com',
          createdAt: '2026-04-29T10:00:00.000Z',
          status: 'pending',
          isRead: false,
        },
      ]);

      expect(profileFromBuilder.select).toHaveBeenCalledWith('id, email');
      expect(profileFromBuilder.in).toHaveBeenCalledWith('id', ['633771d1-0832-402f-af90-3e9b922a7d87']);
    });


  });
});

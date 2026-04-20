# 团队信息弹窗实现计划

> **给代理式执行者：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实现本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**目标：** 构建团队信息弹窗，使管理员可以邀请成员、管理成员和成员组，而非管理员仅能只读查看成员管理界面。

**架构：** 在现有 `MainLayout` 团队菜单基础上扩展出一个 `TeamInfoModal` 组件，由它负责当前团队的角色、成员组、邀请和成员管理状态加载。持久化逻辑继续放在 `teamService.ts`，UI 编排放在弹窗组件中，并沿用仓库现有的 Ant Design + Zustand + `message` / `Modal` 模式。

**技术栈：** React 18、TypeScript、Ant Design、Zustand、Supabase JS、Vitest、Testing Library

---

## 文件结构

### 新建
- `web/src/components/TeamInfoModal.tsx` — 团队信息弹窗 UI，包含左侧导航、邀请面板、成员表格、成员组管理、编辑/创建对话框
- `web/src/components/TeamInfoModal.test.tsx` — 聚焦邀请面板、角色控制、成员管理和成员组操作的测试
- `docs/superpowers/plans/2026-04-07-team-info-modal.md` — 本实现计划

### 修改
- `web/src/layout/MainLayout.tsx` — 将“团队信息”菜单项接通到 `currentTeamId` 对应的弹窗
- `web/src/layout/MainLayout.test.tsx` — 覆盖从头像下拉菜单打开团队信息弹窗的交互
- `web/src/services/teamService.ts` — 增加团队角色、成员组、邀请、成员查询、成员更新、成员移除、成员组 CRUD 的类型化数据访问方法
- `web/src/services/teamService.test.ts` — 增加邀请/成员/成员组相关服务测试
- `开发计划.md` — 在实现并验证后把子任务 4 和子任务 5 标记为完成

### 实现时需要参考的现有文件
- `web/src/layout/MainLayout.tsx` — 当前团队菜单和弹窗写法
- `web/src/services/teamService.ts` — 当前创建团队服务风格
- `web/src/store/useTeamStore.ts` — 当前团队选择状态
- `supabase/migrations/20250321000001_team_tables.sql` — 团队表结构与角色/状态合法值
- `supabase/migrations/20250321000002_shares_notifications.sql` — 通知表以及 insert 策略说明
- `supabase/migrations/20260326184500_fix_team_rls_bootstrap.sql` — 团队 RLS 辅助函数和邀请/成员访问前提
- `docs/superpowers/specs/2026-04-07-team-info-modal-design.md` — 已确认设计规格

---

### 任务 1：扩展团队服务层，增加类型化读写能力

**文件：**
- 修改：`web/src/services/teamService.ts`
- 测试：`web/src/services/teamService.test.ts`

- [ ] **步骤 1：先写失败的服务层测试，覆盖角色查询、邀请写入、成员更新和成员组 CRUD**

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  createGroup,
  createTeam,
  deleteGroup,
  fetchTeamGroups,
  fetchTeamMembers,
  getCurrentUserTeamRole,
  inviteMembers,
  removeMember,
  updateGroup,
  updateMember,
} from './teamService';
import { supabase } from '../lib/supabase';

type MockFn = ReturnType<typeof vi.fn>;

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

describe('teamService extra helpers', () => {
  beforeEach(() => {
    (supabase.from as unknown as MockFn).mockReset();
  });

  it('getCurrentUserTeamRole 返回当前成员角色', async () => {
    const single = vi.fn().mockResolvedValue({
      data: { role: 'admin' },
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ single }) });

    (supabase.from as unknown as MockFn).mockImplementation((table: string) => {
      if (table === 'team_members') {
        return { select: vi.fn().mockReturnValue({ eq }) };
      }
      return {};
    });

    await expect(getCurrentUserTeamRole('team-1', 'user-1')).resolves.toBe('admin');
  });

  it('inviteMembers 写入 team_invitations 并为已注册用户写 notifications', async () => {
    const invitationInsert = vi.fn().mockResolvedValue({ error: null });
    const notificationInsert = vi.fn().mockResolvedValue({ error: null });
    const profileIn = vi.fn().mockResolvedValue({
      data: [{ id: 'user-2', email: 'a@example.com' }],
      error: null,
    });
    const memberIn = vi.fn().mockResolvedValue({
      data: [],
      error: null,
    });

    (supabase.from as unknown as MockFn).mockImplementation((table: string) => {
      if (table === 'profiles') {
        return { select: vi.fn().mockReturnValue({ in: profileIn }) };
      }
      if (table === 'team_members') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: memberIn,
            }),
          }),
        };
      }
      if (table === 'team_invitations') {
        return { insert: invitationInsert };
      }
      if (table === 'notifications') {
        return { insert: notificationInsert };
      }
      return {};
    });

    await expect(
      inviteMembers({
        teamId: 'team-1',
        invitedBy: 'user-1',
        rows: [
          {
            email: 'a@example.com',
            name: 'Alice',
            groupId: 'group-1',
            role: 'editor',
          },
          {
            email: 'b@example.com',
            name: '',
            groupId: null,
            role: 'reader',
          },
        ],
      }),
    ).resolves.toEqual({ insertedCount: 2 });

    expect(invitationInsert).toHaveBeenCalledWith([
      {
        team_id: 'team-1',
        invitee_email: 'a@example.com',
        invitee_user_id: 'user-2',
        role: 'editor',
        group_id: 'group-1',
        invited_by: 'user-1',
      },
      {
        team_id: 'team-1',
        invitee_email: 'b@example.com',
        invitee_user_id: null,
        role: 'reader',
        group_id: null,
        invited_by: 'user-1',
      },
    ]);
    expect(notificationInsert).toHaveBeenCalledWith([
      {
        user_id: 'user-2',
        type: 'team_invitation',
        payload: expect.objectContaining({
          teamId: 'team-1',
          inviteeEmail: 'a@example.com',
          role: 'editor',
        }),
      },
    ]);
  });

  it('inviteMembers 遇到已存在成员时抛出明确错误', async () => {
    const profileIn = vi.fn().mockResolvedValue({
      data: [{ id: 'user-3', email: 'member@example.com' }],
      error: null,
    });
    const memberIn = vi.fn().mockResolvedValue({
      data: [{ user_id: 'user-3' }],
      error: null,
    });

    (supabase.from as unknown as MockFn).mockImplementation((table: string) => {
      if (table === 'profiles') {
        return { select: vi.fn().mockReturnValue({ in: profileIn }) };
      }
      if (table === 'team_members') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              in: memberIn,
            }),
          }),
        };
      }
      return {};
    });

    await expect(
      inviteMembers({
        teamId: 'team-1',
        invitedBy: 'user-1',
        rows: [
          { email: 'member@example.com', name: '', groupId: null, role: 'reader' },
        ],
      }),
    ).rejects.toThrow('该用户已是团队成员');
  });

  it('fetchTeamMembers 返回标准化成员列表', async () => {
    const order = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'member-1',
          user_id: 'user-2',
          name: 'Alice',
          role: 'editor',
          group_id: 'group-1',
          status: 'active',
          profiles: { email: 'alice@example.com' },
          team_groups: { id: 'group-1', name: '产品组' },
        },
      ],
      error: null,
    });

    (supabase.from as unknown as MockFn).mockImplementation((table: string) => {
      if (table === 'team_members') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order,
            }),
          }),
        };
      }
      return {};
    });

    await expect(fetchTeamMembers('team-1')).resolves.toEqual([
      {
        id: 'member-1',
        userId: 'user-2',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'editor',
        groupId: 'group-1',
        groupName: '产品组',
      },
    ]);
  });

  it('updateMember、removeMember、createGroup、updateGroup、deleteGroup 调用正确表和字段', async () => {
    const memberUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const groupInsert = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: 'group-9', name: '测试组' },
          error: null,
        }),
      }),
    });
    const groupUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const groupDeleteEq = vi.fn().mockResolvedValue({ error: null });

    (supabase.from as unknown as MockFn).mockImplementation((table: string) => {
      if (table === 'team_members') {
        return {
          update: vi.fn().mockReturnValue({ eq: memberUpdateEq }),
        };
      }
      if (table === 'team_groups') {
        return {
          insert: groupInsert,
          update: vi.fn().mockReturnValue({ eq: groupUpdateEq }),
          delete: vi.fn().mockReturnValue({ eq: groupDeleteEq }),
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockResolvedValue({
                data: [{ id: 'group-1', name: '产品组' }],
                error: null,
              }),
            }),
          }),
        };
      }
      return {};
    });

    await expect(updateMember('member-1', { name: 'Bob', role: 'admin', groupId: null })).resolves.toBeUndefined();
    await expect(removeMember('member-1')).resolves.toBeUndefined();
    await expect(createGroup('team-1', ' 测试组 ')).resolves.toEqual({ id: 'group-9', name: '测试组' });
    await expect(updateGroup('group-9', '新名称')).resolves.toBeUndefined();
    await expect(deleteGroup('group-9')).resolves.toBeUndefined();
    await expect(fetchTeamGroups('team-1')).resolves.toEqual([{ id: 'group-1', name: '产品组' }]);

    expect(memberUpdateEq).toHaveBeenCalled();
    expect(groupInsert).toHaveBeenCalledWith({ team_id: 'team-1', name: '测试组', created_by: expect.any(String) });
    expect(groupUpdateEq).toHaveBeenCalledWith('id', 'group-9');
    expect(groupDeleteEq).toHaveBeenCalledWith('id', 'group-9');
  });
});
```

- [ ] **步骤 2：运行团队服务测试文件，确认新测试先失败**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/services/teamService.test.ts`
预期：FAIL，出现类似 `No export named 'inviteMembers'` 或缺少查询逻辑导致的断言失败。

- [ ] **步骤 3：在 `teamService.ts` 中实现最小可用的类型化 helper**

```ts
import { supabase } from '../lib/supabase';
import type { TeamSummary } from '../store/useTeamStore';

export type TeamRole = 'reader' | 'editor' | 'admin';

export interface TeamGroupSummary {
  id: string;
  name: string;
}

export interface InviteMemberRowInput {
  email: string;
  name: string;
  groupId: string | null;
  role: TeamRole;
}

export interface InviteMembersInput {
  teamId: string;
  invitedBy: string;
  rows: InviteMemberRowInput[];
}

export interface TeamMemberSummary {
  id: string;
  userId: string | null;
  name: string;
  email: string;
  role: TeamRole;
  groupId: string | null;
  groupName: string | null;
}

export async function getCurrentUserTeamRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .single();

  if (error) {
    return null;
  }

  return (data?.role as TeamRole | undefined) ?? null;
}

export async function fetchTeamGroups(teamId: string): Promise<TeamGroupSummary[]> {
  const { data, error } = await supabase
    .from('team_groups')
    .select('id, name')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`加载成员组失败：${error.message}`);
  }

  return (data ?? []).map((group) => ({ id: group.id, name: group.name }));
}

export async function inviteMembers(input: InviteMembersInput): Promise<{ insertedCount: number }> {
  const emails = input.rows.map((row) => row.email.trim().toLowerCase());
  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, email')
    .in('email', emails);

  if (profileError) {
    throw new Error(`查询被邀请用户失败：${profileError.message}`);
  }

  const profileByEmail = new Map(
    (profiles ?? []).map((profile) => [String(profile.email).toLowerCase(), profile.id as string]),
  );
  const knownUserIds = Array.from(profileByEmail.values());

  if (knownUserIds.length > 0) {
    const { data: members, error: memberError } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', input.teamId)
      .in('user_id', knownUserIds);

    if (memberError) {
      throw new Error(`校验团队成员失败：${memberError.message}`);
    }

    if ((members ?? []).length > 0) {
      throw new Error('该用户已是团队成员');
    }
  }

  const payload = input.rows.map((row) => {
    const normalizedEmail = row.email.trim().toLowerCase();
    return {
      team_id: input.teamId,
      invitee_email: normalizedEmail,
      invitee_user_id: profileByEmail.get(normalizedEmail) ?? null,
      role: row.role,
      group_id: row.groupId,
      invited_by: input.invitedBy,
    };
  });

  const { error: invitationError } = await supabase.from('team_invitations').insert(payload);
  if (invitationError) {
    throw new Error(`邀请成员失败：${invitationError.message}`);
  }

  const notifications = payload
    .filter((item) => item.invitee_user_id)
    .map((item) => ({
      user_id: item.invitee_user_id as string,
      type: 'team_invitation',
      payload: {
        teamId: item.team_id,
        inviteeEmail: item.invitee_email,
        role: item.role,
        groupId: item.group_id,
        invitedBy: item.invited_by,
      },
    }));

  if (notifications.length > 0) {
    const { error: notificationError } = await supabase.from('notifications').insert(notifications);
    if (notificationError) {
      throw new Error(`写入邀请通知失败：${notificationError.message}`);
    }
  }

  return { insertedCount: payload.length };
}

export async function fetchTeamMembers(teamId: string): Promise<TeamMemberSummary[]> {
  const { data, error } = await supabase
    .from('team_members')
    .select('id, user_id, name, role, group_id, profiles(email), team_groups(id, name)')
    .eq('team_id', teamId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`加载成员列表失败：${error.message}`);
  }

  return (data ?? []).map((item) => ({
    id: item.id,
    userId: item.user_id ?? null,
    name: item.name ?? '',
    email: (item.profiles as { email?: string } | null)?.email ?? '—',
    role: item.role as TeamRole,
    groupId: item.group_id ?? null,
    groupName: (item.team_groups as { name?: string } | null)?.name ?? null,
  }));
}

export async function updateMember(
  memberId: string,
  input: { name: string; role: TeamRole; groupId: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .update({ name: input.name.trim(), role: input.role, group_id: input.groupId })
    .eq('id', memberId);

  if (error) {
    throw new Error(`更新成员失败：${error.message}`);
  }
}

export async function removeMember(memberId: string): Promise<void> {
  const { error } = await supabase
    .from('team_members')
    .update({ status: 'removed' })
    .eq('id', memberId);

  if (error) {
    throw new Error(`删除成员失败：${error.message}`);
  }
}

export async function createGroup(teamId: string, name: string): Promise<TeamGroupSummary> {
  const groupName = name.trim();
  if (!groupName) {
    throw new Error('请输入成员组名称');
  }

  const { data, error } = await supabase
    .from('team_groups')
    .insert({ team_id: teamId, name: groupName, created_by: (await supabase.auth.getUser()).data.user?.id })
    .select('id, name')
    .single();

  if (error || !data) {
    throw new Error(`创建成员组失败：${error?.message ?? '未知错误'}`);
  }

  return { id: data.id, name: data.name };
}

export async function updateGroup(groupId: string, name: string): Promise<void> {
  const groupName = name.trim();
  if (!groupName) {
    throw new Error('请输入成员组名称');
  }

  const { error } = await supabase
    .from('team_groups')
    .update({ name: groupName })
    .eq('id', groupId);

  if (error) {
    throw new Error(`更新成员组失败：${error.message}`);
  }
}

export async function deleteGroup(groupId: string): Promise<void> {
  const { error } = await supabase
    .from('team_groups')
    .delete()
    .eq('id', groupId);

  if (error) {
    throw new Error(`删除成员组失败：${error.message}`);
  }
}
```

- [ ] **步骤 4：调整实现，避免在创建成员组时依赖 `supabase.auth.getUser()`**

使用显式传入的当前用户 id，这样更容易测试，也与现有 `createTeam` 风格保持一致。

```ts
export async function createGroup(
  input: { teamId: string; createdBy: string; name: string },
): Promise<TeamGroupSummary> {
  const groupName = input.name.trim();
  if (!groupName) {
    throw new Error('请输入成员组名称');
  }

  const { data, error } = await supabase
    .from('team_groups')
    .insert({
      team_id: input.teamId,
      name: groupName,
      created_by: input.createdBy,
    })
    .select('id, name')
    .single();

  if (error || !data) {
    throw new Error(`创建成员组失败：${error?.message ?? '未知错误'}`);
  }

  return { id: data.id, name: data.name };
}
```

同时更新测试断言：

```ts
await expect(createGroup({ teamId: 'team-1', createdBy: 'user-1', name: ' 测试组 ' })).resolves.toEqual({
  id: 'group-9',
  name: '测试组',
});

expect(groupInsert).toHaveBeenCalledWith({
  team_id: 'team-1',
  name: '测试组',
  created_by: 'user-1',
});
```

- [ ] **步骤 5：运行团队服务测试并确保通过**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/services/teamService.test.ts`
预期：PASS，包含原有 `createTeam` 测试和新增 helper 测试全部通过。

- [ ] **步骤 6：提交服务层改动**

```bash
git add web/src/services/teamService.ts web/src/services/teamService.test.ts
git commit -m "feat: add team member management service helpers"
```

---

### 任务 2：为团队信息弹窗和菜单接入补充失败的 UI 测试

**文件：**
- 新建：`web/src/components/TeamInfoModal.test.tsx`
- 修改：`web/src/layout/MainLayout.test.tsx`
- 测试：`web/src/components/TeamInfoModal.test.tsx`
- 测试：`web/src/layout/MainLayout.test.tsx`

- [ ] **步骤 1：先写失败的弹窗测试，覆盖邀请行、角色控制、成员编辑、成员删除和成员组 CRUD 入口**

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamInfoModal from './TeamInfoModal';

const mockGetRole = vi.fn();
const mockFetchGroups = vi.fn();
const mockFetchMembers = vi.fn();
const mockInviteMembers = vi.fn();
const mockUpdateMember = vi.fn();
const mockRemoveMember = vi.fn();
const mockCreateGroup = vi.fn();
const mockUpdateGroup = vi.fn();
const mockDeleteGroup = vi.fn();

vi.mock('../services/teamService', () => ({
  getCurrentUserTeamRole: (...args: unknown[]) => mockGetRole(...args),
  fetchTeamGroups: (...args: unknown[]) => mockFetchGroups(...args),
  fetchTeamMembers: (...args: unknown[]) => mockFetchMembers(...args),
  inviteMembers: (...args: unknown[]) => mockInviteMembers(...args),
  updateMember: (...args: unknown[]) => mockUpdateMember(...args),
  removeMember: (...args: unknown[]) => mockRemoveMember(...args),
  createGroup: (...args: unknown[]) => mockCreateGroup(...args),
  updateGroup: (...args: unknown[]) => mockUpdateGroup(...args),
  deleteGroup: (...args: unknown[]) => mockDeleteGroup(...args),
}));

vi.mock('../store/useAuthStore', () => ({
  useAuthStore: () => ({ user: { id: 'user-1', email: 'owner@example.com' } }),
}));

describe('TeamInfoModal', () => {
  beforeEach(() => {
    mockGetRole.mockReset();
    mockFetchGroups.mockReset();
    mockFetchMembers.mockReset();
    mockInviteMembers.mockReset();
    mockUpdateMember.mockReset();
    mockRemoveMember.mockReset();
    mockCreateGroup.mockReset();
    mockUpdateGroup.mockReset();
    mockDeleteGroup.mockReset();

    mockGetRole.mockResolvedValue('admin');
    mockFetchGroups.mockResolvedValue([{ id: 'group-1', name: '产品组' }]);
    mockFetchMembers.mockResolvedValue([
      {
        id: 'member-1',
        userId: 'user-2',
        name: 'Alice',
        email: 'alice@example.com',
        role: 'editor',
        groupId: 'group-1',
        groupName: '产品组',
      },
    ]);
    mockInviteMembers.mockResolvedValue({ insertedCount: 1 });
    mockUpdateMember.mockResolvedValue(undefined);
    mockRemoveMember.mockResolvedValue(undefined);
    mockCreateGroup.mockResolvedValue({ id: 'group-2', name: '设计组' });
    mockUpdateGroup.mockResolvedValue(undefined);
    mockDeleteGroup.mockResolvedValue(undefined);
  });

  it('admin 可以看到邀请入口并提交多行邀请', async () => {
    const user = userEvent.setup();
    render(<TeamInfoModal open teamId="team-1" onClose={vi.fn()} />);

    expect(await screen.findByRole('menuitem', { name: '通过邮箱邀请' })).toBeTruthy();

    await user.type(screen.getByLabelText('邮箱-0'), 'a@example.com');
    await user.click(screen.getByRole('button', { name: '再加一个' }));
    await user.type(screen.getByLabelText('邮箱-1'), 'b@example.com');
    await user.click(screen.getByRole('button', { name: '确定' }));

    await waitFor(() => {
      expect(mockInviteMembers).toHaveBeenCalledWith({
        teamId: 'team-1',
        invitedBy: 'user-1',
        rows: [
          expect.objectContaining({ email: 'a@example.com' }),
          expect.objectContaining({ email: 'b@example.com' }),
        ],
      });
    });
  });

  it('邮箱为空时不能提交邀请', async () => {
    const user = userEvent.setup();
    render(<TeamInfoModal open teamId="team-1" onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '确定' }));

    expect(await screen.findByText('请输入邮箱')).toBeTruthy();
    expect(mockInviteMembers).not.toHaveBeenCalled();
  });

  it('非 admin 看不到邀请入口且操作列禁用', async () => {
    mockGetRole.mockResolvedValue('reader');
    const user = userEvent.setup();
    render(<TeamInfoModal open teamId="team-1" onClose={vi.fn()} />);

    expect(screen.queryByRole('menuitem', { name: '通过邮箱邀请' })).toBeNull();
    expect(await screen.findByText('成员管理')).toBeTruthy();

    const editButton = await screen.findByRole('button', { name: '编辑成员-member-1' });
    const removeButton = screen.getByRole('button', { name: '删除成员-member-1' });
    expect(editButton).toBeDisabled();
    expect(removeButton).toBeDisabled();

    await user.click(screen.getByRole('menuitem', { name: /未分组|产品组|成员管理/ }));
  });

  it('admin 可以编辑成员并删除成员', async () => {
    const user = userEvent.setup();
    render(<TeamInfoModal open teamId="team-1" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('menuitem', { name: '成员管理' }));
    await user.click(await screen.findByRole('button', { name: '编辑成员-member-1' }));
    await user.clear(screen.getByLabelText('编辑成员姓名'));
    await user.type(screen.getByLabelText('编辑成员姓名'), 'Alice Cooper');
    await user.click(screen.getByRole('button', { name: '保存成员信息' }));

    await waitFor(() => {
      expect(mockUpdateMember).toHaveBeenCalledWith('member-1', {
        name: 'Alice Cooper',
        role: 'editor',
        groupId: 'group-1',
      });
    });

    await user.click(screen.getByRole('button', { name: '删除成员-member-1' }));
    await user.click(await screen.findByRole('button', { name: '确认删除成员' }));

    await waitFor(() => {
      expect(mockRemoveMember).toHaveBeenCalledWith('member-1');
    });
  });

  it('admin 可以新增、编辑、删除成员组', async () => {
    const user = userEvent.setup();
    render(<TeamInfoModal open teamId="team-1" onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: '新增成员组' }));
    await user.type(screen.getByLabelText('成员组名称'), '设计组');
    await user.click(screen.getByRole('button', { name: '保存成员组' }));

    await waitFor(() => {
      expect(mockCreateGroup).toHaveBeenCalledWith({ teamId: 'team-1', createdBy: 'user-1', name: '设计组' });
    });

    const groupRow = await screen.findByLabelText('成员组操作-group-1');
    await user.hover(groupRow);
    await user.click(within(groupRow).getByRole('button', { name: '编辑成员组-group-1' }));
    await user.clear(screen.getByLabelText('编辑成员组名称'));
    await user.type(screen.getByLabelText('编辑成员组名称'), '新产品组');
    await user.click(screen.getByRole('button', { name: '确认编辑成员组' }));

    await waitFor(() => {
      expect(mockUpdateGroup).toHaveBeenCalledWith('group-1', '新产品组');
    });

    await user.hover(groupRow);
    await user.click(within(groupRow).getByRole('button', { name: '删除成员组-group-1' }));
    await user.click(await screen.findByRole('button', { name: '确认删除成员组' }));

    await waitFor(() => {
      expect(mockDeleteGroup).toHaveBeenCalledWith('group-1');
    });
  });
});
```

- [ ] **步骤 2：在 `MainLayout.test.tsx` 中追加失败的集成测试，验证从头像下拉菜单打开团队信息弹窗**

把下面测试追加到 `web/src/layout/MainLayout.test.tsx`：

```tsx
const mockTeamInfoModal = vi.fn();

vi.mock('../components/TeamInfoModal', () => ({
  default: (props: { open: boolean; teamId: string | null; onClose: () => void }) => {
    mockTeamInfoModal(props);
    return props.open ? <div>团队信息弹窗占位</div> : null;
  },
}));

it('点击团队信息后打开团队信息弹窗并传入 currentTeamId', async () => {
  mockTeamState.teams = [{ id: 'team-1', name: '团队 A' }];
  mockTeamState.currentTeamId = 'team-1';
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

  expect(await screen.findByText('团队信息弹窗占位')).toBeTruthy();
  expect(mockTeamInfoModal).toHaveBeenLastCalledWith(
    expect.objectContaining({ open: true, teamId: 'team-1' }),
  );
});
```

- [ ] **步骤 3：运行 UI 测试文件并确认先失败**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/components/TeamInfoModal.test.tsx src/layout/MainLayout.test.tsx`
预期：FAIL，因为 `TeamInfoModal.tsx` 还不存在，且 MainLayout 还未渲染该组件。

- [ ] **步骤 4：在实现前先提交这批失败的测试**

```bash
git add web/src/components/TeamInfoModal.test.tsx web/src/layout/MainLayout.test.tsx
git commit -m "test: cover team info modal flows"
```

---

### 任务 3：实现 `TeamInfoModal`，完成邀请面板和成员管理流程

**文件：**
- 新建：`web/src/components/TeamInfoModal.tsx`
- 修改：`web/src/layout/MainLayout.tsx`
- 测试：`web/src/components/TeamInfoModal.test.tsx`
- 测试：`web/src/layout/MainLayout.test.tsx`

- [ ] **步骤 1：先创建弹窗骨架，包含团队角色加载、左侧导航和初始面板选择**

```tsx
import React, { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Form,
  Input,
  Menu,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { useAuthStore } from '../store/useAuthStore';
import {
  createGroup,
  deleteGroup,
  fetchTeamGroups,
  fetchTeamMembers,
  getCurrentUserTeamRole,
  inviteMembers,
  type TeamGroupSummary,
  type TeamMemberSummary,
  type TeamRole,
  updateGroup,
  updateMember,
  removeMember,
} from '../services/teamService';

interface TeamInfoModalProps {
  open: boolean;
  teamId: string | null;
  onClose: () => void;
}

type InviteRow = {
  key: string;
  email: string;
  name: string;
  groupId: string | null;
  role: TeamRole;
};

type ActivePanelKey = 'invite' | 'members-all' | `group:${string}`;

const createInviteRow = (index: number): InviteRow => ({
  key: `invite-row-${index}`,
  email: '',
  name: '',
  groupId: null,
  role: 'reader',
});

const roleLabelMap: Record<TeamRole, string> = {
  reader: '只读',
  editor: '可编辑',
  admin: '管理员',
};

const TeamInfoModal: React.FC<TeamInfoModalProps> = ({ open, teamId, onClose }) => {
  const { user } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [submittingInvite, setSubmittingInvite] = useState(false);
  const [activePanel, setActivePanel] = useState<ActivePanelKey>('members-all');
  const [role, setRole] = useState<TeamRole | null>(null);
  const [groups, setGroups] = useState<TeamGroupSummary[]>([]);
  const [members, setMembers] = useState<TeamMemberSummary[]>([]);
  const [inviteRows, setInviteRows] = useState<InviteRow[]>([createInviteRow(0)]);
  const [editingMember, setEditingMember] = useState<TeamMemberSummary | null>(null);
  const [memberForm] = Form.useForm<{ name: string; groupId: string | null; role: TeamRole }>();
  const [groupCreateOpen, setGroupCreateOpen] = useState(false);
  const [groupCreateName, setGroupCreateName] = useState('');
  const [editingGroup, setEditingGroup] = useState<TeamGroupSummary | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');

  const isAdmin = role === 'admin';

  const loadData = async () => {
    if (!open || !teamId || !user?.id) {
      return;
    }
    setLoading(true);
    try {
      const [currentRole, groupList, memberList] = await Promise.all([
        getCurrentUserTeamRole(teamId, user.id),
        fetchTeamGroups(teamId),
        fetchTeamMembers(teamId),
      ]);
      setRole(currentRole);
      setGroups(groupList);
      setMembers(memberList);
      setActivePanel(currentRole === 'admin' ? 'invite' : 'members-all');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载团队信息失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadData();
  }, [open, teamId, user?.id]);

  useEffect(() => {
    if (!open) {
      setInviteRows([createInviteRow(0)]);
      setEditingMember(null);
      setGroupCreateOpen(false);
      setEditingGroup(null);
      setEditingGroupName('');
    }
  }, [open]);
```

- [ ] **步骤 2：补齐左侧菜单渲染、成员过滤逻辑和邀请行编辑 helper**

```tsx
  const filteredMembers = useMemo(() => {
    if (activePanel === 'members-all') {
      return members.filter((member) => member.groupId === null);
    }
    if (activePanel.startsWith('group:')) {
      const groupId = activePanel.replace('group:', '');
      return members.filter((member) => member.groupId === groupId);
    }
    return members;
  }, [activePanel, members]);

  const menuItems = [
    ...(isAdmin
      ? [
          {
            key: 'invite',
            label: '通过邮箱邀请',
          },
        ]
      : []),
    {
      key: 'members-root',
      label: (
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <span>成员管理</span>
          {isAdmin ? (
            <Button
              type="text"
              size="small"
              aria-label="新增成员组"
              icon={<PlusOutlined />}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setGroupCreateOpen(true);
              }}
            />
          ) : null}
        </Space>
      ),
      children: [
        {
          key: 'members-all',
          label: '未分组',
        },
        ...groups.map((group) => ({
          key: `group:${group.id}`,
          label: (
            <div aria-label={`成员组操作-${group.id}`} style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
              <span>{group.name}</span>
              {isAdmin ? (
                <Space size={0}>
                  <Button
                    type="text"
                    size="small"
                    aria-label={`编辑成员组-${group.id}`}
                    icon={<EditOutlined />}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditingGroup(group);
                      setEditingGroupName(group.name);
                    }}
                  />
                  <Popconfirm
                    title="确定删除该成员组吗？"
                    okText="确认删除成员组"
                    cancelText="取消"
                    onConfirm={async () => {
                      try {
                        await deleteGroup(group.id);
                        message.success('成员组已删除');
                        await loadData();
                        setActivePanel('members-all');
                      } catch (error) {
                        message.error(error instanceof Error ? error.message : '删除成员组失败');
                      }
                    }}
                  >
                    <Button
                      type="text"
                      size="small"
                      aria-label={`删除成员组-${group.id}`}
                      icon={<DeleteOutlined />}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                    />
                  </Popconfirm>
                </Space>
              ) : null}
            </div>
          ),
        })),
      ],
    },
  ];

  const updateInviteRow = (key: string, patch: Partial<InviteRow>) => {
    setInviteRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addInviteRow = () => {
    setInviteRows((current) => [...current, createInviteRow(current.length)]);
  };

  const removeInviteRow = (key: string) => {
    setInviteRows((current) => current.filter((row) => row.key !== key));
  };
```

- [ ] **步骤 3：补齐邀请提交、成员编辑、成员组创建/更新的处理函数**

```tsx
  const validateInviteRows = () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const row of inviteRows) {
      if (!row.email.trim()) {
        throw new Error('请输入邮箱');
      }
      if (!emailRegex.test(row.email.trim())) {
        throw new Error('请输入正确的邮箱地址');
      }
    }
  };

  const handleSubmitInvite = async () => {
    if (!teamId || !user?.id) {
      return;
    }

    try {
      validateInviteRows();
      setSubmittingInvite(true);
      await inviteMembers({
        teamId,
        invitedBy: user.id,
        rows: inviteRows.map((row) => ({
          email: row.email,
          name: row.name,
          groupId: row.groupId,
          role: row.role,
        })),
      });
      message.success('邀请已发送');
      setInviteRows([createInviteRow(0)]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '邀请成员失败');
    } finally {
      setSubmittingInvite(false);
    }
  };

  const openEditMember = (member: TeamMemberSummary) => {
    setEditingMember(member);
    memberForm.setFieldsValue({
      name: member.name,
      groupId: member.groupId,
      role: member.role,
    });
  };

  const handleSaveMember = async () => {
    if (!editingMember) {
      return;
    }

    try {
      const values = await memberForm.validateFields();
      await updateMember(editingMember.id, {
        name: values.name,
        groupId: values.groupId,
        role: values.role,
      });
      message.success('成员信息已更新');
      setEditingMember(null);
      await loadData();
    } catch (error) {
      if (error instanceof Error) {
        message.error(error.message);
      }
    }
  };

  const handleCreateGroup = async () => {
    if (!teamId || !user?.id) {
      return;
    }

    try {
      await createGroup({
        teamId,
        createdBy: user.id,
        name: groupCreateName,
      });
      message.success('成员组已创建');
      setGroupCreateOpen(false);
      setGroupCreateName('');
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '创建成员组失败');
    }
  };

  const handleUpdateGroup = async () => {
    if (!editingGroup) {
      return;
    }

    try {
      await updateGroup(editingGroup.id, editingGroupName);
      message.success('成员组已更新');
      setEditingGroup(null);
      setEditingGroupName('');
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新成员组失败');
    }
  };
```

- [ ] **步骤 4：完成邀请面板、成员表格、编辑弹窗和成员组对话框的 JSX**

```tsx
  return (
    <Modal
      open={open}
      title="团队信息"
      onCancel={onClose}
      footer={null}
      width={800}
      destroyOnClose
    >
      <div style={{ display: 'flex', gap: 16, minHeight: 560 }}>
        <div style={{ width: 220, borderRight: '1px solid #f0f0f0', paddingRight: 12 }}>
          <Menu
            mode="inline"
            selectedKeys={[activePanel]}
            defaultOpenKeys={['members-root']}
            items={menuItems}
            onClick={({ key }) => setActivePanel(key as ActivePanelKey)}
          />
        </div>

        <div style={{ flex: 1 }}>
          {activePanel === 'invite' ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {inviteRows.map((row, index) => (
                <Space key={row.key} align="start" style={{ display: 'flex' }}>
                  <Form.Item
                    validateStatus={!row.email.trim() ? undefined : undefined}
                    help={undefined}
                    label={index === 0 ? '邮箱' : ' '}
                  >
                    <Input
                      aria-label={`邮箱-${index}`}
                      value={row.email}
                      placeholder="请输入邮箱"
                      onChange={(event) => updateInviteRow(row.key, { email: event.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label={index === 0 ? '姓名' : ' '}>
                    <Input
                      aria-label={`姓名-${index}`}
                      value={row.name}
                      placeholder="请输入姓名"
                      onChange={(event) => updateInviteRow(row.key, { name: event.target.value })}
                    />
                  </Form.Item>
                  <Form.Item label={index === 0 ? '成员组' : ' '}>
                    <Select
                      aria-label={`成员组-${index}`}
                      value={row.groupId}
                      style={{ width: 120 }}
                      allowClear
                      options={groups.map((group) => ({ value: group.id, label: group.name }))}
                      onChange={(value) => updateInviteRow(row.key, { groupId: value ?? null })}
                    />
                  </Form.Item>
                  <Form.Item label={index === 0 ? '角色' : ' '}>
                    <Select
                      aria-label={`角色-${index}`}
                      value={row.role}
                      style={{ width: 120 }}
                      options={Object.entries(roleLabelMap).map(([value, label]) => ({ value, label }))}
                      onChange={(value) => updateInviteRow(row.key, { role: value as TeamRole })}
                    />
                  </Form.Item>
                  {index > 0 ? (
                    <Button aria-label={`删除邀请行-${index}`} type="text" icon={<DeleteOutlined />} onClick={() => removeInviteRow(row.key)} />
                  ) : null}
                </Space>
              ))}

              <Space>
                <Button type="link" onClick={addInviteRow}>
                  再加一个
                </Button>
                <Button type="primary" loading={submittingInvite} onClick={handleSubmitInvite}>
                  确定
                </Button>
              </Space>
            </Space>
          ) : (
            <Table
              rowKey="id"
              loading={loading}
              pagination={{ pageSize: 10 }}
              dataSource={filteredMembers}
              columns={[
                { title: '姓名', dataIndex: 'name', key: 'name', render: (value: string) => value || '—' },
                { title: '邮箱', dataIndex: 'email', key: 'email' },
                { title: '成员组', dataIndex: 'groupName', key: 'groupName', render: (value: string | null) => value || '未分组' },
                { title: '角色', dataIndex: 'role', key: 'role', render: (value: TeamRole) => roleLabelMap[value] },
                {
                  title: '操作',
                  key: 'actions',
                  render: (_, record: TeamMemberSummary) => (
                    <Space>
                      <Button
                        aria-label={`编辑成员-${record.id}`}
                        disabled={!isAdmin}
                        onClick={() => openEditMember(record)}
                      >
                        编辑
                      </Button>
                      <Popconfirm
                        title="确定删除该成员吗？"
                        okText="确认删除成员"
                        cancelText="取消"
                        onConfirm={async () => {
                          try {
                            await removeMember(record.id);
                            message.success('成员已删除');
                            await loadData();
                          } catch (error) {
                            message.error(error instanceof Error ? error.message : '删除成员失败');
                          }
                        }}
                      >
                        <Button aria-label={`删除成员-${record.id}`} danger disabled={!isAdmin}>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          )}
        </div>
      </div>

      <Modal
        open={Boolean(editingMember)}
        title="编辑成员"
        onCancel={() => setEditingMember(null)}
        onOk={handleSaveMember}
        okText="保存成员信息"
        cancelText="取消"
      >
        <Form form={memberForm} layout="vertical">
          <Form.Item label="姓名" name="name" rules={[{ required: true, message: '请输入姓名' }]}>
            <Input aria-label="编辑成员姓名" />
          </Form.Item>
          <Form.Item label="成员组" name="groupId">
            <Select
              allowClear
              options={groups.map((group) => ({ value: group.id, label: group.name }))}
            />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true, message: '请选择角色' }]}>
            <Select options={Object.entries(roleLabelMap).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={groupCreateOpen}
        title="新增成员组"
        onCancel={() => setGroupCreateOpen(false)}
        onOk={handleCreateGroup}
        okText="保存成员组"
        cancelText="取消"
      >
        <Input aria-label="成员组名称" value={groupCreateName} onChange={(event) => setGroupCreateName(event.target.value)} />
      </Modal>

      <Modal
        open={Boolean(editingGroup)}
        title="编辑成员组"
        onCancel={() => setEditingGroup(null)}
        onOk={handleUpdateGroup}
        okText="确认编辑成员组"
        cancelText="取消"
      >
        <Input aria-label="编辑成员组名称" value={editingGroupName} onChange={(event) => setEditingGroupName(event.target.value)} />
      </Modal>
    </Modal>
  );
};

export default TeamInfoModal;
```

- [ ] **步骤 5：修正邀请面板校验方式，让测试可以断言行内错误文本，而不是只依赖全局 message 错误**

加入本地校验状态：

```tsx
const [inviteErrors, setInviteErrors] = useState<Record<string, string>>({});

const validateInviteRows = () => {
  const nextErrors: Record<string, string> = {};
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  inviteRows.forEach((row) => {
    const normalized = row.email.trim();
    if (!normalized) {
      nextErrors[row.key] = '请输入邮箱';
      return;
    }
    if (!emailRegex.test(normalized)) {
      nextErrors[row.key] = '请输入正确的邮箱地址';
    }
  });

  setInviteErrors(nextErrors);
  if (Object.keys(nextErrors).length > 0) {
    throw new Error(Object.values(nextErrors)[0]);
  }
};
```

在邮箱 `Form.Item` 中使用：

```tsx
<Form.Item
  label={index === 0 ? '邮箱' : ' '}
  validateStatus={inviteErrors[row.key] ? 'error' : ''}
  help={inviteErrors[row.key]}
>
```

同时在修改行内容时清理该行错误：

```tsx
const updateInviteRow = (key: string, patch: Partial<InviteRow>) => {
  setInviteRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  setInviteErrors((current) => {
    if (!current[key]) {
      return current;
    }
    const next = { ...current };
    delete next[key];
    return next;
  });
};
```

- [ ] **步骤 6：把 `MainLayout` 接到团队信息弹窗的打开/关闭逻辑上**

更新 `web/src/layout/MainLayout.tsx`：

```tsx
import TeamInfoModal from '../components/TeamInfoModal';

const [teamInfoOpen, setTeamInfoOpen] = useState(false);

const handleOpenTeamInfo = () => {
  if (!hasTeams || !currentTeamId) {
    return;
  }
  setTeamInfoOpen(true);
};

{
  key: 'team-info',
  label: '团队信息',
  disabled: !hasTeams,
  onClick: handleOpenTeamInfo,
},
```

在现有创建团队弹窗附近渲染：

```tsx
<TeamInfoModal
  open={teamInfoOpen}
  teamId={currentTeamId}
  onClose={() => setTeamInfoOpen(false)}
/>
```

- [ ] **步骤 7：运行弹窗和布局测试，并确保全部通过**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/components/TeamInfoModal.test.tsx src/layout/MainLayout.test.tsx`
预期：PASS，邀请/成员/成员组场景全部通过。

- [ ] **步骤 8：提交弹窗实现**

```bash
git add web/src/components/TeamInfoModal.tsx web/src/components/TeamInfoModal.test.tsx web/src/layout/MainLayout.tsx web/src/layout/MainLayout.test.tsx
git commit -m "feat: add team info modal management flows"
```

---

### 任务 4：做更广泛的验证，并更新开发计划文档

**文件：**
- 修改：`开发计划.md`
- 测试：`web/src/services/teamService.test.ts`
- 测试：`web/src/components/TeamInfoModal.test.tsx`
- 测试：`web/src/layout/MainLayout.test.tsx`

- [ ] **步骤 1：运行所有本次改动相关的聚焦测试集**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/services/teamService.test.ts src/components/TeamInfoModal.test.tsx src/layout/MainLayout.test.tsx`
预期：PASS，任务 1-3 中新增的测试全部通过。

- [ ] **步骤 2：运行完整前端测试套件，检查回归问题**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npm run test`
预期：PASS，现有 auth / document / layout 等测试无回归。

- [ ] **步骤 3：运行生产构建**

运行：`cd /Users/applewill/AI_Project/PFM-Trae/web && npm run build`
预期：Vite 生产构建成功完成。

- [ ] **步骤 4：把 `开发计划.md` 中子任务 4 和子任务 5 标记为完成**

将 `开发计划.md` 中这两行：

```md
- [ ] **子任务 4：团队信息弹窗 — 邀请成员**
- [ ] **子任务 5：团队信息弹窗 — 成员管理**
```

改为：

```md
- [x] **子任务 4：团队信息弹窗 — 邀请成员**
- [x] **子任务 5：团队信息弹窗 — 成员管理**
```

- [ ] **步骤 5：提交验证结果和计划文档更新**

```bash
git add 开发计划.md
git commit -m "docs: mark team info modal tasks complete"
```

---

## 自检

- 规格覆盖检查：
  - 单一大弹窗 + 左侧菜单：任务 3
  - 多行邀请流程 + 仅 admin 可见邀请入口：任务 1-3
  - 成员表格、编辑/删除、非 admin 禁用状态：任务 3
  - 成员组新增/编辑/删除和左侧菜单联动：任务 1-3
  - 开发计划复选框更新与完整验证：任务 4
- 占位语扫描完成：没有 TODO / TBD / “类似任务 N” 之类的空泛描述。
- 类型一致性检查完成：共享的 `TeamRole`、`TeamGroupSummary`、`TeamMemberSummary` 类型统一在服务层定义，并在组件计划中复用。

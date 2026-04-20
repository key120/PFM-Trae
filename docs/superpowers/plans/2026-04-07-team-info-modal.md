# Team Info Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the team info modal so admins can invite members and manage members/groups, while non-admins get a read-only member management view.

**Architecture:** Extend the existing `MainLayout` team menu with a single `TeamInfoModal` component that owns loading team role, groups, invitations, and member management state for the currently selected team. Keep persistence in `teamService.ts`, keep UI orchestration in the modal component, and follow the repository’s existing Ant Design + Zustand + message/Modal patterns.

**Tech Stack:** React 18, TypeScript, Ant Design, Zustand, Supabase JS, Vitest, Testing Library

---

## File Structure

### Create
- `web/src/components/TeamInfoModal.tsx` — team info modal UI, left navigation, invite panel, member table, group management, edit/create dialogs
- `web/src/components/TeamInfoModal.test.tsx` — focused tests for invite panel, role gating, member management, and group actions
- `docs/superpowers/plans/2026-04-07-team-info-modal.md` — this implementation plan

### Modify
- `web/src/layout/MainLayout.tsx` — wire the “团队信息” menu item to open the modal for `currentTeamId`
- `web/src/layout/MainLayout.test.tsx` — cover opening the team info modal from the avatar dropdown
- `web/src/services/teamService.ts` — add typed data access helpers for team role, groups, invitations, member queries, member updates, member removal, and group CRUD
- `web/src/services/teamService.test.ts` — add service tests for invite/member/group operations
- `开发计划.md` — mark 子任务 4 and 子任务 5 complete after implementation and verification

### Existing references to read while implementing
- `web/src/layout/MainLayout.tsx` — current team menu and modal pattern
- `web/src/services/teamService.ts` — current team creation service style
- `web/src/store/useTeamStore.ts` — current team selection state
- `supabase/migrations/20250321000001_team_tables.sql` — team tables and allowed roles/status values
- `supabase/migrations/20250321000002_shares_notifications.sql` — notifications table and note about insert policy
- `supabase/migrations/20260326184500_fix_team_rls_bootstrap.sql` — team RLS helper functions and invitation/member access assumptions
- `docs/superpowers/specs/2026-04-07-team-info-modal-design.md` — approved design spec

---

### Task 1: Extend team service with typed read/write helpers

**Files:**
- Modify: `web/src/services/teamService.ts`
- Test: `web/src/services/teamService.test.ts`

- [ ] **Step 1: Write the failing service tests for role lookup, invitation writes, member updates, and group CRUD**

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

- [ ] **Step 2: Run the team service test file and verify the new tests fail**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/services/teamService.test.ts`
Expected: FAIL with messages such as `No export named 'inviteMembers'` or assertion failures for missing queries.

- [ ] **Step 3: Implement the minimal typed helpers in `teamService.ts`**

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

- [ ] **Step 4: Adjust the implementation to avoid relying on `supabase.auth.getUser()` inside group creation**

Use the current user id as an explicit parameter to keep the service testable and consistent with existing `createTeam` style.

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

Update the test expectation accordingly:

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

- [ ] **Step 5: Run the team service tests and make sure they pass**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/services/teamService.test.ts`
Expected: PASS with all `createTeam` and new helper tests green.

- [ ] **Step 6: Commit the service layer changes**

```bash
git add web/src/services/teamService.ts web/src/services/teamService.test.ts
git commit -m "feat: add team member management service helpers"
```

---

### Task 2: Add failing UI tests for the team info modal and menu integration

**Files:**
- Create: `web/src/components/TeamInfoModal.test.tsx`
- Modify: `web/src/layout/MainLayout.test.tsx`
- Test: `web/src/components/TeamInfoModal.test.tsx`
- Test: `web/src/layout/MainLayout.test.tsx`

- [ ] **Step 1: Write the failing modal tests covering invite rows, role gating, member editing, member removal, and group CRUD entry points**

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

- [ ] **Step 2: Add the failing MainLayout integration test for opening the team info modal from the avatar dropdown**

Append this test in `web/src/layout/MainLayout.test.tsx`:

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

- [ ] **Step 3: Run the UI test files and verify they fail**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/components/TeamInfoModal.test.tsx src/layout/MainLayout.test.tsx`
Expected: FAIL because `TeamInfoModal.tsx` does not exist yet and MainLayout does not render it.

- [ ] **Step 4: Commit the failing tests before implementation**

```bash
git add web/src/components/TeamInfoModal.test.tsx web/src/layout/MainLayout.test.tsx
git commit -m "test: cover team info modal flows"
```

---

### Task 3: Implement `TeamInfoModal` with invite panel and member management flows

**Files:**
- Create: `web/src/components/TeamInfoModal.tsx`
- Modify: `web/src/layout/MainLayout.tsx`
- Test: `web/src/components/TeamInfoModal.test.tsx`
- Test: `web/src/layout/MainLayout.test.tsx`

- [ ] **Step 1: Create the modal shell with team role loading, left navigation, and initial panel selection**

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

- [ ] **Step 2: Add left menu rendering, filtered member data, and invite row editing helpers**

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

- [ ] **Step 3: Add invite submission, member editing, and group create/update handlers**

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

- [ ] **Step 4: Finish the JSX for invite panel, member table, edit modal, and group dialogs**

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

- [ ] **Step 5: Fix the invite panel validation so tests can assert inline error text instead of only global message errors**

Add local validation state:

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

Use it in the email `Form.Item`:

```tsx
<Form.Item
  label={index === 0 ? '邮箱' : ' '}
  validateStatus={inviteErrors[row.key] ? 'error' : ''}
  help={inviteErrors[row.key]}
>
```

Also clear row errors on change:

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

- [ ] **Step 6: Wire `MainLayout` to open and close the team info modal**

Update `web/src/layout/MainLayout.tsx`:

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

Render the modal near the existing create-team modal:

```tsx
<TeamInfoModal
  open={teamInfoOpen}
  teamId={currentTeamId}
  onClose={() => setTeamInfoOpen(false)}
/>
```

- [ ] **Step 7: Run the modal and layout tests and make them pass**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/components/TeamInfoModal.test.tsx src/layout/MainLayout.test.tsx`
Expected: PASS with invite/member/group scenarios green.

- [ ] **Step 8: Commit the modal implementation**

```bash
git add web/src/components/TeamInfoModal.tsx web/src/components/TeamInfoModal.test.tsx web/src/layout/MainLayout.tsx web/src/layout/MainLayout.test.tsx
git commit -m "feat: add team info modal management flows"
```

---

### Task 4: Run broader verification and update planning docs

**Files:**
- Modify: `开发计划.md`
- Test: `web/src/services/teamService.test.ts`
- Test: `web/src/components/TeamInfoModal.test.tsx`
- Test: `web/src/layout/MainLayout.test.tsx`

- [ ] **Step 1: Run the focused test suite for all touched feature areas**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npx vitest run src/services/teamService.test.ts src/components/TeamInfoModal.test.tsx src/layout/MainLayout.test.tsx`
Expected: PASS for all tests added in Tasks 1-3.

- [ ] **Step 2: Run the full frontend test suite to catch regressions**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npm run test`
Expected: PASS with no regressions in existing auth/document/layout tests.

- [ ] **Step 3: Run the production build**

Run: `cd /Users/applewill/AI_Project/PFM-Trae/web && npm run build`
Expected: Vite production build completes successfully.

- [ ] **Step 4: Mark 子任务 4 and 子任务 5 complete in `开发计划.md`**

Change the checklist lines in `开发计划.md` from:

```md
- [ ] **子任务 4：团队信息弹窗 — 邀请成员**
- [ ] **子任务 5：团队信息弹窗 — 成员管理**
```

to:

```md
- [x] **子任务 4：团队信息弹窗 — 邀请成员**
- [x] **子任务 5：团队信息弹窗 — 成员管理**
```

- [ ] **Step 5: Commit the verification and plan updates**

```bash
git add 开发计划.md
git commit -m "docs: mark team info modal tasks complete"
```

---

## Self-Review

- Spec coverage checked:
  - Single large modal with left menu: Task 3
  - Invite panel multi-row invite flow + admin-only access: Tasks 1-3
  - Member table, edit/remove actions, non-admin disabled state: Task 3
  - Group create/update/delete and left menu integration: Tasks 1-3
  - Development-plan checkbox update and full verification: Task 4
- Placeholder scan completed: no TODO/TBD/similar-to shortcuts remain.
- Type consistency checked: shared `TeamRole`, `TeamGroupSummary`, and `TeamMemberSummary` types defined once in service layer and reused in component plan.

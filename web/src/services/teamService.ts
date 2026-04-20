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

interface CreateTeamInput {
  userId: string;
  teamName: string;
}

interface ProfileLookupRow {
  id: string;
  email: string | null;
}

interface TeamMemberRow {
  id: string;
  user_id: string | null;
  name: string | null;
  role: TeamRole;
  group_id: string | null;
  profiles?: {
    email?: string | null;
  } | null;
  team_groups?: {
    name?: string | null;
  } | null;
}

function getErrorMessage(error: { message?: string } | null | undefined, fallback: string) {
  return error && typeof error.message === 'string' && error.message.trim()
    ? error.message
    : fallback;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isRpcFunctionMissingError(error: { code?: string; message?: string } | null | undefined) {
  if (!error) {
    return false;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  return error.code === 'PGRST202' || message.includes('create_team_with_owner') || message.includes('schema cache');
}

async function getCurrentUserIdForFallback() {
  const { data, error } = await supabase.auth.getUser();
  const userId = data?.user?.id;
  if (error || !userId) {
    throw new Error('创建团队失败：无法获取当前登录用户');
  }
  return userId;
}

async function createTeamFallback(name: string): Promise<TeamSummary> {
  const currentUserId = await getCurrentUserIdForFallback();

  const { data: teamData, error: teamError } = await supabase
    .from('teams')
    .insert({
      name,
      created_by: currentUserId,
    })
    .select('id, name')
    .single();

  if (teamError || !teamData) {
    throw new Error(`创建团队失败：${getErrorMessage(teamError, '未知错误')}`);
  }

  const { error: memberError } = await supabase.from('team_members').insert({
    team_id: teamData.id,
    user_id: currentUserId,
    role: 'admin',
    status: 'active',
    joined_at: new Date().toISOString(),
  });

  if (memberError) {
    await supabase.from('teams').delete().eq('id', teamData.id);
    throw new Error(`创建团队失败：${getErrorMessage(memberError, '未知错误')}`);
  }

  return {
    id: teamData.id,
    name: teamData.name,
  };
}

function validateGroupName(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('请输入成员组名称');
  }

  return trimmedName;
}

export async function createTeam(input: CreateTeamInput): Promise<TeamSummary> {
  const name = input.teamName.trim();
  if (!name) {
    throw new Error('请输入团队名称');
  }

  const { data, error } = await supabase.rpc('create_team_with_owner', {
    p_name: name,
  });

  if (error) {
    if (isRpcFunctionMissingError(error)) {
      return createTeamFallback(name);
    }
    const message = getErrorMessage(error, '未知错误');
    throw new Error(`创建团队失败：${message}`);
  }

  const team = Array.isArray(data) ? data[0] : data;
  if (!team || typeof team.id !== 'string' || typeof team.name !== 'string') {
    throw new Error('创建团队失败：未知错误');
  }

  return {
    id: team.id,
    name: team.name,
  };
}

export async function getCurrentUserTeamRole(teamId: string, userId: string): Promise<TeamRole | null> {
  const { data, error } = await supabase
    .from('team_members')
    .select('role')
    .eq('team_id', teamId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();

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
    throw new Error(`获取成员组失败：${getErrorMessage(error, '未知错误')}`);
  }

  return (data ?? []).map((group) => ({
    id: group.id,
    name: group.name,
  }));
}

export async function inviteMembers(input: InviteMembersInput): Promise<{ insertedCount: number }> {
  const normalizedRows = input.rows.map((row) => ({
    ...row,
    email: normalizeEmail(row.email),
  }));

  if (normalizedRows.length === 0) {
    return { insertedCount: 0 };
  }

  const seenEmails = new Set<string>();
  for (const row of normalizedRows) {
    if (seenEmails.has(row.email)) {
      throw new Error('同一批邀请中存在重复邮箱');
    }
    seenEmails.add(row.email);
  }

  const emails = normalizedRows.map((row) => row.email);
  const { data: rawProfiles, error: profilesError } = await supabase
    .from('profiles')
    .select('id, email')
    .in('email', emails);
  const profiles = (rawProfiles ?? null) as unknown as ProfileLookupRow[] | null;

  if (profilesError) {
    throw profilesError;
  }

  const profileMap = new Map(
    (profiles ?? [])
      .filter((profile) => profile.email)
      .map((profile) => [normalizeEmail(profile.email as string), profile.id]),
  );

  const discoveredUserIds = Array.from(new Set(normalizedRows
    .map((row) => profileMap.get(row.email))
    .filter((userId): userId is string => Boolean(userId))));

  if (discoveredUserIds.length > 0) {
    const { data: existingMembers, error: existingMembersError } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', input.teamId)
      .eq('status', 'active')
      .in('user_id', discoveredUserIds);

    if (existingMembersError) {
      throw existingMembersError;
    }

    if ((existingMembers ?? []).length > 0) {
      throw new Error('该用户已是团队成员');
    }
  }

  const invitations = normalizedRows.map((row) => ({
    team_id: input.teamId,
    invitee_email: row.email,
    invitee_user_id: profileMap.get(row.email) ?? null,
    role: row.role,
    group_id: row.groupId,
    invited_by: input.invitedBy,
    status: 'pending',
  }));

  const { error: invitationError } = await supabase.from('team_invitations').insert(invitations);
  if (invitationError) {
    throw invitationError;
  }

  return {
    insertedCount: invitations.length,
  };
}

export async function fetchTeamMembers(teamId: string): Promise<TeamMemberSummary[]> {
  const { data: rawData, error } = await supabase
    .from('team_members')
    .select('id, user_id, name, role, group_id, profiles(email), team_groups(name)')
    .eq('team_id', teamId)
    .eq('status', 'active');
  const data = (rawData ?? null) as unknown as TeamMemberRow[] | null;

  if (error) {
    throw error;
  }

  return (data ?? []).map((member) => ({
    id: member.id,
    userId: member.user_id,
    name: member.name ?? '',
    email: member.profiles?.email ?? '—',
    role: member.role,
    groupId: member.group_id,
    groupName: member.team_groups?.name ?? null,
  }));
}

export async function updateMember(
  memberId: string,
  input: { name: string; role: TeamRole; groupId: string | null },
): Promise<void> {
  const { error } = await supabase.from('team_members').update({
    name: input.name.trim(),
    role: input.role,
    group_id: input.groupId,
  }).eq('id', memberId);

  if (error) {
    throw error;
  }
}

export async function removeMember(memberId: string): Promise<void> {
  const { error } = await supabase.from('team_members').update({
    status: 'removed',
  }).eq('id', memberId);

  if (error) {
    throw error;
  }
}

export async function createGroup(input: {
  teamId: string;
  createdBy: string;
  name: string;
}): Promise<TeamGroupSummary> {
  const name = validateGroupName(input.name);

  const { data, error } = await supabase
    .from('team_groups')
    .insert({
      team_id: input.teamId,
      created_by: input.createdBy,
      name,
    })
    .select('id, name')
    .single();

  if (error || !data) {
    throw new Error(`创建成员组失败：${getErrorMessage(error, '未知错误')}`);
  }

  return {
    id: data.id,
    name: data.name,
  };
}

export async function updateGroup(groupId: string, name: string): Promise<void> {
  const trimmedName = validateGroupName(name);

  const { error } = await supabase.from('team_groups').update({
    name: trimmedName,
  }).eq('id', groupId);

  if (error) {
    throw error;
  }
}

export async function deleteGroup(groupId: string): Promise<void> {
  const { error } = await supabase.from('team_groups').delete().eq('id', groupId);

  if (error) {
    throw error;
  }
}

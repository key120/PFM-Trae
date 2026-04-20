-- 修复团队相关 RLS 递归与新建团队自举失败问题
-- 根因：原策略直接在 policy 中查询 team_members，自引用会导致 PostgREST 请求 500；
-- 同时 team_members insert 仅允许 admin 插入，导致新团队 owner 无法完成首条 admin 成员写入。

create or replace function public.is_team_member(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members
    where team_id = target_team_id
      and user_id = auth.uid()
      and status = 'active'
  );
$$;

create or replace function public.is_team_admin(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members
    where team_id = target_team_id
      and user_id = auth.uid()
      and role = 'admin'
      and status = 'active'
  );
$$;

revoke all on function public.is_team_member(uuid) from public;
revoke all on function public.is_team_admin(uuid) from public;
grant execute on function public.is_team_member(uuid) to authenticated;
grant execute on function public.is_team_admin(uuid) to authenticated;

drop policy if exists "team members can view their teams" on public.teams;
drop policy if exists "team admin can update team" on public.teams;
drop policy if exists "team members can view members" on public.team_members;
drop policy if exists "team admin can insert members" on public.team_members;
drop policy if exists "team admin or self can update members" on public.team_members;
drop policy if exists "team members can view groups" on public.team_groups;
drop policy if exists "team admin can insert groups" on public.team_groups;
drop policy if exists "team admin can update groups" on public.team_groups;
drop policy if exists "team admin can delete groups" on public.team_groups;
drop policy if exists "invitee or admin can view invitations" on public.team_invitations;
drop policy if exists "team admin can insert invitations" on public.team_invitations;
drop policy if exists "document owner or team member can view shares" on public.document_shares;

create policy "team members can view their teams"
  on public.teams for select
  using (
    auth.uid() = created_by
    or public.is_team_member(id)
  );

create policy "team admin can update team"
  on public.teams for update
  using (
    auth.uid() = created_by
    or public.is_team_admin(id)
  );

create policy "team members can view members"
  on public.team_members for select
  using (
    user_id = auth.uid()
    or public.is_team_member(team_id)
  );

create policy "team admin can insert members"
  on public.team_members for insert
  with check (
    public.is_team_admin(team_id)
    or (
      user_id = auth.uid()
      and role = 'admin'
      and status = 'active'
      and exists (
        select 1
        from public.teams t
        where t.id = team_id
          and t.created_by = auth.uid()
      )
    )
  );

create policy "team admin or self can update members"
  on public.team_members for update
  using (
    user_id = auth.uid()
    or public.is_team_admin(team_id)
  );

create policy "team members can view groups"
  on public.team_groups for select
  using (public.is_team_member(team_id));

create policy "team admin can insert groups"
  on public.team_groups for insert
  with check (public.is_team_admin(team_id));

create policy "team admin can update groups"
  on public.team_groups for update
  using (public.is_team_admin(team_id));

create policy "team admin can delete groups"
  on public.team_groups for delete
  using (public.is_team_admin(team_id));

create policy "invitee or admin can view invitations"
  on public.team_invitations for select
  using (
    invitee_user_id = auth.uid()
    or public.is_team_admin(team_id)
  );

create policy "team admin can insert invitations"
  on public.team_invitations for insert
  with check (public.is_team_admin(team_id));

create policy "document owner or team member can view shares"
  on public.document_shares for select
  using (
    shared_by = auth.uid()
    or public.is_team_member(team_id)
  );

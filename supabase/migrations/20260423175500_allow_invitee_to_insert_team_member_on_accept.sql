-- 允许受邀用户在接受邀请时，为自己创建对应的 team_members 记录

 drop policy if exists "team admin can insert members" on public.team_members;

create policy "team admin or invitee can insert members"
  on public.team_members for insert
  with check (
    public.is_team_admin(team_id)
    or (
      user_id = auth.uid()
      and status = 'active'
      and exists (
        select 1
        from public.team_invitations ti
        where ti.team_id = team_members.team_id
          and ti.invitee_user_id = auth.uid()
          and ti.status = 'accepted'
          and ti.role = team_members.role
          and coalesce(ti.group_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(team_members.group_id, '00000000-0000-0000-0000-000000000000'::uuid)
          and coalesce(ti.invited_by, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(team_members.invited_by, '00000000-0000-0000-0000-000000000000'::uuid)
      )
    )
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

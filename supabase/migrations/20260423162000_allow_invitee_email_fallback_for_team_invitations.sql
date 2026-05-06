-- 允许被邀请用户在 invitee_user_id 尚未回填时，按邮箱读取和处理自己的待处理邀请

drop policy if exists "invitee or admin can view invitations" on public.team_invitations;
drop policy if exists "invitee can update invitation status" on public.team_invitations;

create policy "invitee or admin can view invitations"
  on public.team_invitations for select
  using (
    invitee_user_id = auth.uid()
    or (
      status = 'pending'
      and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.email is not null
          and lower(p.email) = lower(team_invitations.invitee_email)
      )
    )
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

create policy "invitee can update invitation status"
  on public.team_invitations for update
  using (
    invitee_user_id = auth.uid()
    or (
      status = 'pending'
      and exists (
        select 1
        from public.profiles p
        where p.id = auth.uid()
          and p.email is not null
          and lower(p.email) = lower(team_invitations.invitee_email)
      )
    )
  );

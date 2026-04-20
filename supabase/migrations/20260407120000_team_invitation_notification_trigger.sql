-- 通过数据库触发器为团队邀请自动创建通知

drop trigger if exists team_invitation_notification_trigger on public.team_invitations;
drop function if exists public.handle_team_invitation_notification();

create function public.handle_team_invitation_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.invitee_user_id is null then
    return new;
  end if;

  insert into public.notifications (
    user_id,
    type,
    payload,
    is_read
  )
  values (
    new.invitee_user_id,
    'team_invitation',
    jsonb_build_object(
      'teamId', new.team_id,
      'inviteeEmail', new.invitee_email,
      'role', new.role,
      'groupId', new.group_id,
      'invitedBy', new.invited_by
    ),
    false
  );

  return new;
end;
$$;

revoke all on function public.handle_team_invitation_notification() from public;

create trigger team_invitation_notification_trigger
after insert on public.team_invitations
for each row
execute function public.handle_team_invitation_notification();

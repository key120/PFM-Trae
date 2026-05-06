-- 修复邀请通知 invitedBy 字段：写入邮箱并回填历史 UUID

create or replace function public.handle_team_invitation_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_team_name text;
  inviter_email text;
begin
  if new.invitee_user_id is null then
    return new;
  end if;

  select t.name into target_team_name
  from public.teams t
  where t.id = new.team_id;

  select p.email into inviter_email
  from public.profiles p
  where p.id = new.invited_by;

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
      'invitationId', new.id,
      'teamId', new.team_id,
      'teamName', coalesce(target_team_name, '未知团队'),
      'inviteeEmail', new.invitee_email,
      'role', new.role,
      'groupId', new.group_id,
      'invitedBy', coalesce(inviter_email, new.invited_by::text)
    ),
    false
  );

  return new;
end;
$$;

update public.notifications n
set payload = jsonb_set(n.payload, '{invitedBy}', to_jsonb(p.email), true)
from public.profiles p
where n.type = 'team_invitation'
  and n.payload ? 'invitedBy'
  and n.payload ->> 'invitedBy' = p.id::text
  and p.email is not null;

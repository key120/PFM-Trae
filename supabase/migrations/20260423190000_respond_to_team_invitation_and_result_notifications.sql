-- 邀请处理事务化：保留原通知状态并给邀请人写入结果通知

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('team_invitation', 'team_invitation_result'));

create or replace function public.respond_to_team_invitation(
  p_invitation_id uuid,
  p_action text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_id uuid;
  actor_email text;
  invitation_row public.team_invitations%rowtype;
  result_value text;
begin
  actor_id := auth.uid();
  if actor_id is null then
    raise exception '未授权';
  end if;

  if p_action not in ('accepted', 'rejected') then
    raise exception '无效邀请操作: %', p_action;
  end if;

  select p.email into actor_email
  from public.profiles p
  where p.id = actor_id;

  select * into invitation_row
  from public.team_invitations ti
  where ti.id = p_invitation_id
  for update;

  if not found then
    raise exception '邀请不存在';
  end if;

  if invitation_row.status <> 'pending' then
    raise exception '邀请已处理';
  end if;

  if invitation_row.invitee_user_id is not null then
    if invitation_row.invitee_user_id <> actor_id then
      raise exception '无权限处理该邀请';
    end if;
  else
    if actor_email is null or lower(actor_email) <> lower(invitation_row.invitee_email) then
      raise exception '无权限处理该邀请';
    end if;
  end if;

  update public.team_invitations
  set
    status = p_action,
    invitee_user_id = coalesce(invitee_user_id, actor_id)
  where id = invitation_row.id;

  update public.notifications n
  set
    is_read = true,
    payload = coalesce(n.payload, '{}'::jsonb) || jsonb_build_object('status', p_action)
  where n.user_id = actor_id
    and n.type = 'team_invitation'
    and (
      (n.payload ->> 'invitationId')::uuid = invitation_row.id
      or n.id = invitation_row.id
    );

  if p_action = 'accepted' then
    insert into public.team_members (
      team_id,
      user_id,
      role,
      group_id,
      invited_by,
      joined_at,
      status
    )
    select
      invitation_row.team_id,
      actor_id,
      invitation_row.role,
      invitation_row.group_id,
      invitation_row.invited_by,
      timezone('utc', now()),
      'active'
    where not exists (
      select 1
      from public.team_members tm
      where tm.team_id = invitation_row.team_id
        and tm.user_id = actor_id
        and tm.status = 'active'
    );
  end if;

  result_value := case when p_action = 'accepted' then 'accepted' else 'rejected' end;

  insert into public.notifications (
    user_id,
    type,
    payload,
    is_read
  )
  values (
    invitation_row.invited_by,
    'team_invitation_result',
    jsonb_build_object(
      'inviteeEmail', invitation_row.invitee_email,
      'result', result_value
    ),
    false
  );
end;
$$;

revoke all on function public.respond_to_team_invitation(uuid, text) from public;
grant execute on function public.respond_to_team_invitation(uuid, text) to authenticated;

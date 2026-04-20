-- 原子化创建团队与 owner 成员，避免 teams / team_members 分步写入造成孤儿团队

drop function if exists public.create_team_with_owner(text);

create or replace function public.create_team_with_owner(p_name text)
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_team_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authenticated user required';
  end if;

  if v_name = '' then
    raise exception '请输入团队名称';
  end if;

  insert into public.teams (name, created_by)
  values (v_name, v_user_id)
  returning teams.id into v_team_id;

  insert into public.team_members (
    team_id,
    user_id,
    role,
    status,
    joined_at
  )
  values (
    v_team_id,
    v_user_id,
    'admin',
    'active',
    timezone('utc', now())
  );

  return query
  select v_team_id, v_name;
end;
$$;

revoke all on function public.create_team_with_owner(text) from public;
grant execute on function public.create_team_with_owner(text) to authenticated;

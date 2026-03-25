-- ============================================================
-- 团队与共享管理：表结构 + RLS（第一部分：teams / team_groups / team_members / team_invitations）
-- ============================================================

-- 1. teams
create table if not exists public.teams (
  id uuid default uuid_generate_v4() primary key,
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc', now()) not null
);

alter table public.teams enable row level security;

create policy "team members can view their teams"
  on public.teams for select
  using (
    auth.uid() = created_by
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = id
        and tm.user_id = auth.uid()
        and tm.status = 'active'
    )
  );

create policy "authenticated users can create teams"
  on public.teams for insert
  with check (auth.uid() = created_by);

create policy "team admin can update team"
  on public.teams for update
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

-- ============================================================
-- 2. team_groups（依赖 team_members，需在 team_members 之后创建 RLS，此处先建表）
create table if not exists public.team_groups (
  id uuid default uuid_generate_v4() primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc', now()) not null
);

alter table public.team_groups enable row level security;

-- ============================================================
-- 3. team_members
create table if not exists public.team_members (
  id uuid default uuid_generate_v4() primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  name text,
  role text not null check (role in ('reader', 'editor', 'admin')),
  group_id uuid references public.team_groups(id) on delete set null,
  invited_by uuid references auth.users(id) on delete set null,
  joined_at timestamp with time zone,
  status text not null default 'pending' check (status in ('pending', 'active', 'removed')),
  created_at timestamp with time zone default timezone('utc', now()) not null
);

alter table public.team_members enable row level security;

create policy "team members can view members"
  on public.team_members for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.status = 'active'
    )
  );

create policy "team admin can insert members"
  on public.team_members for insert
  with check (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

create policy "team admin or self can update members"
  on public.team_members for update
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

-- 补充 team_groups 的 RLS（team_members 已建好后再加）
create policy "team members can view groups"
  on public.team_groups for select
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.status = 'active'
    )
  );

create policy "team admin can insert groups"
  on public.team_groups for insert
  with check (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

create policy "team admin can update groups"
  on public.team_groups for update
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

create policy "team admin can delete groups"
  on public.team_groups for delete
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

-- ============================================================
-- 4. team_invitations
create table if not exists public.team_invitations (
  id uuid default uuid_generate_v4() primary key,
  team_id uuid not null references public.teams(id) on delete cascade,
  invitee_email text not null,
  invitee_user_id uuid references auth.users(id) on delete set null,
  role text not null check (role in ('reader', 'editor', 'admin')),
  group_id uuid references public.team_groups(id) on delete set null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamp with time zone default timezone('utc', now()) not null
);

alter table public.team_invitations enable row level security;

create policy "invitee or admin can view invitations"
  on public.team_invitations for select
  using (
    invitee_user_id = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

create policy "team admin can insert invitations"
  on public.team_invitations for insert
  with check (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
        and tm.status = 'active'
    )
  );

create policy "invitee can update invitation status"
  on public.team_invitations for update
  using (invitee_user_id = auth.uid());

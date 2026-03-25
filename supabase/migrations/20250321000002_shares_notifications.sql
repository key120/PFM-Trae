-- ============================================================
-- 团队与共享管理：表结构 + RLS
-- 第二部分：document_shares / notifications
-- ============================================================

-- 5. document_shares
create table if not exists public.document_shares (
  id uuid default uuid_generate_v4() primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  shared_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamp with time zone default timezone('utc', now()) not null,
  unique (document_id, team_id)
);

alter table public.document_shares enable row level security;

create policy "document owner or team member can view shares"
  on public.document_shares for select
  using (
    shared_by = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = team_id
        and tm.user_id = auth.uid()
        and tm.status = 'active'
    )
  );

create policy "document owner can insert shares"
  on public.document_shares for insert
  with check (
    shared_by = auth.uid()
    and exists (
      select 1 from public.documents d
      where d.id = document_id
        and d.owner_id = auth.uid()
    )
  );

create policy "document owner can delete shares"
  on public.document_shares for delete
  using (
    shared_by = auth.uid()
  );

-- ============================================================
-- 6. notifications
create table if not exists public.notifications (
  id uuid default uuid_generate_v4() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('team_invitation')),
  payload jsonb not null default '{}',
  is_read boolean not null default false,
  created_at timestamp with time zone default timezone('utc', now()) not null
);

alter table public.notifications enable row level security;

create policy "users can view own notifications"
  on public.notifications for select
  using (user_id = auth.uid());

create policy "users can update own notifications"
  on public.notifications for update
  using (user_id = auth.uid());

-- 系统写入通知（通过 service_role 或 trigger），普通用户不能直接 insert
-- 如需前端直接写入，取消注释以下策略：
-- create policy "authenticated users can insert notifications"
--   on public.notifications for insert
--   with check (user_id = auth.uid());

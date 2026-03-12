-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. Create a table for public user profiles
create table public.profiles (
  id uuid not null references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  updated_at timestamp with time zone,
  
  primary key (id)
);

-- Enable Row Level Security (RLS)
alter table public.profiles enable row level security;

-- Create policies for profiles
create policy "Public profiles are viewable by everyone."
  on public.profiles for select
  using ( true );

create policy "Users can insert their own profile."
  on public.profiles for insert
  with check ( auth.uid() = id );

create policy "Users can update their own profile."
  on public.profiles for update
  using ( auth.uid() = id );

-- 2. Function and trigger to automatically create a profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id, 
    new.email, 
    new.raw_user_meta_data->>'full_name', 
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 3. Create a table for documents (metadata)
create table if not exists public.documents (
  id uuid default uuid_generate_v4() primary key,
  owner_id uuid references auth.users(id) not null,
  encrypted_title text,
  size bigint,
  type text,
  path text,
  metadata jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  deleted_at timestamp with time zone
);

-- Enable RLS for documents
alter table public.documents enable row level security;

-- Create policies for documents
create policy "Users can view their own documents."
  on public.documents for select
  using ( auth.uid() = owner_id );

create policy "Users can insert their own documents."
  on public.documents for insert
  with check ( auth.uid() = owner_id );

create policy "Users can update their own documents."
  on public.documents for update
  using ( auth.uid() = owner_id );

create policy "Users can delete their own documents."
  on public.documents for delete
  using ( auth.uid() = owner_id );

-- 4. Storage Policies (Assuming a bucket named 'documents' is created via Dashboard)
-- You need to create a bucket named 'documents' in the Supabase Dashboard -> Storage first.

-- Policy: Give users access to their own files
-- Note: These policies need to be applied to the storage.objects table
-- BUT usually you create these via the Storage Dashboard UI. 
-- Below is the SQL equivalent if you have permissions.

-- Allow authenticated uploads
create policy "Authenticated users can upload files"
on storage.objects for insert
to authenticated
with check ( bucket_id = 'documents' and auth.uid() = owner );

-- Allow users to view their own files
create policy "Users can view their own files"
on storage.objects for select
to authenticated
using ( bucket_id = 'documents' and auth.uid() = owner );

-- Allow users to update their own files
create policy "Users can update their own files"
on storage.objects for update
to authenticated
using ( bucket_id = 'documents' and auth.uid() = owner );

-- Allow users to delete their own files
create policy "Users can delete their own files"
on storage.objects for delete
to authenticated
using ( bucket_id = 'documents' and auth.uid() = owner );

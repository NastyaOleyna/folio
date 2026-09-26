-- Folio: run this once in Supabase → SQL Editor → New query → Run.
-- It creates the table for your planners, a folder for your pictures,
-- and rules so that only you can read or change your own data.

create table if not exists public.folio_docs (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key        text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.folio_docs enable row level security;

drop policy if exists "folio read own"   on public.folio_docs;
drop policy if exists "folio add own"    on public.folio_docs;
drop policy if exists "folio change own" on public.folio_docs;
drop policy if exists "folio delete own" on public.folio_docs;

create policy "folio read own"   on public.folio_docs for select to authenticated using (auth.uid() = user_id);
create policy "folio add own"    on public.folio_docs for insert to authenticated with check (auth.uid() = user_id);
create policy "folio change own" on public.folio_docs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "folio delete own" on public.folio_docs for delete to authenticated using (auth.uid() = user_id);

-- Pictures you paste into planners. Each file gets a long random name inside your own folder.
insert into storage.buckets (id, name, public)
values ('folio', 'folio', true)
on conflict (id) do nothing;

drop policy if exists "folio upload own pictures" on storage.objects;
drop policy if exists "folio delete own pictures" on storage.objects;

create policy "folio upload own pictures" on storage.objects for insert to authenticated
  with check (bucket_id = 'folio' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "folio delete own pictures" on storage.objects for delete to authenticated
  using (bucket_id = 'folio' and (storage.foldername(name))[1] = auth.uid()::text);

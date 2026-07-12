-- Michelle's Reading Library — Supabase schema
-- Paste this whole file into the Supabase SQL Editor (Dashboard → SQL Editor → New query) and Run.

-- ------------------------------------------------------------------
-- BOOKS
-- ------------------------------------------------------------------
create table if not exists public.books (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  title         text not null,
  authors       text[] default '{}',
  isbn          text,
  cover_url     text,
  genres        text[] default '{}',
  source        text default 'manual',   -- scan | kindle | nas | manual
  format        text default 'physical', -- physical | ebook
  status        text default 'unread',   -- unread | reading | finished
  rating        int,                     -- 1..10, null if unrated
  page_count    int,
  pages_read    int default 0,
  date_started  date,
  date_finished date,
  queue_pos     int,                     -- null = not in queue; lower = read sooner
  notes         text
);

-- ------------------------------------------------------------------
-- GOALS
-- ------------------------------------------------------------------
create table if not exists public.goals (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  metric     text not null,   -- books | pages
  target     int  not null,
  period     text not null,   -- year | month
  year       int  not null,
  month      int              -- 1..12 when period = 'month'
);

-- ------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ------------------------------------------------------------------
-- The app uses the public "anon" key, so we enable RLS and add permissive
-- policies for anon. This is fine for a personal, private-repo app. If you
-- later want real per-user protection, switch to Supabase Auth and scope
-- these policies to auth.uid().
alter table public.books enable row level security;
alter table public.goals enable row level security;

drop policy if exists "anon all books" on public.books;
create policy "anon all books" on public.books
  for all to anon using (true) with check (true);

drop policy if exists "anon all goals" on public.goals;
create policy "anon all goals" on public.goals
  for all to anon using (true) with check (true);

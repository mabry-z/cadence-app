-- Cadence: the whole schema for a fresh project (households, budgets,
-- invite-only sign-up). Applied once to the "cadence" Supabase project.
--
-- Money is stored in cents (bigint). Each household chooses whether amounts
-- are rounded to whole dollars (round_whole, on by default).
--
-- A pay period is identified by its nominal start date (the scheduled
-- payday, before any weekend/holiday shift) and runs until next_start, the
-- next scheduled payday. starts_on is the day the pay really arrived. The
-- app works out the schedule (js/paydays.js); the database only stores the
-- periods it has been asked to create and refuses overlaps.
--
-- Every table carries household_id, defaulting to the caller's household,
-- and row-level security limits every row to members of that household.
-- The publishable key alone (role anon) can do nothing but check an invite
-- code.

begin;

create extension if not exists btree_gist with schema extensions;

-- ============================================================
-- Households and members
-- ============================================================

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 60),
  round_whole boolean not null default true,
  -- {"kind":"semimonthly","days":[1,15]} | {"kind":"monthly","day":1}
  -- | {"kind":"biweekly","anchor":"2026-10-02"} | {"kind":"weekly","anchor":"2026-10-02"}
  -- Day 31 means the last day of the month.
  pay_schedule jsonb not null default '{"kind":"semimonthly","days":[1,15]}',
  starting_cents bigint not null default 0 check (starting_cents >= 0),
  carry_start date,                  -- Extra carries over from this period on; null = from the first
  setup_done boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade, -- one household per person
  role text not null default 'member' check (role in ('owner', 'member')),
  display_name text not null default '' check (length(display_name) <= 40),
  color text not null default '#7CA3F2',
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

-- People who may hand out codes for brand-new households.
create table public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Sign-up is invite-only. kind 'join' adds someone to an existing household;
-- kind 'household' lets someone start their own (made by an app admin).
create table public.invites (
  id bigint generated always as identity primary key,
  code text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  kind text not null check (kind in ('join', 'household')),
  household_id uuid references public.households(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  check ((kind = 'join') = (household_id is not null))
);

-- ============================================================
-- Who is calling
-- ============================================================

create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select household_id from household_members where user_id = auth.uid();
$$;

create or replace function public.require_household_id()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v uuid := current_household_id();
begin
  if v is null then
    raise exception 'This account isn''t part of a household yet.';
  end if;
  return v;
end;
$$;

create or replace function public.is_app_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from app_admins where user_id = auth.uid());
$$;

-- ============================================================
-- Budget tables
-- ============================================================

create table public.categories (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  color text not null default '#7CA3F2',
  default_cents bigint not null default 0 check (default_cents >= 0),
  sort_order integer not null default 0,
  is_active boolean not null default true,     -- false = archived; old expenses still point at it
  is_remainder boolean not null default false, -- true = Extra, whose amount is always calculated
  unique (id, household_id)
);
create unique index categories_one_remainder on public.categories (household_id) where is_remainder;

create table public.cards (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 30),
  kind text not null default 'other' check (kind in ('debit', 'credit', 'cash', 'other')),
  badge text not null check (length(badge) between 1 and 3),
  color text not null default '#4B535C' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order integer not null default 0,
  is_active boolean not null default true,     -- false = archived; past purchases keep it
  created_at timestamptz not null default now(),
  unique (id, household_id)
);

create table public.bill_templates (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 40),
  default_cents bigint not null default 0 check (default_cents >= 0),
  due_day integer not null check (due_day between 1 and 31), -- 31 = last day of the month
  is_active boolean not null default true,
  unique (id, household_id)
);

create table public.pay_periods (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  start_date date not null,          -- scheduled payday that opens it
  next_start date not null,          -- scheduled payday that opens the next one
  starts_on date,                    -- when the pay really arrived; null until confirmed
  starting_cents bigint not null check (starting_cents >= 0),
  created_at timestamptz not null default now(),
  check (next_start > start_date),
  unique (household_id, start_date),
  unique (id, household_id),
  exclude using gist (household_id with =, daterange(start_date, next_start) with &&)
);

create table public.period_categories (
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  period_id bigint not null,
  category_id bigint not null,
  amount_cents bigint not null check (amount_cents >= 0),
  emptied boolean not null default false,    -- leftover moved to Extra
  primary key (period_id, category_id),
  foreign key (period_id, household_id) references public.pay_periods(id, household_id) on delete cascade,
  foreign key (category_id, household_id) references public.categories(id, household_id) on delete cascade
);

create table public.fixed_costs (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  period_id bigint not null,
  template_id bigint references public.bill_templates(id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 40),
  amount_cents bigint not null check (amount_cents >= 0),
  due_date date,
  is_paid boolean not null default false,
  foreign key (period_id, household_id) references public.pay_periods(id, household_id) on delete cascade
);
create unique index fixed_costs_template_once on public.fixed_costs (period_id, template_id, due_date)
  where template_id is not null;

create table public.expenses (
  id bigint generated always as identity primary key,
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  period_id bigint not null,
  category_id bigint not null,
  card_id bigint,
  merchant text not null check (length(trim(merchant)) between 1 and 100),
  amount_cents bigint not null check (amount_cents > 0),
  transaction_type text not null default 'expense' check (transaction_type in ('expense', 'refund')),
  from_savings boolean not null default false, -- shown, never counted
  source text not null default 'manual',       -- room for imported purchases later
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (period_id, household_id) references public.pay_periods(id, household_id),
  foreign key (category_id, household_id) references public.categories(id, household_id),
  foreign key (card_id, household_id) references public.cards(id, household_id)
);
create index expenses_period on public.expenses (period_id);
create index expenses_household_created on public.expenses (household_id, created_at);

create table public.hidden_merchants (
  household_id uuid not null default public.current_household_id() references public.households(id) on delete cascade,
  merchant_key text not null check (merchant_key <> ''),
  created_at timestamptz not null default now(),
  primary key (household_id, merchant_key)
);

create index on public.categories (household_id);
create index on public.cards (household_id);
create index on public.bill_templates (household_id);
create index on public.period_categories (household_id);
create index period_categories_period_household on public.period_categories (period_id, household_id);
create index on public.period_categories (category_id, household_id);
create index on public.fixed_costs (household_id);
create index on public.fixed_costs (period_id, household_id);
create index on public.fixed_costs (template_id);
create index on public.expenses (period_id, household_id);
create index on public.expenses (category_id, household_id);
create index on public.expenses (card_id, household_id);
create index on public.expenses (created_by);
create index on public.invites (household_id);
create index on public.invites (created_by);
create index on public.invites (used_by);

-- ============================================================
-- Row-level security
-- ============================================================

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.app_admins enable row level security;
alter table public.invites enable row level security;
alter table public.categories enable row level security;
alter table public.cards enable row level security;
alter table public.bill_templates enable row level security;
alter table public.pay_periods enable row level security;
alter table public.period_categories enable row level security;
alter table public.fixed_costs enable row level security;
alter table public.expenses enable row level security;
alter table public.hidden_merchants enable row level security;

create policy "own household" on public.households
  for select to authenticated using (id = (select public.current_household_id()));
create policy "own household" on public.household_members
  for select to authenticated using (household_id = (select public.current_household_id()));
create policy "own household" on public.invites
  for select to authenticated using (household_id = (select public.current_household_id())
                                     or created_by = (select auth.uid()));
-- app_admins: no policy, so nobody reads it directly (is_app_admin() does).

do $$
declare
  t text;
begin
  foreach t in array array['categories', 'cards', 'bill_templates', 'pay_periods',
                           'period_categories', 'fixed_costs', 'expenses', 'hidden_merchants'] loop
    execute format('create policy "household members" on public.%I for all to authenticated '
                   'using (household_id = (select public.current_household_id())) '
                   'with check (household_id = (select public.current_household_id()))', t);
  end loop;
end;
$$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.households, public.household_members, public.invites,
  public.categories, public.bill_templates, public.pay_periods, public.fixed_costs
  to authenticated;
grant select, insert, update, delete on public.cards, public.expenses, public.hidden_merchants
  to authenticated;
grant select, update (emptied) on public.period_categories to authenticated;
grant update (is_paid) on public.fixed_costs to authenticated;

-- Functions are reachable only where granted below.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ============================================================
-- Invites and sign-up
-- ============================================================

-- A fresh unused code: 6 characters, no look-alikes (0/O, 1/I/L).
create or replace function public.new_invite_code()
returns text
language plpgsql
set search_path = public
as $$
declare
  v_chars constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v text;
begin
  loop
    v := '';
    for i in 1..6 loop
      v := v || substr(v_chars, 1 + floor(random() * length(v_chars))::integer, 1);
    end loop;
    exit when not exists (select 1 from invites where code = v);
  end loop;
  return v;
end;
$$;

create or replace function public.normalize_code(p_code text)
returns text
language sql
immutable
set search_path = public
as $$
  select upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

-- What a code is for, if it's usable: { kind, household_name } or null.
-- Anyone may ask (the sign-up form checks the code before creating the account).
create or replace function public.check_invite(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('kind', i.kind, 'household_name', h.name)
  from invites i
  left join households h on h.id = i.household_id
  where i.code = normalize_code(p_code) and i.used_at is null and i.expires_at > now();
$$;

-- Supabase Auth calls this before creating any account (Authentication →
-- Hooks → Before User Created). No usable invite code, no account.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if check_invite(event->'user'->'user_metadata'->>'invite_code') is null then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'Cadence is invite-only. Ask someone in your household for an invite code.'));
  end if;
  return '{}'::jsonb;
end;
$$;

grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

-- Member dot colours, handed out in joining order.
create or replace function public.member_color(p_household uuid)
returns text
language sql
stable
set search_path = public
as $$
  select (array['#7CA3F2', '#E39BB0', '#F2A65C', '#5BC7A6', '#B69CF2', '#F2D56B'])
         [1 + (select count(*) from household_members where household_id = p_household)::integer % 6];
$$;

-- Starts a household. Needs a 'household' invite code, unless the caller is
-- an app admin. Adds Extra; everything else is set up in onboarding.
create or replace function public.create_household(p_name text, p_display_name text, p_code text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid;
  v_invite invites;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if current_household_id() is not null then
    raise exception 'You''re already in a household.';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Give your household a name.';
  end if;

  if not is_app_admin() then
    select * into v_invite from invites
    where code = normalize_code(p_code) and kind = 'household'
      and used_at is null and expires_at > now()
    for update;
    if not found then
      raise exception 'That invite code can''t be used to start a household.';
    end if;
  end if;

  insert into households (name) values (trim(p_name)) returning id into v_household;
  insert into household_members (household_id, user_id, role, display_name, color)
  values (v_household, auth.uid(), 'owner', left(trim(coalesce(p_display_name, '')), 40), '#7CA3F2');
  insert into categories (household_id, name, color, sort_order, is_remainder)
  values (v_household, 'Extra', '#5BC7A6', 99, true);

  if v_invite.id is not null then
    update invites set used_by = auth.uid(), used_at = now() where id = v_invite.id;
  end if;
  return v_household;
end;
$$;

create or replace function public.join_household(p_code text, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  if current_household_id() is not null then
    raise exception 'You''re already in a household.';
  end if;

  select * into v_invite from invites
  where code = normalize_code(p_code) and kind = 'join'
    and used_at is null and expires_at > now()
  for update;
  if not found then
    raise exception 'That invite code isn''t valid any more. Ask for a new one.';
  end if;

  insert into household_members (household_id, user_id, role, display_name, color)
  values (v_invite.household_id, auth.uid(), 'member', left(trim(coalesce(p_display_name, '')), 40),
          member_color(v_invite.household_id));
  update invites set used_by = auth.uid(), used_at = now() where id = v_invite.id;
  return v_invite.household_id;
end;
$$;

-- A code for a partner to join the caller's household. Reuses the current
-- unused one, so the code doesn't change every time Settings is opened.
create or replace function public.create_join_code()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
  v invites;
begin
  select * into v from invites
  where household_id = v_household and kind = 'join' and used_at is null
    and expires_at > now() + interval '1 day'
  order by created_at desc limit 1;
  if not found then
    insert into invites (code, kind, household_id, created_by)
    values (new_invite_code(), 'join', v_household, auth.uid())
    returning * into v;
  end if;
  return jsonb_build_object('code', v.code, 'expires_at', v.expires_at);
end;
$$;

-- A code for someone to start their own household. App admins only.
create or replace function public.create_household_code()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v invites;
begin
  if not is_app_admin() then
    raise exception 'Only the app''s admin can invite new households.';
  end if;
  insert into invites (code, kind, created_by, expires_at)
  values (new_invite_code(), 'household', auth.uid(), now() + interval '30 days')
  returning * into v;
  return jsonb_build_object('code', v.code, 'expires_at', v.expires_at);
end;
$$;

-- Everything Settings and the app shell need about the household.
create or replace function public.household_info()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', h.id,
    'name', h.name,
    'role', me.role,
    'round_whole', h.round_whole,
    'pay_schedule', h.pay_schedule,
    'starting_cents', h.starting_cents,
    'carry_start', h.carry_start,
    'setup_done', h.setup_done,
    'is_admin', is_app_admin(),
    'members', (
      select jsonb_agg(jsonb_build_object(
               'user_id', m.user_id, 'email', u.email, 'display_name', m.display_name,
               'color', m.color, 'role', m.role, 'is_me', m.user_id = auth.uid())
             order by m.created_at)
      from household_members m
      join auth.users u on u.id = m.user_id
      where m.household_id = h.id))
  from household_members me
  join households h on h.id = me.household_id
  where me.user_id = auth.uid();
$$;

-- Name, rounding, paycheck default and "setup finished".
create or replace function public.update_household(
  p_name text default null, p_round_whole boolean default null,
  p_starting_cents bigint default null, p_setup_done boolean default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
begin
  if p_name is not null and trim(p_name) = '' then
    raise exception 'Give your household a name.';
  end if;
  if p_starting_cents is not null and p_starting_cents < 0 then
    raise exception 'The paycheck amount can''t be negative.';
  end if;
  update households set
    name = coalesce(trim(p_name), name),
    round_whole = coalesce(p_round_whole, round_whole),
    starting_cents = coalesce(p_starting_cents, starting_cents),
    setup_done = coalesce(p_setup_done, setup_done)
  where id = v_household;
end;
$$;

create or replace function public.update_my_name(p_display_name text)
returns void
language sql
security definer
set search_path = public
as $$
  update household_members set display_name = left(trim(coalesce(p_display_name, '')), 40)
  where user_id = auth.uid();
$$;

-- ============================================================
-- Bills: which template falls in which period
-- ============================================================

-- The dates a bill due on p_due_day (31 = last day) falls on in [p_start, p_next).
create or replace function public.bill_due_dates(p_due_day integer, p_start date, p_next date)
returns setof date
language sql
immutable
set search_path = public
as $$
  select d
  from generate_series(date_trunc('month', p_start), date_trunc('month', p_next - 1), interval '1 month') as m(month),
       lateral (select m.month::date
                       + least(p_due_day, extract(day from m.month + interval '1 month' - interval '1 day')::integer)
                       - 1 as d) x
  where d >= p_start and d < p_next;
$$;

-- Brings the template bills of the given periods in line with the templates:
-- unpaid rows that no longer fit are removed, the rest renamed/repriced, and
-- missing ones added. Paid rows are left alone.
create or replace function public.sync_template_bills(p_household uuid, p_period_ids bigint[])
returns void
language plpgsql
set search_path = public
as $$
begin
  delete from fixed_costs fc
  using pay_periods pp
  where fc.household_id = p_household and fc.template_id is not null and not fc.is_paid
    and pp.id = fc.period_id and pp.id = any (p_period_ids)
    and not exists (
      select 1 from bill_templates t
      where t.id = fc.template_id and t.is_active
        and fc.due_date in (select bill_due_dates(t.due_day, pp.start_date, pp.next_start)));

  update fixed_costs fc
  set name = t.name, amount_cents = t.default_cents
  from bill_templates t
  where fc.household_id = p_household and fc.period_id = any (p_period_ids)
    and t.id = fc.template_id and t.is_active and not fc.is_paid;

  insert into fixed_costs (household_id, period_id, template_id, name, amount_cents, due_date)
  select p_household, pp.id, t.id, t.name, t.default_cents, d
  from pay_periods pp
  join bill_templates t on t.household_id = p_household and t.is_active
  cross join lateral bill_due_dates(t.due_day, pp.start_date, pp.next_start) d
  where pp.household_id = p_household and pp.id = any (p_period_ids)
    and not exists (
      select 1 from fixed_costs fc
      where fc.period_id = pp.id and fc.template_id = t.id and fc.due_date = d);
end;
$$;

-- ============================================================
-- Periods
-- ============================================================

-- Creates the period [p_start, p_next) from the household's defaults the
-- first time it's opened. p_starts_on: only for the very first period.
create or replace function public.ensure_period(p_start date, p_next date, p_starts_on date default null)
returns public.pay_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
  v pay_periods;
begin
  select * into v from pay_periods where household_id = v_household and start_date = p_start;
  if found then
    return v;
  end if;
  if p_next is null or p_next <= p_start or p_next > p_start + 62 then
    raise exception 'That isn''t a valid pay period.';
  end if;
  if p_starts_on is not null and exists (select 1 from pay_periods where household_id = v_household) then
    p_starts_on := null; -- only the first period starts itself
  end if;

  begin
    insert into pay_periods (household_id, start_date, next_start, starts_on, starting_cents)
    select v_household, p_start, p_next, p_starts_on, h.starting_cents
    from households h where h.id = v_household
    returning * into v;
  exception when unique_violation or exclusion_violation then
    select * into v from pay_periods where household_id = v_household and start_date = p_start;
    if found then
      return v; -- another phone created it at the same moment
    end if;
    raise exception 'That period overlaps one that already exists.';
  end;

  insert into period_categories (household_id, period_id, category_id, amount_cents)
  select v_household, v.id, c.id, c.default_cents
  from categories c
  where c.household_id = v_household and c.is_active and not c.is_remainder;

  perform sync_template_bills(v_household, array[v.id]);
  return v;
end;
$$;

-- Confirms the day a period's pay really arrived.
create or replace function public.start_period(p_period_id bigint, p_starts_on date)
returns public.pay_periods
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
  v pay_periods;
  v_prev pay_periods;
  v_next pay_periods;
begin
  if p_starts_on is null then
    raise exception 'Pick the date the period started.';
  end if;
  select * into v from pay_periods where id = p_period_id and household_id = v_household;
  if not found then
    raise exception 'That period wasn''t found.';
  end if;
  if abs(p_starts_on - v.start_date) > 10 then
    raise exception 'That date is too far from this period''s normal payday.';
  end if;

  select * into v_prev from pay_periods
  where household_id = v_household and start_date < v.start_date
  order by start_date desc limit 1;
  if found then
    if v_prev.starts_on is null then
      raise exception 'Start the previous pay period first.';
    end if;
    if p_starts_on <= v_prev.starts_on then
      raise exception 'This period has to start after %, when the previous one started.',
        to_char(v_prev.starts_on, 'Mon FMDD');
    end if;
  end if;

  select * into v_next from pay_periods
  where household_id = v_household and start_date > v.start_date and starts_on is not null
  order by start_date limit 1;
  if found and p_starts_on >= v_next.starts_on then
    raise exception 'This period has to start before %, when the next one started.',
      to_char(v_next.starts_on, 'Mon FMDD');
  end if;

  update pay_periods set starts_on = p_starts_on where id = v.id returning * into v;
  return v;
end;
$$;

-- Saves a new pay schedule. Periods already created stay as they are, except
-- p_period_id (the current one), which now ends at p_next_start; periods
-- after it are removed (refused if any has expenses) and made again from the
-- new schedule as they're opened.
create or replace function public.set_pay_schedule(p_schedule jsonb, p_period_id bigint default null,
                                                   p_next_start date default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
  v pay_periods;
  v_count integer;
begin
  if p_schedule->>'kind' not in ('semimonthly', 'monthly', 'biweekly', 'weekly') then
    raise exception 'Pick how often you''re paid.';
  end if;
  update households set pay_schedule = p_schedule where id = v_household;
  if p_period_id is null then
    return;
  end if;

  select * into v from pay_periods where id = p_period_id and household_id = v_household;
  if not found then
    raise exception 'That period wasn''t found.';
  end if;
  if p_next_start is null or p_next_start <= v.start_date or p_next_start > v.start_date + 62 then
    raise exception 'That doesn''t fit this period.';
  end if;

  select count(*) into v_count
  from expenses e join pay_periods pp on pp.id = e.period_id
  where pp.household_id = v_household and pp.start_date > v.start_date;
  if v_count > 0 then
    raise exception 'Later periods already have % expense(s). Move or delete them first.', v_count;
  end if;

  delete from pay_periods where household_id = v_household and start_date > v.start_date;
  update pay_periods set next_start = p_next_start where id = v.id;
  perform sync_template_bills(v_household, array[v.id]);
end;
$$;

-- ============================================================
-- save_settings
--
-- Past period (starts before p_today_start): changes only that period —
--   its paycheck, category amounts, and its own bills (p_fixed rows by id).
-- Current/future period: changes the defaults, that period and every later
--   period that already exists; p_fixed is the full list of recurring bills
--   ({template_id, name, amount, due_day}). Earlier periods never change.
-- Amounts are cents.
-- ============================================================

create or replace function public.save_settings(
  p_period_id bigint,
  p_today_start date,
  p_starting bigint,
  p_categories jsonb,
  p_fixed jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household uuid := require_household_id();
  v pay_periods;
  r jsonb;
  v_id bigint;
  v_name text;
  v_amount bigint;
  v_sort integer := 0;
  v_count integer;
  v_keep_cats bigint[] := '{}';
  v_keep bigint[] := '{}';
  v_later bigint[];
begin
  if p_starting is null or p_starting < 0 then
    raise exception 'The paycheck amount must be 0 or more.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_categories || p_fixed) e
             where coalesce(trim(e->>'name'), '') = ''
                or e->>'amount' is null
                or (e->>'amount')::bigint < 0) then
    raise exception 'Every row needs a name and an amount of 0 or more.';
  end if;

  select min(trim(e->>'name')) into v_name
  from jsonb_array_elements(p_categories) e
  group by lower(trim(e->>'name')) having count(*) > 1 limit 1;
  if v_name is null then
    select trim(e->>'name') into v_name
    from jsonb_array_elements(p_categories) e
    join categories c on c.household_id = v_household and c.is_remainder
     and lower(c.name) = lower(trim(e->>'name'))
    limit 1;
  end if;
  if v_name is not null then
    raise exception 'Category names must be unique (and not "Extra"): %', v_name;
  end if;

  select min(trim(e->>'name')) into v_name
  from jsonb_array_elements(p_fixed) e
  group by lower(trim(e->>'name')) having count(*) > 1 limit 1;
  if v_name is not null then
    raise exception 'Bill names must be unique: %', v_name;
  end if;

  select * into v from pay_periods where id = p_period_id and household_id = v_household;
  if not found then
    raise exception 'That period wasn''t found.';
  end if;

  -- ---------- past period: this period only ----------
  if v.start_date < p_today_start then
    update pay_periods set starting_cents = p_starting where id = v.id;

    for r in select value from jsonb_array_elements(p_categories) loop
      update period_categories set amount_cents = (r->>'amount')::bigint
      where period_id = v.id and category_id = (r->>'id')::bigint;
    end loop;

    for r in select value from jsonb_array_elements(p_fixed) loop
      v_id := null;
      if r->>'id' is not null then
        update fixed_costs set name = trim(r->>'name'), amount_cents = (r->>'amount')::bigint
        where id = (r->>'id')::bigint and period_id = v.id
        returning id into v_id;
      else
        insert into fixed_costs (household_id, period_id, name, amount_cents)
        values (v_household, v.id, trim(r->>'name'), (r->>'amount')::bigint)
        returning id into v_id;
      end if;
      if v_id is not null then
        v_keep := v_keep || v_id;
      end if;
    end loop;

    delete from fixed_costs where period_id = v.id and id <> all (v_keep);
    return;
  end if;

  -- ---------- current/future period: defaults + this period onward ----------
  select coalesce(array_agg(id), '{}') into v_later
  from pay_periods where household_id = v_household and start_date >= v.start_date;

  update households set starting_cents = p_starting where id = v_household;
  update pay_periods set starting_cents = p_starting where id = any (v_later);

  -- Categories
  for r in select value from jsonb_array_elements(p_categories) loop
    v_sort := v_sort + 1;
    v_name := trim(r->>'name');
    v_amount := (r->>'amount')::bigint;

    if r->>'id' is null then
      insert into categories (household_id, name, color, default_cents, sort_order)
      values (v_household, v_name, coalesce(r->>'color', '#7CA3F2'), v_amount, v_sort)
      returning id into v_id;
    else
      v_id := (r->>'id')::bigint;
      update categories
      set name = v_name, default_cents = v_amount, sort_order = v_sort, is_active = true
      where id = v_id and household_id = v_household and not is_remainder;
      if not found then
        raise exception 'Category % wasn''t found.', v_name;
      end if;
    end if;
    v_keep_cats := v_keep_cats || v_id;

    insert into period_categories (household_id, period_id, category_id, amount_cents)
    select v_household, pid, v_id, v_amount from unnest(v_later) pid
    on conflict (period_id, category_id) do update set amount_cents = excluded.amount_cents;
  end loop;

  -- Categories left out of the list
  for v_id, v_name in
    select c.id, c.name from categories c
    where c.household_id = v_household and c.is_active and not c.is_remainder
      and c.id <> all (v_keep_cats)
  loop
    select count(*) into v_count from expenses e
    where e.household_id = v_household and e.category_id = v_id and e.period_id = any (v_later);
    if v_count > 0 then
      raise exception 'Can''t remove %: it has % expense(s) in this or a later period. Move or delete them first.',
        v_name, v_count;
    end if;
    update categories set is_active = false where id = v_id;
    delete from period_categories where category_id = v_id and period_id = any (v_later);
  end loop;

  -- Recurring bills
  for r in select value from jsonb_array_elements(p_fixed) loop
    v_name := trim(r->>'name');
    v_amount := (r->>'amount')::bigint;
    if coalesce((r->>'due_day')::integer, 0) not between 1 and 31 then
      raise exception '%: pick the day it''s due.', v_name;
    end if;
    v_id := (r->>'template_id')::bigint;
    if v_id is null then
      insert into bill_templates (household_id, name, default_cents, due_day)
      values (v_household, v_name, v_amount, (r->>'due_day')::integer)
      returning id into v_id;
    else
      update bill_templates
      set name = v_name, default_cents = v_amount, due_day = (r->>'due_day')::integer, is_active = true
      where id = v_id and household_id = v_household;
      if not found then
        raise exception 'Bill % wasn''t found.', v_name;
      end if;
    end if;
    v_keep := v_keep || v_id;
  end loop;

  update bill_templates set is_active = false
  where household_id = v_household and is_active and id <> all (v_keep);

  perform sync_template_bills(v_household, v_later);
end;
$$;

-- ============================================================
-- Extra carried into each period (savings purchases never count)
-- ============================================================

create or replace view public.period_extra_carry
with (security_invoker = true)
as
with cat_spend as (
  select e.period_id, e.category_id,
         sum(case when e.transaction_type = 'refund' then -e.amount_cents else e.amount_cents end) as spent
  from expenses e
  where not e.from_savings
  group by e.period_id, e.category_id
),
budgets as (
  select pc.period_id,
         sum(case when pc.emptied
                  then greatest(0, least(pc.amount_cents, coalesce(cs.spent, 0)))
                  else pc.amount_cents end) as total
  from period_categories pc
  left join cat_spend cs on cs.period_id = pc.period_id and cs.category_id = pc.category_id
  group by pc.period_id
),
fixed as (
  select period_id, sum(amount_cents) as total from fixed_costs group by period_id
),
extra_spend as (
  select cs.period_id, sum(cs.spent) as total
  from cat_spend cs
  where not exists (
    select 1 from period_categories pc
    where pc.period_id = cs.period_id and pc.category_id = cs.category_id)
  group by cs.period_id
),
leftover as (
  select pp.id, pp.household_id, pp.start_date,
         pp.starting_cents - coalesce(f.total, 0) - coalesce(b.total, 0) - coalesce(x.total, 0) as extra_left
  from pay_periods pp
  join households h on h.id = pp.household_id
  left join fixed f on f.period_id = pp.id
  left join budgets b on b.period_id = pp.id
  left join extra_spend x on x.period_id = pp.id
  where h.carry_start is null or pp.start_date >= h.carry_start
)
select id as period_id,
       coalesce(sum(extra_left) over (partition by household_id order by start_date
                                      rows between unbounded preceding and 1 preceding), 0)::bigint
         as carry_in
from leftover;

grant select on public.period_extra_carry to authenticated;

-- ============================================================
-- Leaving: delete my account (App Store rule)
-- ============================================================

-- Removes the caller's login. The last member out takes the household's
-- budget with them; otherwise the oldest remaining member becomes owner.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_household uuid := current_household_id();
  v_next uuid;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;
  if v_household is not null then
    select user_id into v_next from household_members
    where household_id = v_household and user_id <> v_uid
    order by created_at limit 1;
    if v_next is null then
      delete from households where id = v_household;
    else
      update household_members set role = 'owner'
      where user_id = v_next
        and (select role from household_members where user_id = v_uid) = 'owner';
    end if;
  end if;
  delete from auth.users where id = v_uid;
end;
$$;

-- ============================================================
-- Who may call what
-- ============================================================

revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.check_invite(text) to anon, authenticated;
grant execute on function
  public.current_household_id(),
  public.require_household_id(),
  public.is_app_admin(),
  public.create_household(text, text, text),
  public.join_household(text, text),
  public.create_join_code(),
  public.create_household_code(),
  public.household_info(),
  public.update_household(text, boolean, bigint, boolean),
  public.update_my_name(text),
  public.ensure_period(date, date, date),
  public.start_period(bigint, date),
  public.set_pay_schedule(jsonb, bigint, date),
  public.save_settings(bigint, date, bigint, jsonb, jsonb),
  public.delete_my_account()
to authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

commit;

notify pgrst, 'reload schema';

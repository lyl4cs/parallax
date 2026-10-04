-- Parallax core schema
-- Design rule: trade activity is an append-only event log. Positions are derived from it,
-- never edited in place, so every follower order traces back to the leader fill that caused it.

create extension if not exists "pgcrypto";

-- A trader account at the broker (Tradovate). role decides leader vs follower.
create table accounts (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null,                          -- auth.users.id in Supabase
  broker          text not null default 'tradovate',
  broker_account  text not null,                          -- the broker's own account id
  role            text not null check (role in ('leader', 'follower')),
  environment     text not null default 'demo' check (environment in ('demo', 'live')),
  created_at      timestamptz not null default now(),
  unique (broker, broker_account)
);

-- Which follower copies which leader, and how.
create table copy_rules (
  id                   uuid primary key default gen_random_uuid(),
  leader_account_id    uuid not null references accounts(id) on delete cascade,
  follower_account_id  uuid not null references accounts(id) on delete cascade,
  multiplier           numeric(10, 4) not null default 1 check (multiplier > 0),
  max_contracts        integer check (max_contracts is null or max_contracts > 0),  -- cap on |position|
  active               boolean not null default true,
  created_at           timestamptz not null default now(),
  unique (leader_account_id, follower_account_id),
  check (leader_account_id <> follower_account_id)
);

-- Every fill seen on a leader account, exactly once.
create table leader_fills (
  id                  uuid primary key default gen_random_uuid(),
  leader_account_id   uuid not null references accounts(id) on delete cascade,
  broker_fill_id      text not null,                    -- the broker's id for this fill
  symbol              text not null,                    -- e.g. 'MNQZ6'
  side                text not null check (side in ('buy', 'sell')),
  qty                 integer not null check (qty > 0),
  price               numeric(18, 6) not null,
  filled_at           timestamptz not null,             -- exchange time
  received_at         timestamptz not null default now(),  -- when the worker saw it
  unique (leader_account_id, broker_fill_id)
);

-- The follower order caused by one leader fill. THE idempotency guarantee lives here:
-- unique (leader_fill_id, follower_account_id) means a fill is acted on at most once per follower,
-- however many times the worker restarts or the websocket redelivers.
create table copy_events (
  id                   uuid primary key default gen_random_uuid(),
  leader_fill_id       uuid not null references leader_fills(id) on delete cascade,
  follower_account_id  uuid not null references accounts(id) on delete cascade,
  client_order_id      text not null unique,            -- deterministic, sent to the broker
  symbol               text not null,
  side                 text not null check (side in ('buy', 'sell')),
  qty                  integer not null check (qty >= 0),  -- 0 only for 'skipped'
  status               text not null check (status in ('pending', 'placed', 'failed', 'skipped')),
  broker_order_id      text,
  error                text,
  attempts             integer not null default 0,
  placed_at            timestamptz,
  latency_ms           numeric(12, 3),                  -- worker received fill -> broker acked copy
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (leader_fill_id, follower_account_id),
  check (status <> 'skipped' or qty = 0),
  check (status = 'skipped' or qty > 0)
);

create index copy_events_open_idx on copy_events (created_at) where status in ('pending', 'failed');
create index copy_events_position_idx on copy_events (follower_account_id, symbol);
create index leader_fills_position_idx on leader_fills (leader_account_id, symbol);

-- Net positions, derived. Views, not tables, so they can never drift from the event log.
create view leader_positions as
select leader_account_id as account_id, symbol,
       sum(case when side = 'buy' then qty else -qty end)::int as net_qty
from leader_fills
group by leader_account_id, symbol;

create view follower_positions as
select follower_account_id as account_id, symbol,
       sum(case when side = 'buy' then qty else -qty end)::int as net_qty
from copy_events
where status = 'placed'
group by follower_account_id, symbol;

-- Copy latency percentiles over the last 24h, for the dashboard and for honest numbers.
create view copy_latency_24h as
select count(*)                                                        as copies,
       percentile_cont(0.5)  within group (order by latency_ms)        as p50_ms,
       percentile_cont(0.95) within group (order by latency_ms)        as p95_ms,
       percentile_cont(0.99) within group (order by latency_ms)        as p99_ms,
       max(latency_ms)                                                 as max_ms
from copy_events
where latency_ms is not null and placed_at > now() - interval '24 hours';

-- Row-level security: dashboard users read only their own rows. The worker connects as the
-- service role / database owner and bypasses RLS. Writes from users go through /api/rules.
alter table accounts      enable row level security;
alter table copy_rules    enable row level security;
alter table leader_fills  enable row level security;
alter table copy_events   enable row level security;

create policy own_accounts on accounts
  for select using (owner_id = auth.uid());

create policy own_rules on copy_rules
  for select using (
    exists (select 1 from accounts a where a.id = copy_rules.follower_account_id and a.owner_id = auth.uid())
    or exists (select 1 from accounts a where a.id = copy_rules.leader_account_id and a.owner_id = auth.uid())
  );

create policy own_fills on leader_fills
  for select using (
    exists (select 1 from accounts a where a.id = leader_fills.leader_account_id and a.owner_id = auth.uid())
  );

create policy own_events on copy_events
  for select using (
    exists (select 1 from accounts a where a.id = copy_events.follower_account_id and a.owner_id = auth.uid())
  );

-- Views run with the caller's permissions so RLS applies through them (Postgres 15+).
alter view leader_positions   set (security_invoker = true);
alter view follower_positions set (security_invoker = true);
alter view copy_latency_24h   set (security_invoker = true);

-- Supabase Realtime: push copy status changes to the dashboard as they happen.
alter publication supabase_realtime add table copy_events, leader_fills;

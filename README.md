# Parallax

Futures trade copying for Tradovate. When a leader account fills, Parallax mirrors the position onto follower accounts, scaled and capped per follower, exactly once, and recovers on its own from crashes, disconnects and broker errors.

```
Tradovate user-sync WebSocket ──fill──▶ worker (Railway / Fly.io, long-running)
                                           │ one queue, one consumer
                                           ├──▶ Tradovate REST /order/placeorder
                                           └──▶ Supabase Postgres (event log)
                                                        │ Realtime
Dashboard (Vercel static) ◀─────────────────────────────┘
   └──▶ /api/rules  (Vercel Python function: create / pause copy rules)
```

The worker is **not** on Vercel. Serverless functions time out, and a copier needs one WebSocket held open all session.

## Repo layout

| Path | What it is |
|---|---|
| `worker/` | Python copy engine, Tradovate client, tests. The core of the project. |
| `supabase/migrations/` | Postgres schema |
| `dashboard/` | Live dashboard + rules API. Deploy as its own Vercel project with **Root Directory = `dashboard`**. |
| repo root (`index.html`, `src/`, `api/index.js`, `vite.config.js`) | Waitlist landing page (React + Vite), deployed on Vercel. Unchanged by the worker work. |
| `server/`, `services/` | Earlier Node/Express prototype of the copier. Superseded by `worker/`. |

## How it stays correct

| Problem | What handles it |
|---|---|
| Same fill delivered twice (reconnects, snapshot replays) | `unique (leader_fill_id, follower_account_id)` on `copy_events`. A fill can be claimed once per follower. |
| Crash after sending an order, before saving it | Deterministic `clOrdId` = hash(fill, follower). A retry looks the order up before resending. |
| Rounding and caps drifting followers off the leader | Sizing works on **positions**: `target = clamp(trunc(leader_net × multiplier), ±cap)`, order = target − follower's committed position. Per-fill sizing was the original design; the simulator caught it leaving a follower 20 contracts off. |
| A failed order getting doubled once the next fill makes up for it | Failed and pending copies count toward the follower's committed position, so they get retried, never re-covered. |
| Copying our own copies | One login holds leader and followers, so follower fills come back on the stream. Fills are mapped fill → order → account, and only leader accounts are copied. |
| Missed fills while disconnected or down | Every reconnect replays the sync snapshot. Startup resumes from the newest recorded fill. Position targeting heals any gap on the next fill. |
| Sweeper and live path retrying the same order at once | All work goes through one asyncio queue with one consumer. |

## What's verified, and what isn't

| Piece | Status |
|---|---|
| Copy engine (`sync.py`, `sizing.py`) | 23 behaviour tests, each run against both the in-memory and Postgres stores, including 5 randomized sessions that must end exactly on target |
| Postgres schema, RLS, views, Realtime publication | Applied to real Postgres 16; constraints and row-level security tested as an `authenticated` user |
| Tradovate client (`tradovate.py`) | Tested against a fake REST layer and a fake WebSocket server that follows Tradovate's documented protocol. **Never run against Tradovate itself.** |
| Whole worker (`main.py`) | End-to-end test: real Postgres + fake Tradovate, fills in → orders out → DB state checked |
| Vercel API (`dashboard/api/rules.py`) | Auth and ownership checks tested over real HTTP with Supabase faked |
| Dashboard (`dashboard/public/index.html`) | JS syntax-checked; its sizing matches Python on 252 cases. **Never run against a live Supabase.** |
| Latency | Instrumented (`copy_events.latency_ms`, `copy_latency_24h` view). **No real number exists yet.** |

**119 tests total.** Run them:

```bash
cd worker
pip install -e ".[dev]"
pytest                                          # Postgres tests skip without a database
PARALLAX_TEST_DSN=postgresql://... pytest       # full suite
python -m parallax.simulate                     # 500 random fills, then reconciliation
```

## Taking it live

1. **Supabase.** Create a project and run `supabase/migrations/0001_init.sql` in the SQL editor. Insert your accounts (`broker_account` = the Tradovate account name, e.g. `DEMO123456`) and copy rules.
2. **Tradovate API access.** Get API credentials for a demo login, and confirm the current cost and requirements first. Then work through the checklist at the top of `worker/parallax/tradovate.py`; it lists every field and behaviour the client assumes but hasn't been able to verify.
3. **Worker.** Deploy `worker/` (Dockerfile) to Railway or Fly.io with the env vars in `.env.example`, `TRADOVATE_ENV=demo` and **`PARALLAX_DRY_RUN=1`**. Trade on the demo leader and watch the logs.
4. Once the dry run looks right, set `PARALLAX_DRY_RUN=0`, still on demo.
5. **Vercel.** Create a *new* Vercel project from this repo with Root Directory set to `dashboard` (the existing project keeps serving the landing page). Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
6. **Measure.** After a session of demo trades, run `python -m parallax.report`. It prints p50/p95/p99 copy latency and checks every follower against its target (exits 1 on drift, so it works as a cron alert).

## Known limits

- One worker process per set of leaders. Positions are read then written; two consumers over one leader would race.
- Followers are copied one after another. Parallelising cuts latency for the last follower, at the cost of handling broker rate limits and per-follower ordering explicitly.
- Account mappings load at startup, so a new account needs a worker restart. New rules don't; they're read per fill.
- Busted/corrected fills are ignored, not reversed.
- Market orders only.

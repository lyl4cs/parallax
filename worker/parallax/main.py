"""Worker entrypoint: python -m parallax.main

Env:
  DATABASE_URL            Supabase Postgres connection string (service role / postgres user)
  TRADOVATE_ENV           demo | live   (default demo)
  TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_APP_ID, TRADOVATE_APP_VERSION,
  TRADOVATE_CID, TRADOVATE_SECRET, TRADOVATE_DEVICE_ID (optional)
  PARALLAX_DRY_RUN=1      listen and log what WOULD be copied, place no orders. Start here.
  PARALLAX_SWEEP_SECONDS  how often to retry failed copies (default 15)

All copy work runs through ONE queue and ONE consumer. That serialisation is deliberate:
positions are read then written, and the sweeper and the live path must never retry the same
order at the same time. If one process ever becomes too slow, shard by leader account, never
by running two consumers over the same leader.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal

from .broker import Broker
from .models import OrderRequest, OrderResult, utcnow
from .store import PostgresStore
from .sync import handle_leader_fill, retry_open_events
from .tradovate import BrokerAccount, Credentials, FillTracker, LeaderListener, TradovateAPI, TradovateBroker

log = logging.getLogger("parallax")
SWEEP = object()


class DryRunBroker:
    """Logs instead of trading. Events still get recorded so the dashboard shows what would happen."""

    def __init__(self):
        self.n = 0

    def place_order(self, order: OrderRequest) -> OrderResult:
        self.n += 1
        log.info("[dry run] would %s %d %s on %s (%s)", order.side.value, order.qty, order.symbol,
                 order.account_id, order.client_order_id)
        return OrderResult(f"dry-{self.n}")


def load_accounts(store: PostgresStore, api: TradovateAPI, env: str):
    rows = store.conn.execute(
        "select id, broker_account, role from accounts where broker = 'tradovate' and environment = %s", (env,)
    ).fetchall()
    on_tradovate = {a["name"]: a for a in api.accounts()}

    leaders: dict[int, str] = {}
    mapping: dict[str, BrokerAccount] = {}
    for r in rows:
        tv = on_tradovate.get(r["broker_account"])
        if tv is None:
            log.warning("account %s not found on this Tradovate login; skipping", r["broker_account"])
            continue
        mapping[str(r["id"])] = BrokerAccount(tv["id"], tv["name"])
        if r["role"] == "leader":
            leaders[tv["id"]] = str(r["id"])
    return leaders, mapping


async def consume(queue: asyncio.Queue, store: PostgresStore, broker: Broker) -> None:
    while True:
        item = await queue.get()
        try:
            if item is SWEEP:
                events = await asyncio.to_thread(retry_open_events, store, broker)
                if events:
                    log.info("sweep retried %d open copies", len(events))
            else:
                events = await asyncio.to_thread(handle_leader_fill, item, store, broker)
                for e in events:
                    log.info("fill %s %s %d -> %s %s %s x%d (%s, %s ms)", item.broker_fill_id, item.side.value,
                             item.qty, e.follower_account_id[:8], e.status.value, e.side.value, e.qty,
                             e.error or "ok", f"{e.latency_ms:.1f}" if e.latency_ms is not None else "-")
        except Exception:
            log.exception("copy failed for %r; it stays recorded and the sweeper will retry", item)
        finally:
            queue.task_done()


async def sweep_timer(queue: asyncio.Queue, every: float) -> None:
    while True:
        await asyncio.sleep(every)
        await queue.put(SWEEP)


async def run(store: PostgresStore, api: TradovateAPI, env: str, dry: bool, stop: asyncio.Event,
              sweep_every: float = 15.0, connect=None) -> None:
    await asyncio.to_thread(api.token)

    leaders, mapping = await asyncio.to_thread(load_accounts, store, api, env)
    if not leaders:
        raise SystemExit("no leader accounts found; add rows to `accounts` first")

    # Resume from the newest fill we already have; on a first run, start from now.
    started = utcnow()
    since = {ours: store.last_fill_time(ours) or started for ours in leaders.values()}
    broker: Broker = DryRunBroker() if dry else TradovateBroker(api, mapping)
    log.info("starting on %s%s: %d leader(s), %d account(s) mapped", env, " (DRY RUN)" if dry else "",
             len(leaders), len(mapping))

    queue: asyncio.Queue = asyncio.Queue()
    await queue.put(SWEEP)                                   # finish anything a previous run left open
    tracker = FillTracker(leaders, since, api.contract_symbol)
    listener = LeaderListener(api.ws_url, api.token, lambda: api.user_id, tracker, queue.put, connect=connect)

    tasks = [
        asyncio.create_task(consume(queue, store, broker)),
        asyncio.create_task(sweep_timer(queue, sweep_every)),
    ]
    try:
        await listener.run_forever(stop)
        log.info("stopping: finishing queued copies")
        await queue.join()
    finally:
        for t in tasks:
            t.cancel()


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    env = os.environ.get("TRADOVATE_ENV", "demo")
    store = PostgresStore(os.environ["DATABASE_URL"])
    api = TradovateAPI(Credentials.from_env(), env)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await run(store, api, env, os.environ.get("PARALLAX_DRY_RUN") == "1", stop,
                  float(os.environ.get("PARALLAX_SWEEP_SECONDS", 15)))
    finally:
        store.close()


if __name__ == "__main__":
    asyncio.run(main())

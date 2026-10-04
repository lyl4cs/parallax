"""Whole worker, end to end: real Postgres + fake Tradovate REST + fake Tradovate WebSocket.

Leader buys 2 then sells 2. Followers: 1x, and 2x capped at 3. The fake server also echoes the
follower fills back on the stream, like the real one does when all accounts share a login.
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import psycopg

from parallax.main import run
from parallax.store import PostgresStore
from parallax.tradovate import TradovateAPI

from .conftest import acct
from .test_tradovate import CREDS, FakeHttp, iso

LEAD, F1, F2 = acct("e2e-lead"), acct("e2e-f1"), acct("e2e-f2")


def seed(dsn):
    with psycopg.connect(dsn, autocommit=True) as c:
        c.execute("truncate accounts cascade")
        for id_, name, role in ((LEAD, "DEMO100", "leader"), (F1, "DEMO200", "follower"), (F2, "DEMO300", "follower")):
            c.execute("insert into accounts (id, owner_id, broker_account, role) values (%s, %s, %s, %s)",
                      (id_, acct("owner"), name, role))
        c.execute("insert into copy_rules (leader_account_id, follower_account_id) values (%s, %s)", (LEAD, F1))
        c.execute("""insert into copy_rules (leader_account_id, follower_account_id, multiplier, max_contracts)
                     values (%s, %s, 2, 3)""", (LEAD, F2))


def test_worker_copies_end_to_end(pg_dsn):
    import websockets

    seed(pg_dsn)
    now = datetime.now(timezone.utc)
    placed = []

    def place(body):
        placed.append(body)
        return 200, {"orderId": 9000 + len(placed)}

    http = FakeHttp({
        ("POST", "/auth/accesstokenrequest"): [(200, {"accessToken": "tok", "userId": 42,
                                                      "expirationTime": iso(now + timedelta(minutes=90))})],
        ("GET", "/account/list"): [(200, [{"id": 100, "name": "DEMO100"}, {"id": 200, "name": "DEMO200"},
                                          {"id": 300, "name": "DEMO300"}])],
        ("GET", "/contract/item"): [(200, {"id": 1, "name": "MNQZ6"})],
        ("POST", "/order/placeorder"): place,
        ("GET", "/order/list"): [(200, [])],
    })

    def ev(entity_type, entity):
        return "a" + json.dumps([{"e": "props", "d": {"entityType": entity_type, "eventType": "Created", "entity": entity}}])

    def fill(fid, oid, action, qty, sec):
        return {"id": fid, "orderId": oid, "contractId": 1, "timestamp": iso(now + timedelta(seconds=sec)),
                "action": action, "qty": qty, "price": 21000.0, "active": True}

    async def server(ws):
        await ws.send("o")
        await ws.recv()
        await ws.send('a[{"i":0,"s":200}]')
        await ws.recv()
        await ws.send('a[{"i":1,"s":200,"d":{"orders":[],"fills":[]}}]')
        await ws.send(ev("order", {"id": 1, "accountId": 100}))
        await ws.send(ev("fill", fill(11, 1, "Buy", 2, 1)))
        while len(placed) < 2:
            await asyncio.sleep(0.02)
        for i, body in enumerate(placed[:2]):                   # echo our own copies back
            await ws.send(ev("order", {"id": 50 + i, "accountId": body["accountId"]}))
            await ws.send(ev("fill", fill(60 + i, 50 + i, body["action"], body["orderQty"], 2)))
        await ws.send(ev("order", {"id": 2, "accountId": 100}))
        await ws.send(ev("fill", fill(12, 2, "Sell", 2, 3)))
        try:
            await ws.wait_closed()
        except Exception:
            pass

    async def main():
        stop = asyncio.Event()
        async with websockets.serve(server, "127.0.0.1", 0) as srv:
            api = TradovateAPI(CREDS, "demo", http=http)
            api.ws_url = f"ws://127.0.0.1:{srv.sockets[0].getsockname()[1]}"
            store = PostgresStore(pg_dsn)

            async def stop_when_done():
                while len(placed) < 4:
                    await asyncio.sleep(0.02)
                await asyncio.sleep(0.3)                         # let anything wrong show up
                stop.set()

            watcher = asyncio.create_task(stop_when_done())
            await asyncio.wait_for(run(store, api, "demo", dry=False, stop=stop, sweep_every=60), 10)
            await watcher
            store.close()

    asyncio.run(main())

    assert [(b["accountSpec"], b["action"], b["orderQty"]) for b in placed] == [
        ("DEMO200", "Buy", 2), ("DEMO300", "Buy", 3),        # 2x would be 4, capped at 3
        ("DEMO200", "Sell", 2), ("DEMO300", "Sell", 3),      # leader flat -> both flat
    ]
    assert len({b["clOrdId"] for b in placed}) == 4

    with psycopg.connect(pg_dsn) as c:
        statuses = c.execute("select status, count(*) from copy_events group by status").fetchall()
        assert statuses == [("placed", 4)]
        assert c.execute("select count(*) from leader_fills").fetchone()[0] == 2       # echoes not recorded
        assert c.execute("select coalesce(sum(abs(net_qty)), 0) from follower_positions").fetchone()[0] == 0
        assert c.execute("select count(*) from copy_events where latency_ms is not null").fetchone()[0] == 4

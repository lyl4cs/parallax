"""Tradovate client tests against a fake HTTP layer and a fake WebSocket server.

These prove the client follows the protocol as documented in Tradovate's examples.
They do NOT prove Tradovate behaves that way; see the checklist at the top of tradovate.py.
"""

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from parallax.broker import BrokerError, DuplicateOrderError
from parallax.models import OrderRequest, Side
from parallax.tradovate import (
    AuthError, BrokerAccount, Credentials, FillTracker, LeaderListener, TradovateAPI, TradovateBroker, parse_frame,
)

CREDS = Credentials("user", "pw", "Parallax", "1.0", 123, "secret")
NOW = datetime(2026, 10, 3, 14, 30, tzinfo=timezone.utc)


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


class FakeHttp:
    def __init__(self, routes):
        self.routes = routes          # (method, path-prefix) -> list of (status, body) or callable
        self.calls = []

    def __call__(self, method, url, headers, body):
        path = url.split("/v1", 1)[1]
        self.calls.append((method, path, headers, body))
        for (m, prefix), resp in self.routes.items():
            if m == method and path.startswith(prefix):
                if callable(resp):
                    return resp(body)
                return resp.pop(0) if len(resp) > 1 else resp[0]
        raise AssertionError(f"unexpected {method} {path}")


def token_ok(expires=NOW + timedelta(minutes=90), token="tok"):
    return (200, {"accessToken": token, "expirationTime": iso(expires), "userId": 42})


def make_api(routes, clock=NOW.timestamp()):
    http = FakeHttp(routes)
    sleeps = []
    api = TradovateAPI(CREDS, "demo", http=http, sleep=sleeps.append, clock=lambda: clock)
    return api, http, sleeps


# ---------------- auth

def test_auth_sends_credentials_and_stores_token():
    api, http, _ = make_api({("POST", "/auth/accesstokenrequest"): [token_ok()]})

    assert api.token() == "tok"
    assert api.user_id == 42
    _, _, _, body = http.calls[0]
    assert body == {"name": "user", "password": "pw", "appId": "Parallax", "appVersion": "1.0", "cid": 123, "sec": "secret"}


def test_token_is_reused_until_near_expiry():
    api, http, _ = make_api({("POST", "/auth/accesstokenrequest"): [token_ok()]})
    api.token(); api.token(); api.token()
    assert len(http.calls) == 1


def test_token_is_renewed_near_expiry():
    api, http, _ = make_api({
        ("POST", "/auth/accesstokenrequest"): [token_ok(expires=NOW + timedelta(minutes=5))],
        ("GET", "/auth/renewaccesstoken"): [token_ok(token="renewed")],
    })
    api.token()
    assert api.token() == "renewed"
    assert http.calls[1][2]["Authorization"] == "Bearer tok"


def test_time_penalty_waits_and_retries_with_ticket():
    api, http, sleeps = make_api({("POST", "/auth/accesstokenrequest"): [
        (200, {"p-ticket": "T1", "p-time": 3}), token_ok(),
    ]})
    assert api.token() == "tok"
    assert sleeps == [3.0]
    assert http.calls[1][3]["p-ticket"] == "T1"


def test_captcha_penalty_is_an_auth_error():
    api, _, _ = make_api({("POST", "/auth/accesstokenrequest"): [(200, {"p-ticket": "T", "p-time": 1, "p-captcha": True})]})
    with pytest.raises(AuthError, match="captcha"):
        api.token()


def test_bad_credentials_are_an_auth_error():
    api, _, _ = make_api({("POST", "/auth/accesstokenrequest"): [(200, {"errorText": "Incorrect username or password."})]})
    with pytest.raises(AuthError, match="Incorrect"):
        api.token()


# ---------------- orders

FOLLOWER = "our-follower-uuid"
ACCT = BrokerAccount(id=777, spec="DEMO777")
ORDER = OrderRequest(FOLLOWER, "MNQZ6", Side.SELL, 3, "px-abc")


def broker_with(place, order_list=None):
    routes = {("POST", "/auth/accesstokenrequest"): [token_ok()], ("POST", "/order/placeorder"): place}
    if order_list is not None:
        routes[("GET", "/order/list")] = order_list
    api, http, _ = make_api(routes)
    return TradovateBroker(api, {FOLLOWER: ACCT}), http


def test_place_order_body():
    broker, http = broker_with([(200, {"orderId": 555})])

    assert broker.place_order(ORDER).broker_order_id == "555"
    _, path, headers, body = http.calls[-1]
    assert path == "/order/placeorder" and headers["Authorization"] == "Bearer tok"
    assert body == {"accountSpec": "DEMO777", "accountId": 777, "action": "Sell", "symbol": "MNQZ6",
                    "orderQty": 3, "orderType": "Market", "clOrdId": "px-abc", "isAutomated": True}


@pytest.mark.parametrize("resp", [
    (200, {"failureReason": "RiskCheck", "failureText": "Max position exceeded"}),
    (200, {}),
    (400, {"errorText": "bad symbol"}),
    (500, None),
])
def test_rejections_are_broker_errors(resp):
    broker, _ = broker_with([resp])
    with pytest.raises(BrokerError):
        broker.place_order(ORDER)


def test_network_errors_are_broker_errors():
    def boom(_):
        raise TimeoutError("read timed out")
    broker, _ = broker_with(boom)
    with pytest.raises(BrokerError, match="transport"):
        broker.place_order(ORDER)


def test_unmapped_account_is_a_broker_error():
    broker, _ = broker_with([(200, {"orderId": 1})])
    with pytest.raises(BrokerError, match="no Tradovate account"):
        broker.place_order(OrderRequest("someone-else", "MNQZ6", Side.BUY, 1, "px-x"))


def test_retry_finds_existing_order_instead_of_resending():
    broker, http = broker_with([(200, {"orderId": 999})],
                               order_list=[(200, [{"id": 555, "accountId": 777, "clOrdId": "px-abc"}])])

    with pytest.raises(DuplicateOrderError) as e:
        broker.place_order(OrderRequest(FOLLOWER, "MNQZ6", Side.SELL, 3, "px-abc", may_exist=True))

    assert e.value.existing.broker_order_id == "555"
    assert not any(p == "/order/placeorder" for _, p, _, _ in http.calls)


def test_retry_with_no_existing_order_sends():
    broker, _ = broker_with([(200, {"orderId": 999})],
                            order_list=[(200, [{"id": 1, "accountId": 777, "clOrdId": "px-other"}])])
    assert broker.place_order(OrderRequest(FOLLOWER, "MNQZ6", Side.SELL, 3, "px-abc", may_exist=True)).broker_order_id == "999"


def test_first_attempt_skips_the_lookup():
    broker, http = broker_with([(200, {"orderId": 1})], order_list=[(200, [])])
    broker.place_order(ORDER)
    assert not any(p == "/order/list" for _, p, _, _ in http.calls)


# ---------------- fill tracking

LEADER_TV, FOLLOWER_TV = 100, 200
LEADER = "our-leader-uuid"


def tracker(since=NOW):
    return FillTracker({LEADER_TV: LEADER}, {LEADER: since}, symbol_for={1: "MNQZ6", 2: "MESZ6"}.__getitem__)


def order(oid, acct):
    return {"entityType": "order", "eventType": "Created", "entity": {"id": oid, "accountId": acct}}


def fill_entity(fid, oid, ts=NOW + timedelta(seconds=1), action="Buy", qty=2, contract=1, active=True):
    return {"id": fid, "orderId": oid, "contractId": contract, "timestamp": iso(ts),
            "action": action, "qty": qty, "price": 21000.5, "active": active}


def fill_event(*a, **k):
    return {"entityType": "fill", "eventType": "Created", "entity": fill_entity(*a, **k)}


def test_leader_fill_becomes_a_fill():
    t = tracker()
    assert t.on_props(order(10, LEADER_TV)) == []
    [f] = t.on_props(fill_event(1, 10, action="Sell", qty=3, contract=2))
    assert (f.leader_account_id, f.broker_fill_id, f.symbol, f.side, f.qty, f.price) == (
        LEADER, "1", "MESZ6", Side.SELL, 3, 21000.5)


def test_follower_fills_are_ignored():
    """Our own copies come back on the same stream; copying them would loop forever."""
    t = tracker()
    t.on_props(order(20, FOLLOWER_TV))
    assert t.on_props(fill_event(2, 20)) == []


def test_fill_before_its_order_is_held_until_the_order_arrives():
    t = tracker()
    assert t.on_props(fill_event(3, 30)) == []
    [f] = t.on_props(order(30, LEADER_TV))
    assert f.broker_fill_id == "3"


def test_old_fills_are_ignored():
    t = tracker(since=NOW)
    t.on_props(order(10, LEADER_TV))
    assert t.on_props(fill_event(4, 10, ts=NOW - timedelta(minutes=5))) == []


def test_inactive_fills_and_other_events_are_ignored():
    t = tracker()
    t.on_props(order(10, LEADER_TV))
    assert t.on_props(fill_event(5, 10, active=False)) == []
    assert t.on_props({"entityType": "position", "eventType": "Updated", "entity": {}}) == []
    assert t.on_props({"entityType": "fill", "eventType": "Updated", "entity": fill_entity(6, 10)}) == []


def test_snapshot_replays_fills_in_time_order():
    t = tracker()
    snap = {"orders": [{"id": 10, "accountId": LEADER_TV}, {"id": 20, "accountId": FOLLOWER_TV}],
            "fills": [fill_entity(8, 10, ts=NOW + timedelta(seconds=9)), fill_entity(7, 10, ts=NOW + timedelta(seconds=2)),
                      fill_entity(9, 20), fill_entity(6, 10, ts=NOW - timedelta(hours=1))]}
    assert [f.broker_fill_id for f in t.on_snapshot(snap)] == ["7", "8"]


def test_parse_frame():
    assert parse_frame("o") == ("o", [])
    assert parse_frame("h") == ("h", [])
    assert parse_frame('a[{"i":0,"s":200}]') == ("a", [{"i": 0, "s": 200}])


# ---------------- listener against a fake Tradovate WebSocket server

class FakeTradovate:
    """Speaks the Tradovate frame protocol. Each connection gets the next script from `sessions`."""

    def __init__(self, sessions):
        self.sessions = sessions
        self.received = []
        self.heartbeats = 0

    async def handler(self, ws):
        script = self.sessions.pop(0)
        await ws.send("o")
        auth = await ws.recv()
        self.received.append(auth)
        endpoint, rid, _, token = auth.split("\n", 3)
        assert endpoint == "authorize"
        await ws.send("a" + json.dumps([{"i": int(rid), "s": 200 if token == "tok" else 401}]))
        sync = await ws.recv()
        self.received.append(sync)
        endpoint, rid, _, body = sync.split("\n", 3)
        assert endpoint == "user/syncrequest" and json.loads(body) == {"users": [42]}
        await ws.send("a" + json.dumps([{"i": int(rid), "s": 200, "d": script["snapshot"]}]))
        for ev in script["events"]:
            await ws.send("a" + json.dumps([{"e": "props", "d": ev}]))
        if script.get("drop"):
            await ws.close()
            return
        try:
            while True:
                if await ws.recv() == "[]":
                    self.heartbeats += 1
        except Exception:
            pass


def run_listener(server: FakeTradovate, want: int, heartbeat=2.5, timeout=5.0):
    import websockets

    async def main():
        got = []
        stop = asyncio.Event()

        async def on_fill(f):
            got.append(f)
            if len(got) >= want:
                await asyncio.sleep(0.3 if heartbeat < 1 else 0)
                stop.set()

        async with websockets.serve(server.handler, "127.0.0.1", 0) as srv:
            port = srv.sockets[0].getsockname()[1]
            listener = LeaderListener(f"ws://127.0.0.1:{port}", token=lambda: "tok", user_id=lambda: 42,
                                      tracker=tracker(), on_fill=on_fill, max_backoff_s=0.2)
            listener.HEARTBEAT_S = heartbeat
            await asyncio.wait_for(listener.run_forever(stop), timeout)
            return got, listener

    return asyncio.run(main())


def test_listener_end_to_end():
    server = FakeTradovate([{
        "snapshot": {"orders": [{"id": 10, "accountId": LEADER_TV}],
                     "fills": [fill_entity(1, 10), fill_entity(0, 10, ts=NOW - timedelta(days=1))]},
        "events": [order(20, FOLLOWER_TV), fill_event(2, 20),     # our own copy: ignored
                   fill_event(3, 11), order(11, LEADER_TV)],     # fill before order: held, then emitted
    }])
    got, _ = run_listener(server, want=2)
    assert [f.broker_fill_id for f in got] == ["1", "3"]


def test_listener_reconnects_and_catches_up_from_snapshot():
    """Connection drops; a fill happens while we're disconnected; the reconnect snapshot delivers it."""
    server = FakeTradovate([
        {"snapshot": {"orders": [{"id": 10, "accountId": LEADER_TV}], "fills": []},
         "events": [fill_event(1, 10)], "drop": True},
        {"snapshot": {"orders": [{"id": 10, "accountId": LEADER_TV}],
                      "fills": [fill_entity(1, 10), fill_entity(2, 10, ts=NOW + timedelta(seconds=5))]},
         "events": []},
    ])
    got, listener = run_listener(server, want=3)
    assert listener.sessions == 2
    # fill 1 arrives twice (live, then in the replayed snapshot); the store dedupes it downstream
    assert [f.broker_fill_id for f in got] == ["1", "1", "2"]


def test_listener_sends_heartbeats():
    server = FakeTradovate([{"snapshot": {"orders": [{"id": 10, "accountId": LEADER_TV}], "fills": []},
                             "events": [fill_event(1, 10)]}])
    run_listener(server, want=1, heartbeat=0.05)
    assert server.heartbeats >= 2

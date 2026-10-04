"""Tradovate integration: auth, order placement, and the real-time fill listener.

Built from Tradovate's official examples (github.com/tradovate/example-api-js and
example-api-faq). Covered by tests/test_tradovate.py against a fake HTTP layer and a fake
WebSocket server, NOT against Tradovate itself. Before trusting it with money, verify on demo:

  [ ] the auth response fields (accessToken, expirationTime, userId) and token lifetime
  [ ] that the user/syncrequest snapshot carries `orders` and `fills` arrays as handled here
  [ ] the `fill` entity fields used here: id, orderId, contractId, timestamp, action, qty, price
  [ ] whether order entities echo `clOrdId` (TradovateBroker._find_existing depends on it)
  [ ] what happens if you send the same clOrdId twice

Protocol notes (from the official examples):
  REST    https://{demo|live}.tradovateapi.com/v1, bearer token
  WS      wss://{demo|live}.tradovateapi.com/v1/websocket
  frames  'o' open, 'h' server heartbeat, 'a' + JSON array of messages, 'c' close
  request "<endpoint>\\n<id>\\n<query>\\n<json body>", response {"i": id, "s": status, "d": data}
  events  {"e": "props", "d": {"entityType": ..., "eventType": ..., "entity": {...}}}
  client must send '[]' as a heartbeat every 2.5 s or the server drops the socket

Why the worker filters fills by account: one Tradovate login usually holds the leader AND the
follower accounts (that's the whole prop-firm use case), so the follower orders we place come back
as fills on the same stream. Without the filter, the copier would copy its own copies.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from .broker import BrokerError, DuplicateOrderError
from .models import Fill, OrderRequest, OrderResult, Side, utcnow

log = logging.getLogger("parallax.tradovate")

URLS = {
    "demo": ("https://demo.tradovateapi.com/v1", "wss://demo.tradovateapi.com/v1/websocket"),
    "live": ("https://live.tradovateapi.com/v1", "wss://live.tradovateapi.com/v1/websocket"),
}

# (method, url, headers, json body) -> (status, parsed json)
Http = Callable[[str, str, dict, dict | None], tuple[int, Any]]


def urllib_http(method: str, url: str, headers: dict, body: dict | None, timeout: float = 5.0) -> tuple[int, Any]:
    req = urllib.request.Request(url, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else None
        except ValueError:
            return e.code, {"errorText": raw.decode(errors="replace")}


class TradovateHTTPError(Exception):
    def __init__(self, status: int, body: Any):
        super().__init__(f"HTTP {status}: {body}")
        self.status, self.body = status, body


class AuthError(Exception):
    pass


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


# ---------------------------------------------------------------- auth + REST

@dataclass
class Credentials:
    name: str
    password: str
    app_id: str
    app_version: str
    cid: int
    sec: str
    device_id: str | None = None

    @classmethod
    def from_env(cls) -> "Credentials":
        e = os.environ
        return cls(e["TRADOVATE_USERNAME"], e["TRADOVATE_PASSWORD"], e["TRADOVATE_APP_ID"],
                   e.get("TRADOVATE_APP_VERSION", "1.0"), int(e["TRADOVATE_CID"]), e["TRADOVATE_SECRET"],
                   e.get("TRADOVATE_DEVICE_ID"))

    def body(self) -> dict:
        b = {"name": self.name, "password": self.password, "appId": self.app_id,
             "appVersion": self.app_version, "cid": self.cid, "sec": self.sec}
        if self.device_id:
            b["deviceId"] = self.device_id
        return b


class TradovateAPI:
    """Holds the access token, renews it before expiry, and makes authenticated REST calls."""

    RENEW_BEFORE_S = 15 * 60

    def __init__(self, creds: Credentials, env: str = "demo", http: Http = urllib_http,
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.time):
        self.creds, self.env = creds, env
        self.base_url, self.ws_url = URLS[env]
        self.http, self.sleep, self.clock = http, sleep, clock
        self.access_token: str | None = None
        self.expires_at: float = 0.0
        self.user_id: int | None = None
        self._symbols: dict[int, str] = {}

    def token(self) -> str:
        if self.access_token and self.clock() < self.expires_at - self.RENEW_BEFORE_S:
            return self.access_token
        if self.access_token and self.clock() < self.expires_at:
            try:
                self._renew()
                return self.access_token
            except (AuthError, TradovateHTTPError, OSError) as e:
                log.warning("token renewal failed, requesting a new one: %s", e)
        self._request_token()
        return self.access_token

    def _request_token(self, max_penalties: int = 3) -> None:
        body = self.creds.body()
        for _ in range(max_penalties + 1):
            status, res = self.http("POST", f"{self.base_url}/auth/accesstokenrequest",
                                    {"Content-Type": "application/json", "Accept": "application/json"}, body)
            res = res or {}
            if "p-ticket" in res:
                if res.get("p-captcha"):
                    raise AuthError("Tradovate requires a captcha (too many failed logins). Wait an hour.")
                self.sleep(float(res.get("p-time", 1)))
                body = {**body, "p-ticket": res["p-ticket"]}
                continue
            if status >= 400 or res.get("errorText") or "accessToken" not in res:
                raise AuthError(res.get("errorText") or f"auth failed with HTTP {status}")
            self._store(res)
            self.user_id = res.get("userId", self.user_id)
            return
        raise AuthError("gave up after repeated time penalties")

    def _renew(self) -> None:
        status, res = self.http("GET", f"{self.base_url}/auth/renewaccesstoken", self._headers(), None)
        if status >= 400 or not res or "accessToken" not in res:
            raise AuthError(f"renew failed with HTTP {status}")
        self._store(res)

    def _store(self, res: dict) -> None:
        self.access_token = res["accessToken"]
        self.expires_at = parse_time(res["expirationTime"]).timestamp()

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.access_token}", "Content-Type": "application/json",
                "Accept": "application/json"}

    def get(self, path: str, query: dict | None = None) -> Any:
        self.token()
        url = f"{self.base_url}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        status, res = self.http("GET", url, self._headers(), None)
        if status >= 400:
            raise TradovateHTTPError(status, res)
        return res

    def post(self, path: str, body: dict) -> Any:
        self.token()
        status, res = self.http("POST", f"{self.base_url}{path}", self._headers(), body)
        if status >= 400:
            raise TradovateHTTPError(status, res)
        return res

    def contract_symbol(self, contract_id: int) -> str:
        if contract_id not in self._symbols:
            self._symbols[contract_id] = self.get("/contract/item", {"id": contract_id})["name"]
        return self._symbols[contract_id]

    def accounts(self) -> list[dict]:
        return self.get("/account/list")


# ---------------------------------------------------------------- orders

@dataclass(frozen=True)
class BrokerAccount:
    id: int          # Tradovate's numeric account id
    spec: str        # Tradovate's account name, e.g. "DEMO123456"


class TradovateBroker:
    """Implements broker.Broker for Tradovate. `accounts` maps OUR account ids to Tradovate's."""

    def __init__(self, api: TradovateAPI, accounts: dict[str, BrokerAccount]):
        self.api, self.accounts = api, accounts

    def place_order(self, order: OrderRequest) -> OrderResult:
        acct = self.accounts.get(order.account_id)
        if acct is None:
            raise BrokerError(f"no Tradovate account mapped for {order.account_id}")

        if order.may_exist:
            existing = self._find_existing(acct, order.client_order_id)
            if existing:
                raise DuplicateOrderError(order.client_order_id, existing)

        body = {
            "accountSpec": acct.spec,
            "accountId": acct.id,
            "action": "Buy" if order.side is Side.BUY else "Sell",
            "symbol": order.symbol,
            "orderQty": order.qty,
            "orderType": "Market",
            "clOrdId": order.client_order_id,
            "isAutomated": True,   # Tradovate requires this flag for orders not placed by a human
        }
        try:
            res = self.api.post("/order/placeorder", body) or {}
        except TradovateHTTPError as e:
            raise BrokerError(f"placeorder rejected: {e}") from e
        except (OSError, AuthError) as e:
            # Includes timeouts: the order MAY have gone through. The retry runs with
            # may_exist=True and looks it up before sending again.
            raise BrokerError(f"placeorder transport error: {e}") from e

        if res.get("failureReason") or "orderId" not in res:
            raise BrokerError(f"{res.get('failureReason', 'NoOrderId')}: {res.get('failureText', res)}")
        return OrderResult(str(res["orderId"]))

    def _find_existing(self, acct: BrokerAccount, client_order_id: str) -> OrderResult | None:
        try:
            orders = self.api.get("/order/list") or []
        except (TradovateHTTPError, OSError) as e:
            raise BrokerError(f"could not check for an existing order: {e}") from e
        for o in orders:
            if o.get("accountId") == acct.id and o.get("clOrdId") == client_order_id:
                return OrderResult(str(o["id"]))
        return None


# ---------------------------------------------------------------- fills

class FillTracker:
    """Turns user-sync data into leader `Fill`s.

    Fill entities carry an orderId but no accountId, so order entities are tracked to learn which
    account each fill belongs to. A fill that arrives before its order is held until the order shows up.
    Fills older than the leader's `since` time are dropped: they're history from before we started copying.
    """

    def __init__(self, leaders: dict[int, str], since: dict[str, datetime],
                 symbol_for: Callable[[int], str]):
        self.leaders = leaders                  # tradovate account id -> our leader account id
        self.since = since                      # our leader account id -> ignore fills before this
        self.symbol_for = symbol_for
        self.order_account: dict[int, int] = {}
        self.waiting: dict[int, list[dict]] = {}

    def on_snapshot(self, d: dict) -> list[Fill]:
        for o in d.get("orders", []):
            self._note_order(o)
        out: list[Fill] = []
        for f in sorted(d.get("fills", []), key=lambda f: f.get("timestamp", "")):
            out += self._on_fill(f)
        return out

    def on_props(self, d: dict) -> list[Fill]:
        entity_type, event_type, entity = d.get("entityType"), d.get("eventType"), d.get("entity") or {}
        if entity_type == "order" and event_type in ("Created", "Updated"):
            return self._note_order(entity)
        if entity_type == "fill" and event_type == "Created":
            return self._on_fill(entity)
        return []

    def _note_order(self, order: dict) -> list[Fill]:
        if "id" not in order or "accountId" not in order:
            return []
        self.order_account[order["id"]] = order["accountId"]
        out: list[Fill] = []
        for f in self.waiting.pop(order["id"], []):
            out += self._on_fill(f)
        return out

    def _on_fill(self, f: dict) -> list[Fill]:
        if f.get("active") is False:
            return []                                           # busted/cancelled fill
        acct = self.order_account.get(f.get("orderId"))
        if acct is None:
            self.waiting.setdefault(f["orderId"], []).append(f)
            return []
        leader = self.leaders.get(acct)
        if leader is None:
            return []                                           # a follower's (or unrelated) fill
        filled_at = parse_time(f["timestamp"])
        if filled_at < self.since.get(leader, filled_at):
            return []
        return [Fill(
            leader_account_id=leader,
            broker_fill_id=str(f["id"]),
            symbol=self.symbol_for(f["contractId"]),
            side=Side.BUY if f["action"] == "Buy" else Side.SELL,
            qty=int(f["qty"]),
            price=float(f["price"]),
            filled_at=filled_at,
            received_at=utcnow(),
        )]


def parse_frame(raw: str) -> tuple[str, list]:
    kind = raw[:1]
    return kind, (json.loads(raw[1:]) if len(raw) > 1 else [])


class LeaderListener:
    """Holds the user-sync WebSocket open, reconnecting with backoff, and emits leader fills.

    After every (re)connect the sync snapshot is replayed through the tracker, so fills that
    happened while disconnected are picked up. Replays are harmless: recording is idempotent.
    """

    HEARTBEAT_S = 2.5

    def __init__(self, ws_url: str, token: Callable[[], str], user_id: Callable[[], int],
                 tracker: FillTracker, on_fill: Callable[[Fill], Awaitable[None]],
                 connect: Callable | None = None, max_backoff_s: float = 30.0):
        self.ws_url, self.token, self.user_id = ws_url, token, user_id
        self.tracker, self.on_fill = tracker, on_fill
        self.max_backoff_s = max_backoff_s
        self.sessions = 0
        if connect is None:
            import websockets
            connect = websockets.connect
        self.connect = connect

    async def run_forever(self, stop: asyncio.Event | None = None) -> None:
        stop = stop or asyncio.Event()
        backoff = 0.5
        while not stop.is_set():
            started = time.monotonic()
            try:
                await self._session(stop)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # any drop: reconnect
                log.warning("tradovate socket dropped: %r", e)
            if stop.is_set():
                break
            if time.monotonic() - started > 60:
                backoff = 0.5                           # it was a healthy session; reconnect fast
            await asyncio.sleep(backoff * (0.5 + random.random()))
            backoff = min(backoff * 2, self.max_backoff_s)

    async def _session(self, stop: asyncio.Event) -> None:
        token = await asyncio.to_thread(self.token)
        async with self.connect(self.ws_url) as ws:
            self.sessions += 1
            kind, _ = parse_frame(await ws.recv())
            if kind != "o":
                raise ConnectionError(f"expected open frame, got {kind!r}")

            await ws.send(f"authorize\n0\n\n{token}")
            await self._await_response(ws, 0)
            await ws.send(f"user/syncrequest\n1\n\n{json.dumps({'users': [self.user_id()]})}")

            beat = asyncio.create_task(self._heartbeat(ws))
            stopper = asyncio.create_task(stop.wait())
            try:
                while True:
                    recv = asyncio.create_task(ws.recv())
                    done, _ = await asyncio.wait({recv, stopper}, return_when=asyncio.FIRST_COMPLETED)
                    if stopper in done:
                        recv.cancel()
                        return
                    await self._handle(recv.result())
            finally:
                beat.cancel()
                stopper.cancel()

    async def _await_response(self, ws, request_id: int) -> dict:
        while True:
            kind, data = parse_frame(await ws.recv())
            if kind == "c":
                raise ConnectionError(f"closed while waiting for response {request_id}: {data}")
            for item in data if kind == "a" else []:
                if item.get("i") == request_id:
                    if item.get("s") != 200:
                        raise ConnectionError(f"request {request_id} failed: {item}")
                    return item

    async def _handle(self, raw: str) -> None:
        kind, data = parse_frame(raw)
        if kind == "c":
            raise ConnectionError(f"server closed: {data}")
        if kind != "a":
            return
        for item in data:
            fills: list[Fill] = []
            if item.get("i") == 1:
                if item.get("s") != 200:
                    raise ConnectionError(f"user/syncrequest failed: {item}")
                fills = await asyncio.to_thread(self.tracker.on_snapshot, item.get("d") or {})
            elif item.get("e") == "props":
                fills = await asyncio.to_thread(self.tracker.on_props, item.get("d") or {})
            for fill in fills:
                await self.on_fill(fill)

    async def _heartbeat(self, ws) -> None:
        while True:
            await asyncio.sleep(self.HEARTBEAT_S)
            await ws.send("[]")

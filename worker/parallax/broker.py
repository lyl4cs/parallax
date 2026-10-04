"""Broker interface plus a simulated broker for tests and local runs.

The real Tradovate client implements the same `Broker` protocol, so sync logic never
knows (or cares) whether it's talking to the simulator or the exchange.
"""

from __future__ import annotations

import itertools
from typing import Protocol

from .models import OrderRequest, OrderResult


class BrokerError(Exception):
    """The broker rejected the order or couldn't be reached."""


class DuplicateOrderError(BrokerError):
    """The broker already has an order with this client_order_id."""

    def __init__(self, client_order_id: str, existing: OrderResult):
        super().__init__(f"duplicate client_order_id {client_order_id}")
        self.existing = existing


class Broker(Protocol):
    def place_order(self, order: OrderRequest) -> OrderResult: ...


class SimulatedBroker:
    """In-memory broker.

    - Rejects a repeated client_order_id with DuplicateOrderError (like a real exchange should).
    - `fail_accounts`: account ids whose orders raise BrokerError.
    - `fail_times`: account id -> number of upcoming orders that fail before succeeding.
    """

    def __init__(self, fail_accounts: set[str] | None = None, fail_times: dict[str, int] | None = None):
        self.fail_accounts = set(fail_accounts or ())
        self.fail_times = dict(fail_times or {})
        self.orders: list[OrderRequest] = []          # every ACCEPTED order, in order
        self.calls: list[OrderRequest] = []           # every call, accepted or not
        self._by_client_id: dict[str, OrderResult] = {}
        self._ids = itertools.count(1)

    def place_order(self, order: OrderRequest) -> OrderResult:
        self.calls.append(order)

        if order.client_order_id in self._by_client_id:
            raise DuplicateOrderError(order.client_order_id, self._by_client_id[order.client_order_id])

        if order.account_id in self.fail_accounts:
            raise BrokerError(f"account {order.account_id} rejected")

        if self.fail_times.get(order.account_id, 0) > 0:
            self.fail_times[order.account_id] -= 1
            raise BrokerError(f"transient error for {order.account_id}")

        result = OrderResult(broker_order_id=f"sim-{next(self._ids)}")
        self._by_client_id[order.client_order_id] = result
        self.orders.append(order)
        return result

    def net_position(self, account_id: str, symbol: str) -> int:
        total = 0
        for o in self.orders:
            if o.account_id == account_id and o.symbol == symbol:
                total += o.qty if o.side.value == "buy" else -o.qty
        return total

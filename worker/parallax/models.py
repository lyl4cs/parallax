"""Plain data types shared by every part of the worker."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"

    @property
    def sign(self) -> int:
        return 1 if self is Side.BUY else -1


class CopyStatus(str, Enum):
    PENDING = "pending"   # claimed, order not confirmed yet
    PLACED = "placed"     # broker accepted the follower order
    FAILED = "failed"     # broker rejected it or errored, will be retried
    SKIPPED = "skipped"   # nothing to trade (follower already on target)


# Statuses that represent an order we intend to have on the books.
COMMITTED = (CopyStatus.PENDING, CopyStatus.PLACED, CopyStatus.FAILED)


@dataclass(frozen=True)
class Fill:
    """A fill observed on a leader account."""

    leader_account_id: str
    broker_fill_id: str
    symbol: str
    side: Side
    qty: int
    price: float
    filled_at: datetime = field(default_factory=utcnow)      # exchange time
    received_at: datetime = field(default_factory=utcnow)    # when the worker saw it

    @property
    def signed_qty(self) -> int:
        return self.side.sign * self.qty


@dataclass(frozen=True)
class CopyRule:
    leader_account_id: str
    follower_account_id: str
    multiplier: float = 1.0
    max_contracts: int | None = None
    active: bool = True


@dataclass(frozen=True)
class OrderRequest:
    """A market order to send to the broker for a follower account."""

    account_id: str
    symbol: str
    side: Side
    qty: int
    client_order_id: str
    # True when this exact order may already have reached the broker (a retry, or recovery of a
    # PENDING event from a previous process). Brokers that can't dedupe on client_order_id
    # themselves must check for an existing order before placing when this is set.
    may_exist: bool = False


@dataclass(frozen=True)
class OrderResult:
    broker_order_id: str


@dataclass
class CopyEvent:
    """The follower order caused by one leader fill. At most one per (fill, follower)."""

    fill_key: str
    follower_account_id: str
    client_order_id: str
    symbol: str
    side: Side
    qty: int
    status: CopyStatus = CopyStatus.PENDING
    broker_order_id: str | None = None
    error: str | None = None
    attempts: int = 0
    placed_at: datetime | None = None
    latency_ms: float | None = None      # worker received leader fill -> broker acked follower order

    @property
    def signed_qty(self) -> int:
        return self.side.sign * self.qty

    def order(self, may_exist: bool = False) -> OrderRequest:
        return OrderRequest(self.follower_account_id, self.symbol, self.side, self.qty, self.client_order_id, may_exist)

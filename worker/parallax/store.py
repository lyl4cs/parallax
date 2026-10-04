"""Persistence for fills and copy events.

`InMemoryStore` is used by tests and the local simulation.
`PostgresStore` talks to the Supabase database using the schema in supabase/migrations.
Both enforce the same rule: at most one CopyEvent per (leader fill, follower).
"""

from __future__ import annotations

from typing import Protocol

from .models import COMMITTED, CopyEvent, CopyRule, CopyStatus, Fill, Side


class Store(Protocol):
    def record_fill(self, fill: Fill) -> tuple[str, bool]:
        """Save a leader fill. Returns (fill_key, is_new). is_new is False for a redelivered fill."""
        ...

    def active_rules(self, leader_account_id: str) -> list[CopyRule]: ...

    def last_fill_time(self, leader_account_id: str):
        """Exchange time of the newest recorded fill for this leader, or None."""
        ...

    def leader_position(self, leader_account_id: str, symbol: str) -> int:
        """Net signed position from every recorded leader fill."""
        ...

    def committed_position(self, follower_account_id: str, symbol: str) -> int:
        """Net signed position the follower has or is about to have (placed + pending + failed events)."""
        ...

    def claim(self, fill_key: str, follower_account_id: str, client_order_id: str,
              symbol: str, side: Side, qty: int, status: CopyStatus = CopyStatus.PENDING) -> tuple[CopyEvent, bool]:
        """Create a copy event, or return the existing one for this (fill, follower) untouched.

        Returns (event, created).
        """
        ...

    def save(self, event: CopyEvent) -> None:
        """Persist status/broker_order_id/error/attempts/latency changes on an existing event."""
        ...

    def events_for(self, fill_key: str) -> list[CopyEvent]: ...

    def open_events(self) -> list[CopyEvent]:
        """Events still PENDING or FAILED, oldest first."""
        ...


class InMemoryStore:
    def __init__(self, rules: list[CopyRule] | None = None):
        self.rules: list[CopyRule] = list(rules or [])
        self.fills: dict[str, Fill] = {}
        self.events: dict[tuple[str, str], CopyEvent] = {}

    def record_fill(self, fill: Fill) -> tuple[str, bool]:
        key = f"{fill.leader_account_id}:{fill.broker_fill_id}"
        if key in self.fills:
            return key, False
        self.fills[key] = fill
        return key, True

    def active_rules(self, leader_account_id: str) -> list[CopyRule]:
        return [r for r in self.rules if r.leader_account_id == leader_account_id and r.active]

    def last_fill_time(self, leader_account_id: str):
        times = [f.filled_at for f in self.fills.values() if f.leader_account_id == leader_account_id]
        return max(times) if times else None

    def leader_position(self, leader_account_id: str, symbol: str) -> int:
        return sum(f.signed_qty for f in self.fills.values()
                   if f.leader_account_id == leader_account_id and f.symbol == symbol)

    def committed_position(self, follower_account_id: str, symbol: str) -> int:
        return sum(e.signed_qty for e in self.events.values()
                   if e.follower_account_id == follower_account_id and e.symbol == symbol and e.status in COMMITTED)

    def claim(self, fill_key, follower_account_id, client_order_id, symbol, side, qty,
              status=CopyStatus.PENDING) -> tuple[CopyEvent, bool]:
        k = (fill_key, follower_account_id)
        if k in self.events:
            return self.events[k], False
        ev = CopyEvent(fill_key=fill_key, follower_account_id=follower_account_id, client_order_id=client_order_id,
                       symbol=symbol, side=side, qty=qty, status=status)
        self.events[k] = ev
        return ev, True

    def save(self, event: CopyEvent) -> None:
        self.events[(event.fill_key, event.follower_account_id)] = event

    def events_for(self, fill_key: str) -> list[CopyEvent]:
        return [e for (fk, _), e in self.events.items() if fk == fill_key]

    def open_events(self) -> list[CopyEvent]:
        return [e for e in self.events.values() if e.status in (CopyStatus.PENDING, CopyStatus.FAILED)]


class PostgresStore:
    """Supabase/Postgres implementation. Requires `psycopg[binary]` and DATABASE_URL.

    Covered by tests/test_postgres_store.py, which runs against a real local Postgres.
    One worker process should own each leader account: positions are read then written,
    so two workers copying the same leader at once could both see the same starting position.
    """

    def __init__(self, dsn: str):
        import psycopg  # imported lazily so the in-memory path doesn't need it
        from psycopg.rows import dict_row

        self.conn = psycopg.connect(dsn, autocommit=True, row_factory=dict_row)

    def close(self) -> None:
        self.conn.close()

    def record_fill(self, fill: Fill) -> tuple[str, bool]:
        row = self.conn.execute(
            """
            insert into leader_fills (leader_account_id, broker_fill_id, symbol, side, qty, price, filled_at, received_at)
            values (%s, %s, %s, %s, %s, %s, %s, %s)
            on conflict (leader_account_id, broker_fill_id) do nothing
            returning id
            """,
            (fill.leader_account_id, fill.broker_fill_id, fill.symbol, fill.side.value,
             fill.qty, fill.price, fill.filled_at, fill.received_at),
        ).fetchone()
        if row:
            return str(row["id"]), True
        existing = self.conn.execute(
            "select id from leader_fills where leader_account_id = %s and broker_fill_id = %s",
            (fill.leader_account_id, fill.broker_fill_id),
        ).fetchone()
        return str(existing["id"]), False

    def active_rules(self, leader_account_id: str) -> list[CopyRule]:
        rows = self.conn.execute(
            """
            select leader_account_id, follower_account_id, multiplier, max_contracts, active
            from copy_rules where leader_account_id = %s and active
            order by created_at
            """,
            (leader_account_id,),
        ).fetchall()
        return [
            CopyRule(str(r["leader_account_id"]), str(r["follower_account_id"]),
                     float(r["multiplier"]), r["max_contracts"], r["active"])
            for r in rows
        ]

    def last_fill_time(self, leader_account_id: str):
        row = self.conn.execute(
            "select max(filled_at) as t from leader_fills where leader_account_id = %s", (leader_account_id,)
        ).fetchone()
        return row["t"]

    def leader_position(self, leader_account_id: str, symbol: str) -> int:
        row = self.conn.execute(
            """
            select coalesce(sum(case when side = 'buy' then qty else -qty end), 0) as pos
            from leader_fills where leader_account_id = %s and symbol = %s
            """,
            (leader_account_id, symbol),
        ).fetchone()
        return int(row["pos"])

    def committed_position(self, follower_account_id: str, symbol: str) -> int:
        row = self.conn.execute(
            """
            select coalesce(sum(case when side = 'buy' then qty else -qty end), 0) as pos
            from copy_events
            where follower_account_id = %s and symbol = %s and status in ('pending', 'placed', 'failed')
            """,
            (follower_account_id, symbol),
        ).fetchone()
        return int(row["pos"])

    def claim(self, fill_key, follower_account_id, client_order_id, symbol, side, qty,
              status=CopyStatus.PENDING) -> tuple[CopyEvent, bool]:
        row = self.conn.execute(
            """
            insert into copy_events (leader_fill_id, follower_account_id, client_order_id, symbol, side, qty, status)
            values (%s, %s, %s, %s, %s, %s, %s)
            on conflict (leader_fill_id, follower_account_id) do nothing
            returning *
            """,
            (fill_key, follower_account_id, client_order_id, symbol, side.value, qty, status.value),
        ).fetchone()
        created = row is not None
        if not created:
            row = self.conn.execute(
                "select * from copy_events where leader_fill_id = %s and follower_account_id = %s",
                (fill_key, follower_account_id),
            ).fetchone()
        return self._to_event(row), created

    def save(self, event: CopyEvent) -> None:
        self.conn.execute(
            """
            update copy_events
            set status = %s, broker_order_id = %s, error = %s, attempts = %s,
                placed_at = %s, latency_ms = %s, updated_at = now()
            where leader_fill_id = %s and follower_account_id = %s
            """,
            (event.status.value, event.broker_order_id, event.error, event.attempts,
             event.placed_at, event.latency_ms, event.fill_key, event.follower_account_id),
        )

    def events_for(self, fill_key: str) -> list[CopyEvent]:
        rows = self.conn.execute(
            "select * from copy_events where leader_fill_id = %s order by created_at", (fill_key,)
        ).fetchall()
        return [self._to_event(r) for r in rows]

    def open_events(self) -> list[CopyEvent]:
        rows = self.conn.execute(
            "select * from copy_events where status in ('pending', 'failed') order by created_at"
        ).fetchall()
        return [self._to_event(r) for r in rows]

    @staticmethod
    def _to_event(r: dict) -> CopyEvent:
        return CopyEvent(
            fill_key=str(r["leader_fill_id"]),
            follower_account_id=str(r["follower_account_id"]),
            client_order_id=r["client_order_id"],
            symbol=r["symbol"],
            side=Side(r["side"]),
            qty=r["qty"],
            status=CopyStatus(r["status"]),
            broker_order_id=r["broker_order_id"],
            error=r["error"],
            attempts=r["attempts"],
            placed_at=r["placed_at"],
            latency_ms=float(r["latency_ms"]) if r["latency_ms"] is not None else None,
        )

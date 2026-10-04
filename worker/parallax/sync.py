"""The core of Parallax: mirror one leader fill onto every follower, exactly once.

handle_leader_fill(fill, store, broker)
    1. Record the fill. A redelivered fill is NOT ignored: re-handling it is how interrupted
       copies get finished. Copies that already finished are left alone.
    2. For each active copy rule on the leader:
       - target = sizing.target_position(leader net position, multiplier, cap)
       - order  = target - follower's committed position   (0 -> SKIPPED, never round up)
       - claim the (fill, follower) pair. The unique constraint means only the first claim wins;
         a second worker or a redelivery gets the existing event back and doesn't re-size.
       - send the order with a deterministic client_order_id, retrying transient errors.
    3. One follower failing never stops the others.

retry_open_events(store, broker)
    Sweeper for PENDING/FAILED events, run on a timer and at startup. Safe to run any time
    because a resend reuses the same client_order_id.

Why each piece exists (know these cold for interviews):
- Deterministic client_order_id: if the process dies between place_order() and save(),
  the retry is rejected by the broker as a duplicate instead of doubling the position.
- Sizing against positions, not fills: per-fill rounding/caps accumulate drift. Targeting the
  position makes the follower self-correct, including after a missed fill.
- Counting PENDING/FAILED as committed: a failed order will be retried, so the next fill must
  not also try to make up for it, or the follower ends up doubled once both go through.
- Followers are copied sequentially. Parallelising them cuts latency for the last follower,
  but then per-follower ordering and broker rate limits need handling explicitly.
"""

from __future__ import annotations

import logging

from .broker import Broker, BrokerError, DuplicateOrderError
from .models import CopyEvent, CopyStatus, Fill, Side, utcnow
from .sizing import client_order_id, target_position
from .store import Store

log = logging.getLogger("parallax.sync")


def handle_leader_fill(fill: Fill, store: Store, broker: Broker, max_attempts: int = 3) -> list[CopyEvent]:
    fill_key, is_new = store.record_fill(fill)
    events: list[CopyEvent] = []

    for rule in store.active_rules(fill.leader_account_id):
        follower = rule.follower_account_id
        target = target_position(
            store.leader_position(fill.leader_account_id, fill.symbol), rule.multiplier, rule.max_contracts
        )
        delta = target - store.committed_position(follower, fill.symbol)
        side = Side.BUY if delta > 0 else Side.SELL if delta < 0 else fill.side

        event, created = store.claim(
            fill_key, follower, client_order_id(fill_key, follower), fill.symbol, side, abs(delta),
            CopyStatus.PENDING if delta else CopyStatus.SKIPPED,
        )
        if event.status in (CopyStatus.PENDING, CopyStatus.FAILED):
            # Latency is only meaningful for a fresh fill copied on first sight.
            started = fill.received_at if (is_new and created) else None
            _execute(event, store, broker, max_attempts, started, fresh=created)
        events.append(event)

    return events


def retry_open_events(store: Store, broker: Broker, max_attempts: int = 1) -> list[CopyEvent]:
    events = store.open_events()
    for event in events:
        _execute(event, store, broker, max_attempts, started=None, fresh=False)
    return events


def _execute(event: CopyEvent, store: Store, broker: Broker, max_attempts: int, started, fresh: bool) -> None:
    for i in range(max_attempts):
        event.attempts += 1
        # Only the very first send of a claim made in this call is guaranteed new to the broker.
        may_exist = not (fresh and i == 0)
        try:
            result = broker.place_order(event.order(may_exist))
            event.broker_order_id = result.broker_order_id
        except DuplicateOrderError as e:
            # The broker already has this exact order: we sent it before and crashed before saving.
            event.broker_order_id = e.existing.broker_order_id
        except BrokerError as e:
            event.status, event.error = CopyStatus.FAILED, str(e)
            store.save(event)
            log.warning("copy failed: follower=%s attempt=%d err=%s", event.follower_account_id, event.attempts, e)
            continue
        except Exception as e:  # never let one follower's surprise error block the rest
            event.status, event.error = CopyStatus.FAILED, f"unexpected: {e!r}"
            store.save(event)
            log.exception("unexpected error copying to %s", event.follower_account_id)
            continue

        event.status, event.error = CopyStatus.PLACED, None
        event.placed_at = utcnow()
        if started is not None:
            event.latency_ms = (event.placed_at - started).total_seconds() * 1000
        store.save(event)
        return

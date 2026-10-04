"""Spec for the copy engine. Runs against both the in-memory and the Postgres store."""

import random

import pytest

from parallax.broker import SimulatedBroker
from parallax.models import CopyRule, CopyStatus, Fill, OrderRequest, Side
from parallax.sizing import client_order_id, target_position
from parallax.sync import handle_leader_fill, retry_open_events

from .conftest import acct

LEADER = acct("leader-1")
A, B = acct("a"), acct("b")
SYM = "MNQZ6"


def fill(fid="f1", side=Side.BUY, qty=2, symbol=SYM):
    return Fill(leader_account_id=LEADER, broker_fill_id=fid, symbol=symbol, side=side, qty=qty, price=21000.25)


def by_follower(events):
    return {e.follower_account_id: e for e in events}


# ---------- basic copying ----------

def test_copies_to_every_active_follower(make_store):
    store, broker = make_store([CopyRule(LEADER, A), CopyRule(LEADER, B)]), SimulatedBroker()

    events = by_follower(handle_leader_fill(fill(), store, broker))

    assert set(events) == {A, B}
    assert all(e.status == CopyStatus.PLACED for e in events.values())
    assert {(o.account_id, o.symbol, o.side, o.qty) for o in broker.orders} == {
        (A, SYM, Side.BUY, 2), (B, SYM, Side.BUY, 2),
    }


def test_inactive_rules_and_other_leaders_are_ignored(make_store):
    off, other_leader, c = acct("off"), acct("other-leader"), acct("c")
    store = make_store([CopyRule(LEADER, A), CopyRule(LEADER, off, active=False), CopyRule(other_leader, c)])
    broker = SimulatedBroker()

    handle_leader_fill(fill(), store, broker)

    assert [o.account_id for o in broker.orders] == [A]


def test_quantity_is_scaled_and_capped(make_store):
    double, capped = acct("double"), acct("capped")
    store = make_store([CopyRule(LEADER, double, multiplier=2), CopyRule(LEADER, capped, multiplier=3, max_contracts=4)])
    broker = SimulatedBroker()

    handle_leader_fill(fill(qty=2), store, broker)

    assert {o.account_id: o.qty for o in broker.orders} == {double: 4, capped: 4}


def test_sub_one_contract_is_skipped_not_rounded_up(make_store):
    tiny = acct("tiny")
    store, broker = make_store([CopyRule(LEADER, tiny, multiplier=0.25)]), SimulatedBroker()

    events = by_follower(handle_leader_fill(fill(qty=2), store, broker))

    assert events[tiny].status == CopyStatus.SKIPPED
    assert broker.calls == []


def test_side_is_preserved(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker()

    handle_leader_fill(fill(side=Side.SELL), store, broker)

    assert broker.orders[0].side == Side.SELL


def test_no_rules_means_no_orders(make_store):
    store, broker = make_store(), SimulatedBroker()

    assert handle_leader_fill(fill(), store, broker) == []
    assert broker.calls == []


# ---------- idempotency and failure handling ----------

def test_redelivered_fill_is_not_copied_twice(make_store):
    store, broker = make_store([CopyRule(LEADER, A), CopyRule(LEADER, B)]), SimulatedBroker()

    for _ in range(3):                         # websocket redelivers the same fill
        handle_leader_fill(fill(), store, broker)

    assert len(broker.orders) == 2
    assert len(broker.calls) == 2              # doesn't even ask the broker again


def test_one_follower_failing_does_not_block_others(make_store):
    store = make_store([CopyRule(LEADER, A), CopyRule(LEADER, B)])
    broker = SimulatedBroker(fail_accounts={A})

    events = by_follower(handle_leader_fill(fill(), store, broker))

    assert events[A].status == CopyStatus.FAILED and events[A].error
    assert events[B].status == CopyStatus.PLACED


def test_unexpected_exception_is_contained(make_store):
    class ExplodingForA(SimulatedBroker):
        def place_order(self, order):
            if order.account_id == A:
                raise RuntimeError("socket closed")
            return super().place_order(order)

    store, broker = make_store([CopyRule(LEADER, A), CopyRule(LEADER, B)]), ExplodingForA()

    events = by_follower(handle_leader_fill(fill(), store, broker))

    assert events[A].status == CopyStatus.FAILED
    assert events[B].status == CopyStatus.PLACED


def test_transient_error_is_retried(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker(fail_times={A: 1})

    events = by_follower(handle_leader_fill(fill(), store, broker))

    assert events[A].status == CopyStatus.PLACED
    assert events[A].attempts == 2
    assert len(broker.orders) == 1


def test_gives_up_after_max_attempts(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker(fail_accounts={A})

    events = by_follower(handle_leader_fill(fill(), store, broker, max_attempts=3))

    assert events[A].status == CopyStatus.FAILED
    assert events[A].attempts == 3
    assert len(broker.calls) == 3


def test_failed_copy_is_retried_when_fill_is_redelivered(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker(fail_accounts={A})
    handle_leader_fill(fill(), store, broker, max_attempts=1)

    broker.fail_accounts.clear()
    events = by_follower(handle_leader_fill(fill(), store, broker, max_attempts=1))

    assert events[A].status == CopyStatus.PLACED
    assert len(broker.orders) == 1


def test_sweeper_retries_failed_events(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker(fail_accounts={A})
    handle_leader_fill(fill(), store, broker, max_attempts=1)

    broker.fail_accounts.clear()
    retry_open_events(store, broker)

    assert broker.net_position(A, SYM) == 2
    assert store.open_events() == []


def test_failed_order_is_not_doubled_by_the_next_fill(make_store):
    """A failed order will be retried, so the next fill must not ALSO try to make up for it."""
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker(fail_accounts={A})
    handle_leader_fill(fill("f1", qty=2), store, broker, max_attempts=1)    # fails, will retry

    broker.fail_accounts.clear()
    handle_leader_fill(fill("f2", qty=1), store, broker)                    # should buy 1, not 3
    retry_open_events(store, broker)                                        # now the 2 goes through

    assert broker.net_position(A, SYM) == 3


def test_crash_between_send_and_save_does_not_duplicate(make_store):
    """The worker sent the order, then died before recording it. On restart the fill is redelivered."""
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker()

    f = fill()
    key, _ = store.record_fill(f)
    cid = client_order_id(key, A)
    store.claim(key, A, cid, SYM, Side.BUY, 2)                              # left PENDING
    sent = broker.place_order(OrderRequest(A, SYM, Side.BUY, 2, cid))       # broker DID get it

    events = by_follower(handle_leader_fill(f, store, broker))

    assert events[A].status == CopyStatus.PLACED
    assert events[A].broker_order_id == sent.broker_order_id
    assert len(broker.orders) == 1


# ---------- position tracking (the drift fix) ----------

def test_round_trip_leaves_follower_flat(make_store):
    store, broker = make_store([CopyRule(LEADER, A, multiplier=2)]), SimulatedBroker()

    handle_leader_fill(fill("open", Side.BUY, 3), store, broker)
    assert broker.net_position(A, SYM) == 6

    handle_leader_fill(fill("close", Side.SELL, 3), store, broker)
    assert broker.net_position(A, SYM) == 0


def test_cap_does_not_cause_drift(make_store):
    """The bug the first simulator run found: per-fill capping left followers off the leader."""
    store, broker = make_store([CopyRule(LEADER, A, multiplier=3, max_contracts=5)]), SimulatedBroker()

    for i in range(3):
        handle_leader_fill(fill(f"buy{i}", Side.BUY, 1), store, broker)
    assert broker.net_position(A, SYM) == 5                # capped at 5, not 9

    handle_leader_fill(fill("sell", Side.SELL, 3), store, broker)
    assert broker.net_position(A, SYM) == 0                # leader flat -> follower flat


def test_fractional_multiplier_accumulates(make_store):
    store, broker = make_store([CopyRule(LEADER, A, multiplier=0.5)]), SimulatedBroker()

    handle_leader_fill(fill("b1", Side.BUY, 1), store, broker)
    assert broker.net_position(A, SYM) == 0                # 0.5 -> 0
    handle_leader_fill(fill("b2", Side.BUY, 1), store, broker)
    assert broker.net_position(A, SYM) == 1                # 1.0 -> 1
    handle_leader_fill(fill("s1", Side.SELL, 2), store, broker)
    assert broker.net_position(A, SYM) == 0


def test_reversal_through_zero(make_store):
    store, broker = make_store([CopyRule(LEADER, A, max_contracts=3)]), SimulatedBroker()

    handle_leader_fill(fill("long", Side.BUY, 2), store, broker)
    handle_leader_fill(fill("flip", Side.SELL, 6), store, broker)          # leader goes to -4

    assert broker.net_position(A, SYM) == -3                               # capped on the short side too
    assert broker.orders[-1].side == Side.SELL and broker.orders[-1].qty == 5


def test_missed_fill_self_heals(make_store):
    """Fill f1 got recorded but the worker died before copying it. The next fill catches up."""
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker()
    store.record_fill(fill("f1", Side.BUY, 2))                             # recorded, never copied

    handle_leader_fill(fill("f2", Side.BUY, 1), store, broker)
    assert broker.net_position(A, SYM) == 3

    handle_leader_fill(fill("f1", Side.BUY, 2), store, broker)             # late redelivery
    assert broker.net_position(A, SYM) == 3
    assert len(broker.orders) == 1


def test_symbols_are_tracked_separately(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker()

    handle_leader_fill(fill("nq", Side.BUY, 2, "MNQZ6"), store, broker)
    handle_leader_fill(fill("es", Side.SELL, 1, "MESZ6"), store, broker)

    assert broker.net_position(A, "MNQZ6") == 2
    assert broker.net_position(A, "MESZ6") == -1


# ---------- latency ----------

def test_latency_is_recorded_for_fresh_fills_only(make_store):
    store, broker = make_store([CopyRule(LEADER, A)]), SimulatedBroker(fail_accounts={A})
    handle_leader_fill(fill("f1"), store, broker, max_attempts=1)          # fails
    broker.fail_accounts.clear()
    handle_leader_fill(fill("f2", qty=1), store, broker)                   # fresh, succeeds
    retry_open_events(store, broker)                                       # f1 retried later

    events = {e.fill_key: e for e in [*store.events_for(store.record_fill(fill("f1"))[0]),
                                      *store.events_for(store.record_fill(fill("f2", qty=1))[0])]}
    lat = [e.latency_ms for e in events.values()]
    assert sum(x is not None for x in lat) == 1                            # only f2's copy is timed
    assert all(x is None or x >= 0 for x in lat)


# ---------- randomized end-to-end ----------

@pytest.mark.parametrize("seed", range(5))
def test_random_session_ends_on_target(make_store, seed):
    """Random fills, redeliveries, transient failures and a final sweep: every follower must end
    exactly at target_position(leader net). This is the property the whole system exists for."""
    rng = random.Random(seed)
    rules = [
        CopyRule(LEADER, acct("x1")),
        CopyRule(LEADER, acct("x2"), multiplier=2),
        CopyRule(LEADER, acct("cap"), multiplier=3, max_contracts=5),
        CopyRule(LEADER, acct("half"), multiplier=0.5),
        CopyRule(LEADER, acct("flaky")),
    ]
    store, broker = make_store(rules), SimulatedBroker()

    sent = []
    for i in range(60):
        if sent and rng.random() < 0.15:
            f = rng.choice(sent)
        else:
            f = fill(f"f{i}", rng.choice(list(Side)), rng.randint(1, 4), rng.choice([SYM, "MESZ6"]))
            sent.append(f)
        if rng.random() < 0.2:
            broker.fail_times[acct("flaky")] = rng.randint(1, 4)
        handle_leader_fill(f, store, broker, max_attempts=2)

    broker.fail_times.clear()
    retry_open_events(store, broker)

    for sym in (SYM, "MESZ6"):
        leader_net = sum(f.signed_qty for f in sent if f.symbol == sym)
        for r in rules:
            assert broker.net_position(r.follower_account_id, sym) == target_position(
                leader_net, r.multiplier, r.max_contracts
            ), (sym, r)

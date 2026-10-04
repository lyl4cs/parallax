"""Run a fake trading session end to end, no broker or database needed.

    cd worker && python -m parallax.simulate

Random leader fills (with redeliveries and a flaky follower), copied through the real sync
engine, then a reconciliation: every follower must sit exactly at its target position.
The timing printed here is in-process only (no network). It is NOT a resume number.
"""

from __future__ import annotations

import logging
import random
import statistics
import time

from .broker import SimulatedBroker
from .models import CopyRule, CopyStatus, Fill, Side
from .sizing import target_position
from .store import InMemoryStore
from .sync import handle_leader_fill, retry_open_events

LEADER = "leader-1"
SYMBOLS = ("MNQZ6", "MESZ6")


def main(n_fills: int = 500, seed: int = 7) -> bool:
    logging.getLogger("parallax.sync").setLevel(logging.ERROR)   # retries are expected here
    rng = random.Random(seed)
    rules = [
        CopyRule(LEADER, "follower-1x"),
        CopyRule(LEADER, "follower-2x", multiplier=2),
        CopyRule(LEADER, "follower-3x-cap5", multiplier=3, max_contracts=5),
        CopyRule(LEADER, "follower-half", multiplier=0.5),
        CopyRule(LEADER, "follower-flaky"),
    ]
    store, broker = InMemoryStore(rules), SimulatedBroker()

    sent: list[Fill] = []
    timings: list[float] = []
    for i in range(n_fills):
        if sent and rng.random() < 0.1:
            f = rng.choice(sent)                                   # websocket redelivery
        else:
            f = Fill(LEADER, f"fill-{i}", rng.choice(SYMBOLS), rng.choice(list(Side)), rng.randint(1, 3), 21000.0)
            sent.append(f)
        if rng.random() < 0.1:
            broker.fail_times["follower-flaky"] = rng.randint(1, 4)  # outage longer than the retry budget
        start = time.perf_counter()
        handle_leader_fill(f, store, broker, max_attempts=2)
        timings.append((time.perf_counter() - start) * 1000)

    open_before = len(store.open_events())
    broker.fail_times.clear()
    retry_open_events(store, broker)

    statuses = [e.status for e in store.events.values()]
    print(f"leader fills: {len(sent)} unique, {n_fills} handled incl. redeliveries")
    print(f"follower orders sent: {len(broker.orders)}   open before final sweep: {open_before}")
    print("copy events: " + ", ".join(f"{s.value} {statuses.count(s)}" for s in CopyStatus))

    ok = True
    print("\nreconciliation (follower net vs target):")
    for sym in SYMBOLS:
        leader_net = sum(f.signed_qty for f in sent if f.symbol == sym)
        print(f"  {sym}: leader net {leader_net:+d}")
        for r in rules:
            target = target_position(leader_net, r.multiplier, r.max_contracts)
            actual = broker.net_position(r.follower_account_id, sym)
            ok &= actual == target
            print(f"    {r.follower_account_id:<18} target {target:+d}  actual {actual:+d}  {'OK' if actual == target else 'DRIFT'}")

    q = statistics.quantiles(timings, n=100)
    print(f"\nin-process copy time: p50 {q[49]:.3f} ms, p99 {q[98]:.3f} ms (simulated, NOT a real latency)")
    print("RESULT:", "all followers on target" if ok else "DRIFT DETECTED")
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)

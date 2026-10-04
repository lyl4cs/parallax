"""Health report from the live database: python -m parallax.report

- copy latency percentiles over the last 24h (the honest number for a resume, once it's real)
- reconciliation: every follower's recorded position vs the target implied by its leader
- open (pending/failed) copies

Exit code 1 if any follower is off target, so it can run as a cron alert.
"""

from __future__ import annotations

import os

from .sizing import target_position

RECONCILE_SQL = """
select r.follower_account_id, fa.broker_account as follower, la.broker_account as leader,
       lp.symbol, lp.net_qty as leader_net, r.multiplier, r.max_contracts,
       coalesce(fp.net_qty, 0) as follower_net
from copy_rules r
join accounts fa on fa.id = r.follower_account_id
join accounts la on la.id = r.leader_account_id
join leader_positions lp on lp.account_id = r.leader_account_id
left join follower_positions fp on fp.account_id = r.follower_account_id and fp.symbol = lp.symbol
where r.active
order by la.broker_account, fa.broker_account, lp.symbol
"""


def main(dsn: str | None = None) -> bool:
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(dsn or os.environ["DATABASE_URL"], row_factory=dict_row) as c:
        lat = c.execute("select * from copy_latency_24h").fetchone()
        if lat["copies"]:
            print(f"copy latency, last 24h ({lat['copies']} copies): p50 {float(lat['p50_ms']):.1f} ms, "
                  f"p95 {float(lat['p95_ms']):.1f} ms, p99 {float(lat['p99_ms']):.1f} ms, max {float(lat['max_ms']):.1f} ms")
        else:
            print("copy latency: no copies in the last 24h")

        ok = True
        print("\nreconciliation:")
        for r in c.execute(RECONCILE_SQL).fetchall():
            target = target_position(r["leader_net"], float(r["multiplier"]), r["max_contracts"])
            good = r["follower_net"] == target
            ok &= good
            print(f"  {r['leader']} -> {r['follower']} {r['symbol']}: target {target:+d}, "
                  f"recorded {r['follower_net']:+d}  {'OK' if good else 'DRIFT'}")

        open_ = c.execute("select status, count(*) as n from copy_events where status in ('pending','failed') "
                          "group by status").fetchall()
        print("\nopen copies:", ", ".join(f"{o['status']} {o['n']}" for o in open_) or "none")
    return ok


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)

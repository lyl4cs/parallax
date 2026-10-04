"""Database-level guarantees: constraints, row-level security, derived views. Postgres only."""

import psycopg
import pytest

from .conftest import acct

ALICE, BOB = acct("alice"), acct("bob")


@pytest.fixture
def db(pg_dsn):
    with psycopg.connect(pg_dsn, autocommit=True) as conn:
        conn.execute("truncate accounts cascade")
        conn.execute("grant select on all tables in schema public to authenticated")
        accts = {
            "a_lead": (ALICE, "leader"), "a_fol": (ALICE, "follower"),
            "b_lead": (BOB, "leader"), "b_fol": (BOB, "follower"),
        }
        ids = {}
        for name, (owner, role) in accts.items():
            ids[name] = acct(name)
            conn.execute("insert into accounts (id, owner_id, broker_account, role) values (%s, %s, %s, %s)",
                         (ids[name], owner, name, role))
        for lead, fol in (("a_lead", "a_fol"), ("b_lead", "b_fol")):
            conn.execute("insert into copy_rules (leader_account_id, follower_account_id) values (%s, %s)",
                         (ids[lead], ids[fol]))
            fill_id = conn.execute(
                """insert into leader_fills (leader_account_id, broker_fill_id, symbol, side, qty, price, filled_at)
                   values (%s, %s, 'MNQZ6', 'buy', 2, 21000, now()) returning id""",
                (ids[lead], f"{lead}-1"),
            ).fetchone()[0]
            conn.execute(
                """insert into copy_events (leader_fill_id, follower_account_id, client_order_id, symbol, side, qty,
                                            status, placed_at, latency_ms)
                   values (%s, %s, %s, 'MNQZ6', 'buy', 2, 'placed', now(), %s)""",
                (fill_id, ids[fol], f"cid-{lead}", 40 if lead == "a_lead" else 60),
            )
        conn.ids = ids
        yield conn
        conn.execute("reset role")


def as_user(conn, user_id):
    conn.execute("set role authenticated")
    conn.execute("select set_config('request.jwt.claim.sub', %s, false)", (user_id,))


def test_users_only_see_their_own_rows(db):
    as_user(db, ALICE)
    assert {r[0] for r in db.execute("select broker_account from accounts")} == {"a_lead", "a_fol"}
    assert db.execute("select count(*) from copy_rules").fetchone()[0] == 1
    assert db.execute("select count(*) from leader_fills").fetchone()[0] == 1
    assert db.execute("select count(*) from copy_events").fetchone()[0] == 1


def test_anonymous_sees_nothing(db):
    db.execute("set role authenticated")
    db.execute("select set_config('request.jwt.claim.sub', '', false)")
    for table in ("accounts", "copy_rules", "leader_fills", "copy_events"):
        assert db.execute(f"select count(*) from {table}").fetchone()[0] == 0, table


def test_users_cannot_write_directly(db):
    db.execute("grant insert, update on copy_rules to authenticated")
    as_user(db, ALICE)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        db.execute("insert into copy_rules (leader_account_id, follower_account_id) values (%s, %s)",
                   (db.ids["b_lead"], db.ids["a_fol"]))


def test_position_views_respect_rls(db):
    as_user(db, BOB)
    rows = db.execute("select account_id, symbol, net_qty from follower_positions").fetchall()
    assert [(str(a), s, q) for a, s, q in rows] == [(db.ids["b_fol"], "MNQZ6", 2)]
    assert len(db.execute("select * from leader_positions").fetchall()) == 1


def test_latency_view(db):
    row = db.execute("select copies, p50_ms, max_ms from copy_latency_24h").fetchone()
    assert row[0] == 2 and float(row[1]) == 50.0 and float(row[2]) == 60.0


def test_one_copy_per_fill_per_follower(db):
    fill_id = db.execute("select leader_fill_id from copy_events limit 1").fetchone()[0]
    fol = db.execute("select follower_account_id from copy_events where leader_fill_id = %s", (fill_id,)).fetchone()[0]
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute("""insert into copy_events (leader_fill_id, follower_account_id, client_order_id, symbol, side, qty, status)
                      values (%s, %s, 'another-id', 'MNQZ6', 'buy', 1, 'pending')""", (fill_id, fol))


def test_same_broker_fill_cannot_be_recorded_twice(db):
    with pytest.raises(psycopg.errors.UniqueViolation):
        db.execute("""insert into leader_fills (leader_account_id, broker_fill_id, symbol, side, qty, price, filled_at)
                      values (%s, 'a_lead-1', 'MNQZ6', 'buy', 2, 21000, now())""", (db.ids["a_lead"],))


@pytest.mark.parametrize("sql", [
    "insert into copy_rules (leader_account_id, follower_account_id, multiplier) values ('{a}', '{b}', 0)",
    "insert into copy_rules (leader_account_id, follower_account_id) values ('{a}', '{a}')",
    "insert into copy_rules (leader_account_id, follower_account_id, max_contracts) values ('{a}', '{b}', 0)",
])
def test_rule_constraints(db, sql):
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute(sql.format(a=db.ids["b_lead"], b=db.ids["a_fol"]))


@pytest.mark.parametrize("status, qty", [("skipped", 1), ("placed", 0), ("pending", 0)])
def test_skipped_iff_zero_qty(db, status, qty):
    fill_id = db.execute("select id from leader_fills limit 1").fetchone()[0]
    with pytest.raises(psycopg.errors.CheckViolation):
        db.execute("""insert into copy_events (leader_fill_id, follower_account_id, client_order_id, symbol, side, qty, status)
                      values (%s, %s, %s, 'MNQZ6', 'buy', %s, %s)""",
                   (fill_id, db.ids["b_fol"], f"x-{status}-{qty}", qty, status))


def test_realtime_publication_includes_copy_events(db):
    tables = {r[0] for r in db.execute(
        "select tablename from pg_publication_tables where pubname = 'supabase_realtime'")}
    assert {"copy_events", "leader_fills"} <= tables

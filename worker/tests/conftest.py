"""Shared fixtures.

Every sync test runs twice: once against InMemoryStore and once against PostgresStore
on a real Postgres with the production migration applied. Postgres runs are skipped unless
PARALLAX_TEST_DSN is set (or `pgserver` is installed, which gives a throwaway local server).
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest

from parallax.models import CopyRule
from parallax.store import InMemoryStore

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("*.sql"))

# Supabase provides these; plain Postgres doesn't. Just enough to apply the migration as-is.
SUPABASE_SHIM = """
create schema if not exists auth;
-- Same mechanism Supabase uses: the user id comes from the request's JWT claims.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
grant usage on schema auth to authenticated;
grant usage on schema public to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
"""


def acct(name: str) -> str:
    """Stable UUID for a readable test account name."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"parallax-test/{name}"))


@pytest.fixture(scope="session")
def pg_dsn(tmp_path_factory):
    dsn = os.environ.get("PARALLAX_TEST_DSN")
    server = None
    if not dsn:
        try:
            import pgserver
        except ImportError:
            pytest.skip("no PARALLAX_TEST_DSN and pgserver not installed")
        server = pgserver.get_server(str(tmp_path_factory.mktemp("pg")), cleanup_mode="stop")
        dsn = server.get_uri()

    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("drop schema public cascade; create schema public;")
        conn.execute(SUPABASE_SHIM)
        for m in MIGRATIONS:
            conn.execute(m.read_text())
    yield dsn
    if server is not None:
        server.cleanup()


@pytest.fixture(params=["memory", "postgres"])
def make_store(request):
    created = []

    def factory(rules: list[CopyRule] | None = None):
        rules = rules or []
        if request.param == "memory":
            return InMemoryStore(rules)

        from parallax.store import PostgresStore

        dsn = request.getfixturevalue("pg_dsn")
        store = PostgresStore(dsn)
        created.append(store)
        c = store.conn
        c.execute("truncate accounts cascade")
        leaders = {r.leader_account_id for r in rules} | {acct("leader-1")}  # tests' default leader
        followers = {r.follower_account_id for r in rules} - leaders
        owner = acct("owner")
        for i, a in enumerate(sorted(leaders)):
            c.execute("insert into accounts (id, owner_id, broker_account, role) values (%s, %s, %s, 'leader')",
                      (a, owner, f"L{i}"))
        for i, a in enumerate(sorted(followers)):
            c.execute("insert into accounts (id, owner_id, broker_account, role) values (%s, %s, %s, 'follower')",
                      (a, owner, f"F{i}"))
        for r in rules:
            c.execute(
                """insert into copy_rules (leader_account_id, follower_account_id, multiplier, max_contracts, active)
                   values (%s, %s, %s, %s, %s)""",
                (r.leader_account_id, r.follower_account_id, r.multiplier, r.max_contracts, r.active),
            )
        return store

    yield factory
    for s in created:
        s.close()

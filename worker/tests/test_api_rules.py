"""Tests for the Vercel function api/rules.py, served by a real local HTTP server with Supabase faked."""

import importlib.util
import json
import threading
import urllib.error
import urllib.request
from http.server import HTTPServer
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[2] / "api" / "rules.py"
ALICE, BOB = "alice-id", "bob-id"
ACCOUNTS = {"a-lead": ALICE, "a-fol": ALICE, "b-fol": BOB}
TOKENS = {"alice-jwt": ALICE, "bob-jwt": BOB}


@pytest.fixture
def server():
    spec = importlib.util.spec_from_file_location("rules_api", API)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    writes = []
    rules = {"rule-1": {"follower_account_id": "a-fol"}}

    def fake_request(method, path, token, body=None):
        if path == "/auth/v1/user":
            return (200, {"id": TOKENS[token]}) if token in TOKENS else (401, {"msg": "bad jwt"})
        if path.startswith("/rest/v1/accounts"):
            owner = path.split("owner_id=eq.")[1].split("&")[0]
            ids = path.split("id=in.(")[1].rstrip(")").split(",")
            return 200, [{"id": i} for i in ids if ACCOUNTS.get(i) == owner]
        if method == "GET" and path.startswith("/rest/v1/copy_rules"):
            rid = path.split("id=eq.")[1]
            return 200, [rules[rid]] if rid in rules else []
        writes.append((method, path, body))
        return 201, [body]

    mod._request = fake_request
    httpd = HTTPServer(("127.0.0.1", 0), mod.handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", writes
    httpd.shutdown()


def call(base, method, body, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base, method=method, data=json.dumps(body).encode(), headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_create_rule(server):
    base, writes = server
    status, _ = call(base, "POST", {"leader_account_id": "a-lead", "follower_account_id": "a-fol", "multiplier": 2}, "alice-jwt")
    assert status == 201
    assert writes == [("POST", "/rest/v1/copy_rules", {"leader_account_id": "a-lead", "follower_account_id": "a-fol",
                                                        "multiplier": 2.0, "max_contracts": None})]


def test_requires_auth(server):
    base, writes = server
    assert call(base, "POST", {"leader_account_id": "a-lead", "follower_account_id": "a-fol"})[0] == 401
    assert call(base, "POST", {"leader_account_id": "a-lead", "follower_account_id": "a-fol"}, "forged")[0] == 401
    assert writes == []


def test_cannot_copy_into_someone_elses_account(server):
    base, writes = server
    status, _ = call(base, "POST", {"leader_account_id": "a-lead", "follower_account_id": "b-fol"}, "alice-jwt")
    assert status == 403 and writes == []


@pytest.mark.parametrize("body", [
    {"leader_account_id": "a-lead"},
    {"leader_account_id": "a-lead", "follower_account_id": "a-lead"},
    {"leader_account_id": "a-lead", "follower_account_id": "a-fol", "multiplier": 0},
    {"leader_account_id": "a-lead", "follower_account_id": "a-fol", "multiplier": "lots"},
])
def test_rejects_bad_rules(server, body):
    base, writes = server
    assert call(base, "POST", body, "alice-jwt")[0] == 400 and writes == []


def test_pause_own_rule(server):
    base, writes = server
    status, _ = call(base, "PATCH", {"id": "rule-1", "active": False}, "alice-jwt")
    assert status in (200, 201)
    assert writes == [("PATCH", "/rest/v1/copy_rules?id=eq.rule-1", {"active": False})]


def test_cannot_pause_someone_elses_rule(server):
    base, writes = server
    assert call(base, "PATCH", {"id": "rule-1", "active": False}, "bob-jwt")[0] == 403
    assert call(base, "PATCH", {"id": "missing", "active": False}, "bob-jwt")[0] == 404
    assert writes == []

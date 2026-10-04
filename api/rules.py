"""Vercel serverless endpoint: manage copy rules.

POST /api/rules   {"leader_account_id", "follower_account_id", "multiplier"?, "max_contracts"?}
PATCH /api/rules  {"id", "active"}  (pause/resume copying)

Reads go straight from the dashboard to Supabase (row-level security limits users to their own
rows). Writes come through here so the server can check that the caller owns BOTH accounts
before using the service-role key. Never ship the service-role key to the browser.

Untested scaffold: deploy to a Vercel preview and hit it with curl before trusting it.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


def _request(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, object]:
    req = urllib.request.Request(
        f"{SUPABASE_URL}{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode(errors="replace")}


def _current_user_id(user_jwt: str) -> str | None:
    status, body = _request("GET", "/auth/v1/user", user_jwt)
    return body.get("id") if status == 200 and isinstance(body, dict) else None


def _owns(user_id: str, account_ids: list[str]) -> bool:
    ids = ",".join(urllib.parse.quote(a) for a in account_ids)
    status, rows = _request(
        "GET", f"/rest/v1/accounts?select=id&owner_id=eq.{user_id}&id=in.({ids})", SERVICE_KEY
    )
    return status == 200 and len(rows) == len(set(account_ids))


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: object) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _auth(self) -> str | None:
        header = self.headers.get("Authorization", "")
        return _current_user_id(header[7:]) if header.startswith("Bearer ") else None

    def _json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

    def do_POST(self) -> None:
        user_id = self._auth()
        if not user_id:
            return self._send(401, {"error": "unauthorized"})
        try:
            data = self._json()
            leader, follower = data["leader_account_id"], data["follower_account_id"]
            multiplier = float(data.get("multiplier", 1))
            max_contracts = data.get("max_contracts")
        except (KeyError, ValueError, json.JSONDecodeError):
            return self._send(400, {"error": "leader_account_id and follower_account_id are required"})
        if leader == follower or multiplier <= 0:
            return self._send(400, {"error": "invalid rule"})
        if not _owns(user_id, [leader, follower]):
            return self._send(403, {"error": "you must own both accounts"})

        status, body = _request("POST", "/rest/v1/copy_rules", SERVICE_KEY, {
            "leader_account_id": leader,
            "follower_account_id": follower,
            "multiplier": multiplier,
            "max_contracts": max_contracts,
        })
        self._send(201 if status in (200, 201) else status, body)

    def do_PATCH(self) -> None:
        user_id = self._auth()
        if not user_id:
            return self._send(401, {"error": "unauthorized"})
        try:
            data = self._json()
            rule_id, active = data["id"], bool(data["active"])
        except (KeyError, json.JSONDecodeError):
            return self._send(400, {"error": "id and active are required"})

        status, rows = _request(
            "GET", f"/rest/v1/copy_rules?select=follower_account_id&id=eq.{urllib.parse.quote(rule_id)}", SERVICE_KEY
        )
        if status != 200 or not rows:
            return self._send(404, {"error": "rule not found"})
        if not _owns(user_id, [rows[0]["follower_account_id"]]):
            return self._send(403, {"error": "not your rule"})

        status, body = _request(
            "PATCH", f"/rest/v1/copy_rules?id=eq.{urllib.parse.quote(rule_id)}", SERVICE_KEY, {"active": active}
        )
        self._send(status, body)

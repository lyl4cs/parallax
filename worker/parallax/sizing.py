"""Position sizing and order ids.

Sizing works on POSITIONS, not individual fills. Scaling each fill separately lets rounding
and caps accumulate into drift (e.g. three 1-lot buys at 0.5x round to 0+0+0, but a 3-lot sell
rounds to 1, leaving the follower short a contract the leader never held). Instead:

    follower_target = clamp(trunc(leader_position * multiplier), -cap, +cap)
    order           = follower_target - follower_position

so the follower always converges to where it should be, whatever happened before.
"""

from __future__ import annotations

import hashlib
import math


def target_position(leader_position: int, multiplier: float, max_contracts: int | None = None) -> int:
    """Where the follower's net position should be, given the leader's net position.

    Truncates TOWARD ZERO: the follower never holds more exposure than leader * multiplier,
    long or short. The cap limits the absolute size of the position, not of each order.
    """
    if multiplier <= 0:
        raise ValueError("multiplier must be positive")
    if max_contracts is not None and max_contracts <= 0:
        raise ValueError("max_contracts must be positive")

    scaled = leader_position * multiplier
    # Nudge by epsilon toward the far side of zero so float noise (0.1 * 30 = 2.9999...) doesn't lose a contract.
    target = math.trunc(scaled + math.copysign(1e-9, scaled)) if scaled else 0
    if max_contracts is not None:
        target = max(-max_contracts, min(max_contracts, target))
    return target


def client_order_id(fill_key: str, follower_account_id: str) -> str:
    """Deterministic order id for (leader fill, follower).

    The same inputs always give the same id, so if the worker crashes after sending an order
    but before saving the result, the retry sends an order with the SAME id and the broker
    can reject it as a duplicate instead of opening a second position.
    """
    digest = hashlib.sha256(f"{fill_key}:{follower_account_id}".encode()).hexdigest()
    return f"px-{digest[:24]}"

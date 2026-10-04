import pytest

from parallax.sizing import client_order_id, target_position


@pytest.mark.parametrize(
    "leader, mult, cap, expected",
    [
        (0, 1, None, 0),
        (2, 1, None, 2),
        (2, 2, None, 4),
        (3, 0.5, None, 1),      # 1.5 -> 1, toward zero
        (-3, 0.5, None, -1),    # -1.5 -> -1, toward zero (never more exposure than intended)
        (1, 0.5, None, 0),
        (10, 3, 12, 12),        # capped long
        (-10, 3, 12, -12),      # capped short
        (30, 0.1, None, 3),     # float noise (0.1 * 30 = 2.9999...) doesn't lose a contract
        (-30, 0.1, None, -3),
    ],
)
def test_target_position(leader, mult, cap, expected):
    assert target_position(leader, mult, cap) == expected


@pytest.mark.parametrize("mult, cap", [(0, None), (-1, None), (1, 0), (1, -2)])
def test_target_position_rejects_bad_input(mult, cap):
    with pytest.raises(ValueError):
        target_position(1, mult, cap)


def test_client_order_id_is_deterministic_and_distinct():
    assert client_order_id("fill-1", "a") == client_order_id("fill-1", "a")
    assert client_order_id("fill-1", "a") != client_order_id("fill-1", "b")
    assert client_order_id("fill-1", "a") != client_order_id("fill-2", "a")

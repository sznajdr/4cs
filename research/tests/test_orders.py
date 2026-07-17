from fourcs.orders import OrderTracker, replay_order_events
from fourcs.tape import TapeRecord


def entry(order_id, odds=-110, sum_untaken=100.0, taken_ratio=0.0, **extra):
    return {
        "id": order_id, "odds": odds, "sumUntaken": sum_untaken, "takenRatio": taken_ratio,
        "bet": sum_untaken, "createdAt": "2026-07-15T20:00:00.000Z", **extra,
    }


def test_seed_frame_emits_nothing():
    tracker = OrderTracker()
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 1000)
    assert events == []
    assert tracker.stats.seeds == 1
    assert tracker.bucket_total("g1", "homeMoneylines") == 100.0


def test_place_fill_cancel_taxonomy():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 1000, mv_now=10.0)

    # New id -> place.
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a"), entry("b", odds=-120, sum_untaken=50.0)], 2000, mv_now=10.0)
    assert [e["event"] for e in events] == ["place"]
    assert events[0]["order_id"] == "b" and events[0]["delta_size"] == 50.0

    # In-place decrease -> fill_partial with negative delta.
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a", sum_untaken=60.0), entry("b", odds=-120, sum_untaken=50.0)], 3000, mv_now=50.0)
    assert [e["event"] for e in events] == ["fill_partial"]
    assert events[0]["delta_size"] == -40.0 and events[0]["remaining"] == 60.0
    assert events[0]["mv_gap_delta"] == 40.0

    # Vanish with flat mv -> cancel; taken_ratio ~1 -> fill_complete.
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a", sum_untaken=60.0, taken_ratio=0.9999999)], 4000, mv_now=50.0)
    assert [e["event"] for e in events] == ["cancel"]
    assert events[0]["order_id"] == "b" and events[0]["delta_size"] == -50.0

    events = tracker.observe_ladder("g1", "homeMoneylines", [], 5000, mv_now=50.0)
    assert [e["event"] for e in events] == ["fill_complete"]
    assert tracker.bucket_total("g1", "homeMoneylines") == 0.0


def test_vanish_with_mv_activity_is_ambiguous():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 1000, mv_now=10.0)
    events = tracker.observe_ladder("g1", "homeMoneylines", [], 2000, mv_now=95.0)
    assert [e["event"] for e in events] == ["vanish_ambiguous"]
    assert events[0]["mv_gap_delta"] == 85.0


def test_float_noise_is_not_an_event():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a", taken_ratio=5e-8)], 1000)
    # takenRatio noise (incl. negative) and sub-cent size wiggle: no events.
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a", sum_untaken=100.001, taken_ratio=-9e-8)], 2000)
    assert events == []


def test_reprice_and_resize():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 1000)
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a", odds=-125)], 2000)
    assert [e["event"] for e in events] == ["reprice"]
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a", odds=-125, sum_untaken=250.0)], 3000)
    assert [e["event"] for e in events] == ["resize_up"]
    assert events[0]["delta_size"] == 150.0


def test_idless_ladder_resets_then_reseeds():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 1000)
    # REST-rendered levels carry no id: silent reset, no fabricated cancels.
    events = tracker.observe_ladder("g1", "homeMoneylines", [{"odds": -110, "sumUntaken": 500}], 2000)
    assert events == [] and tracker.stats.idless_resets == 1
    # Next id-bearing frame re-seeds silently (no fake places), then diffs.
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a"), entry("b")], 3000)
    assert events == [] and tracker.stats.seeds == 2
    events = tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 4000)
    assert [e["event"] for e in events] == ["cancel"]


def test_telescoping_drift_is_zero_over_mixed_flow():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a")], 1000)
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a"), entry("b", sum_untaken=30.0)], 2000)
    tracker.observe_ladder("g1", "homeMoneylines", [entry("a", sum_untaken=20.0), entry("b", sum_untaken=30.0)], 3000)
    tracker.observe_ladder("g1", "homeMoneylines", [entry("b", sum_untaken=45.0)], 4000)
    report = tracker.drift()
    assert report["buckets_over_eps"] == 0
    assert report["worst_abs_drift"] < 0.01
    assert tracker.bucket_total("g1", "homeMoneylines") == 45.0


def test_spread_line_and_p_best_prior():
    tracker = OrderTracker()
    tracker.observe_ladder("g1", "homeSpreads", [entry("a", odds=100, spread=-1.5), entry("b", odds=-110, spread=-2.5)], 1000)
    events = tracker.observe_ladder("g1", "homeSpreads", [entry("b", odds=-110, spread=-2.5)], 2000)
    assert events[0]["event"] == "cancel"
    assert events[0]["line"] == -1.5
    assert events[0]["market"] == "spread"
    assert abs(events[0]["p_best_prior"] - 0.5) < 1e-9  # best takeable = min prob = +100


def make_game(game_id="g1"):
    return {
        "id": game_id,
        "league": "nba",
        "start": "2026-07-20T00:00:00.000Z",
        "participants": [
            {"id": "home1", "homeAway": "home"},
            {"id": "away1", "homeAway": "away"},
        ],
        "homeMoneylines": [entry("seed1")],
    }


def test_replay_routes_and_enriches():
    def records():
        yield TapeRecord(1000, "rest", "catalogSnapshot", {"games": [make_game()]})
        yield TapeRecord(2000, "price", "orderUpdate", {
            "gameID": "g1", "type": "moneyline", "participantID": "home1", "epoch": 7,
            "sideOrders": [entry("seed1"), entry("n1", odds=-130, sum_untaken=25.0)],
        })
        yield TapeRecord(3000, "user", "placed", {"gameID": "g1"})  # account event: skipped

    rows = list(replay_order_events(records()))
    assert [r["event"] for r in rows] == ["place"]
    row = rows[0]
    assert row["order_id"] == "n1" and row["bucket"] == "homeMoneylines" and row["market"] == "moneyline"
    assert row["league"] == "nba" and row["kickoff_ms"] is not None and row["live"] is False
    assert row["epoch"] == 7.0 and row["low_confidence"] is False
    assert isinstance(row["order_age_ms"], int)  # createdAt parsed; toy ts makes it negative


def test_full_game_resync_marks_low_confidence():
    def records():
        yield TapeRecord(1000, "rest", "catalogSnapshot", {"games": [make_game()]})
        game = make_game()
        game["homeMoneylines"] = [entry("seed1"), entry("n2", odds=-140, sum_untaken=10.0)]
        yield TapeRecord(2000, "price", "gameUpdate", game)

    rows = list(replay_order_events(records()))
    assert [r["event"] for r in rows] == ["place"]
    assert rows[0]["low_confidence"] is True

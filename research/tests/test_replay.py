import json

from fourcs.replay import ReplayStats, replay
from fourcs.tape import TapeRecord, iter_tape


def make_game(game_id="g1"):
    return {
        "id": game_id,
        "league": "nba",
        "start": "2026-07-20T00:00:00.000Z",
        "mainHomeSpread": -1.5,
        "mainTotal": 220.5,
        "participants": [
            {"id": "home1", "homeAway": "home"},
            {"id": "away1", "homeAway": "away"},
        ],
        "homeMoneylines": [{"odds": -110, "sumUntaken": 500}],
        "awayMoneylines": [{"odds": -110, "sumUntaken": 400}],
        "homeSpreads": [{"odds": -105, "sumUntaken": 200, "spread": -1.5}],
        "awaySpreads": [{"odds": -115, "sumUntaken": 250, "spread": 1.5}],
    }


def records():
    yield TapeRecord(1000, "rest", "catalogSnapshot", {"games": [make_game()]})
    yield TapeRecord(2000, "price", "orderUpdate", {
        "gameID": "g1", "type": "moneyline", "participantID": "home1",
        "sideOrders": [{"odds": -120, "sumUntaken": 700}],
    })
    yield TapeRecord(3000, "price", "matchedVolumeUpdate", {"gameID": "g1", "matchedVolume": 42.0})
    yield TapeRecord(4000, "user", "placed", {"gameID": "g1"})  # account event: skipped


def test_end_to_end_replay_rows():
    stats = ReplayStats()
    rows = list(replay(records(), stats))

    baseline_rows = [r for r in rows if r["baseline"]]
    assert {r["market"] for r in baseline_rows} == {"moneyline", "spread"}
    ml_baseline = next(r for r in baseline_rows if r["market"] == "moneyline")
    assert 0 < ml_baseline["mid"] < 1
    assert abs(ml_baseline["overround"] - 0.0476) < 1e-3
    assert ml_baseline["main_spread"] == -1.5 and ml_baseline["main_total"] == 220.5
    assert not ml_baseline["live"]

    book_rows = [r for r in rows if r["event_type"] == "book"]
    assert {r["market"] for r in book_rows} == {"moneyline"}  # only touched market re-emitted
    assert book_rows[0]["depth1_h"] == 700
    assert book_rows[0]["age_a_ms"] == 1000  # away side still from the baseline

    mv_rows = [r for r in rows if r["event_type"] == "mv"]
    assert all(r["matched_volume"] == 42.0 for r in mv_rows)
    assert stats.events == 4 and stats.mv_events == 1


def test_bucket_before_discovery_then_self_heal():
    def late_records():
        yield TapeRecord(500, "price", "orderUpdate", {
            "gameID": "g1", "type": "moneyline", "participantID": "home1",
            "sideOrders": [{"odds": -130, "sumUntaken": 10}],
        })
        yield TapeRecord(1000, "price", "gameUpdate", make_game())

    stats = ReplayStats()
    rows = list(replay(late_records(), stats))
    assert stats.skipped_unknown_game == 1
    assert rows and rows[0]["event_type"] == "game"


def test_metadata_bootstrap_routes_orphan_bucket_events():
    """Pre-Phase-0 tape era: no baselines, but seeded shells route bucket events."""
    def orphan_records():
        yield TapeRecord(500, "price", "orderUpdate", {
            "gameID": "g1", "type": "moneyline", "participantID": "home1",
            "sideOrders": [{"odds": -130, "sumUntaken": 10}],
        })

    stats = ReplayStats()
    rows = list(replay(orphan_records(), stats, seed_games=[make_game()]))
    assert stats.seeded_games == 1 and stats.skipped_unknown_game == 0
    assert len(rows) == 1
    row = rows[0]
    assert row["market"] == "moneyline" and row["depth1_h"] == 10
    assert row["p_a"] is None  # away side never taped: unknown, not fabricated
    assert row["mid"] is None
    assert row["main_spread"] is None  # price-bearing fields are not seeded
    assert row["league"] == "nba" and row["kickoff_ms"] is not None


def test_iter_tape_tolerates_garbage(tmp_path):
    tape = tmp_path / "tape-2026-07-17.jsonl"
    good = json.dumps({
        "receivedAt": "2026-07-17T10:00:00.000Z", "source": "price",
        "type": "gameUpdate", "payload": make_game(),
    })
    tape.write_text("not json\n" + good + "\n{\"broken\": true}\n", encoding="utf-8")
    parsed = list(iter_tape([tape]))
    assert len(parsed) == 1 and parsed[0].type == "gameUpdate"

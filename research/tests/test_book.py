from fourcs.book import BookState


def make_game(game_id="g1", **extra):
    return {
        "id": game_id,
        "league": "nba",
        "start": "2026-07-20T00:00:00.000Z",
        "participants": [
            {"id": "home1", "homeAway": "home"},
            {"id": "away1", "homeAway": "away"},
        ],
        "homeMoneylines": [{"odds": -110, "sumUntaken": 500}],
        "awayMoneylines": [{"odds": -110, "sumUntaken": 400}],
        **extra,
    }


def test_full_game_absorb_marks_all_buckets_known():
    state = BookState()
    result = state.apply_price_event("gameUpdate", make_game(), ts_ms=1000)
    assert result.full_game and result.game_id == "g1"
    assert state.bucket_age_ms("g1", "over", 3000) == 2000


def test_nested_game_payload_is_unwrapped():
    state = BookState()
    result = state.apply_price_event("gameUpdate", {"game": make_game("g2")}, ts_ms=1000)
    assert result.game_id == "g2"


def test_bucket_event_for_unknown_game_is_ignored():
    state = BookState()
    result = state.apply_price_event(
        "orderUpdate", {"gameID": "ghost", "homeMoneylines": [{"odds": -120}]}, ts_ms=1000
    )
    assert result.game_id is None


def test_bucket_replacement_via_side_orders_routing():
    state = BookState()
    state.apply_price_event("gameUpdate", make_game(), ts_ms=1000)
    result = state.apply_price_event(
        "orderUpdate",
        {"gameID": "g1", "type": "moneyline", "participantID": "home1",
         "sideOrders": [{"odds": -125, "sumUntaken": 900}]},
        ts_ms=2000,
    )
    assert result.buckets == {"homeMoneylines"}
    assert state.games["g1"]["homeMoneylines"][0]["odds"] == -125
    # away ladder untouched
    assert state.games["g1"]["awayMoneylines"][0]["odds"] == -110


def test_matched_volume_delta_and_reset():
    state = BookState()
    state.apply_price_event("gameUpdate", make_game(), ts_ms=1000)
    first = state.apply_price_event("matchedVolumeUpdate", {"gameID": "g1", "matchedVolume": 100.0}, 2000)
    assert first.mv_delta == 0.0  # no prior baseline
    second = state.apply_price_event("matchedVolumeUpdate", {"gameID": "g1", "matchedVolume": 150.0}, 3000)
    assert second.mv_delta == 50.0 and not second.mv_reset
    reset = state.apply_price_event("matchedVolumeUpdate", {"gameID": "g1", "matchedVolume": 20.0}, 4000)
    assert reset.mv_delta == 0.0 and reset.mv_reset


def test_market_closed_flags_not_open():
    state = BookState()
    state.apply_price_event("gameUpdate", make_game(), ts_ms=1000)
    assert state.is_open("g1")
    state.apply_price_event("gameUpdate", make_game(messageType="marketClosed"), ts_ms=2000)
    assert not state.is_open("g1")

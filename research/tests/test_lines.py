from fourcs.lines import game_key_books, markets_for_buckets, summarize_side
from fourcs.probs import american_to_prob


def test_best_price_is_max_decimal_payout():
    # +120 pays more than -110: it is the best takeable price = min prob
    side = summarize_side([
        {"odds": -110, "sumUntaken": 300},
        {"odds": 120, "sumUntaken": 100},
    ])
    assert side.p_best == american_to_prob(120)
    assert side.depth1 == 100
    assert side.untaken == 400


def test_zero_size_levels_are_not_takeable():
    side = summarize_side([{"odds": 150, "sumUntaken": 0}, {"odds": -110, "sumUntaken": 50}])
    assert side.p_best == american_to_prob(-110)


def test_spread_lines_pair_home_minus_x_with_away_plus_x():
    game = {
        "id": "g1",
        "participants": [],
        "homeSpreads": [
            {"odds": -110, "sumUntaken": 100, "spread": -1.5},
            {"odds": -105, "sumUntaken": 80, "spread": -2.5},
        ],
        "awaySpreads": [{"odds": -110, "sumUntaken": 120, "spread": 1.5}],
    }
    books = game_key_books(game)
    assert ("spread", -1.5) in books and ("spread", -2.5) in books
    side_h, side_a = books[("spread", -1.5)]
    assert side_h.untaken == 100 and side_a.untaken == 120
    # -2.5 has no away pairing yet -> empty a side
    assert books[("spread", -2.5)][1].p_best is None


def test_totals_pair_same_line_and_1x2_pairs_yes_no():
    game = {
        "id": "g1",
        "participants": [],
        "over": [{"odds": -110, "sumUntaken": 50, "total": 2.5}],
        "under": [{"odds": -110, "sumUntaken": 60, "total": 2.5}],
        "draw1x2": [
            {"odds": 250, "sumUntaken": 30, "side": "yes"},
            {"odds": -300, "sumUntaken": 40, "side": "no"},
        ],
    }
    books = game_key_books(game)
    assert books[("total", 2.5)][0].untaken == 50
    assert books[("total", 2.5)][1].untaken == 60
    draw_h, draw_a = books[("1x2_draw", None)]
    assert draw_h.p_best == american_to_prob(250)
    assert draw_a.p_best == american_to_prob(-300)


def test_markets_for_buckets_routing():
    assert markets_for_buckets({"homeMoneylines"}) == {"moneyline"}
    assert markets_for_buckets({"homeSpreads", "under"}) == {"spread", "total"}
    assert markets_for_buckets({"draw1x2"}) == {"1x2_draw"}

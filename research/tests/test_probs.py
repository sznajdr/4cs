from fourcs.probs import (
    american_to_decimal,
    american_to_prob,
    devig_power,
    devig_proportional,
    pair_mid,
    pair_overround,
)


def test_american_to_decimal_matches_ts_semantics():
    assert american_to_decimal(100) == 2.0
    assert american_to_decimal(-110) == 1 + 100 / 110
    assert american_to_decimal(250) == 3.5
    assert american_to_decimal(-100) == 2.0
    assert american_to_decimal(50) is None  # invalid American band
    assert american_to_decimal(-50) is None


def test_prob_space_monotonic_across_boundary():
    # -105 (fav) -> +105 (dog) is one continuous move down in prob space
    p_minus = american_to_prob(-105)
    p_even = american_to_prob(100)
    p_plus = american_to_prob(105)
    assert p_minus > p_even > p_plus


def test_pair_mid_and_overround():
    p_h = american_to_prob(-110)  # 0.5238
    p_a = american_to_prob(-110)
    assert abs(pair_overround(p_h, p_a) - 0.0476) < 1e-3
    assert abs(pair_mid(p_h, p_a) - 0.5) < 1e-9
    # mid must sit inside [bid, ask] = [1-p_a, p_h]
    assert 1 - p_a <= pair_mid(p_h, p_a) <= p_h


def test_devig_sums_to_one():
    probs = [american_to_prob(-150), american_to_prob(130)]
    for method in (devig_proportional, devig_power):
        fair = method(probs)
        assert abs(sum(fair) - 1.0) < 1e-6

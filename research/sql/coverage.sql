-- Data coverage census: events, keys, and time span per league/market.
-- duckdb -c ".read sql/coverage.sql" (run from research/, adjust path as needed)
SELECT
  league,
  market,
  count(*)                                   AS rows,
  count(DISTINCT game_id)                    AS games,
  count(DISTINCT (game_id, market, line))    AS keys,
  strftime(to_timestamp(min(ts_ms) / 1000), '%Y-%m-%d %H:%M')  AS first_event,
  strftime(to_timestamp(max(ts_ms) / 1000), '%Y-%m-%d %H:%M')  AS last_event,
  round(avg(overround), 4)                   AS avg_overround
FROM read_parquet('data/book_events/**/*.parquet')
GROUP BY 1, 2
ORDER BY rows DESC;

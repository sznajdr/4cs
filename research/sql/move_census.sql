-- Large-move census: how often does the mid move >= 2 prob points within 5m?
-- Feeds the event-study threshold choice.
WITH sampled AS (
  SELECT game_id, market, line, ts_ms, mid,
         lead(mid) OVER w AS next_mid,
         lead(ts_ms) OVER w AS next_ts
  FROM read_parquet('data/book_events/**/*.parquet')
  WHERE mid IS NOT NULL AND NOT live
  WINDOW w AS (PARTITION BY game_id, market, line ORDER BY ts_ms)
)
SELECT
  market,
  count(*) AS transitions,
  sum(CASE WHEN abs(next_mid - mid) >= 0.02 AND next_ts - ts_ms <= 300000 THEN 1 ELSE 0 END) AS big_moves_5m,
  round(avg(abs(next_mid - mid)), 5) AS avg_abs_move
FROM sampled
WHERE next_mid IS NOT NULL
GROUP BY 1
ORDER BY transitions DESC;

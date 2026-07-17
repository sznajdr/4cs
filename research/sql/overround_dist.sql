-- Overround distribution per market: how expensive is this exchange's book?
SELECT
  market,
  count(*) AS rows,
  round(quantile_cont(overround, 0.10), 4) AS p10,
  round(quantile_cont(overround, 0.50), 4) AS p50,
  round(quantile_cont(overround, 0.90), 4) AS p90,
  round(min(overround), 4) AS min,
  round(max(overround), 4) AS max
FROM read_parquet('data/book_events/**/*.parquet')
WHERE overround IS NOT NULL
GROUP BY 1
ORDER BY rows DESC;

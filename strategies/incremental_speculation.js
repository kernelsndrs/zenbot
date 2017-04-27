module.exports = {
  options: {
    period: "1h",
    min_lookback: 36,
    fee_pct: 0.25,
    trend_ema: 36,
    price_ema: 6,
    start_capital: 1000,
    rsi_periods: 14
  }
}

// 1,000 captial, 1h period
//
// 12 ema
// 1425, -2.81%
// 20 ema
// 1416, -3.44%
// 26 ema
// 1476, 0.62%
// 20 ema
// 1416, -3.44%
// 30 ema
// 1490, 1.62%
// 33 ema
// 1479, 0.87%
// 34 ema
// 1459, -0.51%
// 35 ema X
// 1518, 3.49%
// 36 ema X
// 1537, 4.77%
// 37 ema
// 1487, 1.41%
// 40 ema
// 1421, -3.10%

// 2h period
//
// 20 ema
// 1439, -1.43%
// 22 ema
// 1447, -0.88%
// 24 ema
// 1395, -4.45%
// 26 ema
// 1358, -6.96%
// 36 ema
// 1277, -12.51%

// 30m period
//
// 24 ema
// 1301, -11.46%
// 30 ema
// 1308, -11.03%
// 36 ema
// 1398, -4.90%

// 1d period
//
// 36 ema X
// 1164, -19.78%
// 20 ema X



// rsi strategy, 1h period
//
// 12 periods
// 1185, -19.20%
// 14 periods
// 1344, -8.39%
// 16 periods
// 1299, -11.42%
// 20 periods
// 1053, -28.22%
// 
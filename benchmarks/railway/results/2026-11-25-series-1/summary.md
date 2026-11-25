# Paired runs: Railway iad, first series

Generated 2026-11-25T17:05:24.126Z from 12 pair.json files under `benchmarks/railway/results/raw/2026-11-25-series-1/velasia-bench`.
Only comparable pairs are compared. Latency is in ms, as k6 measures it from the load
generator, so it includes the network to the storefront. "API" columns come from the shared
API's own metrics during the run (gate). Resource use of the storefronts themselves is not
in these files: Railway service metrics are recorded separately.

## Comparable pairs

| Workload      | Round | Runtime (position) | Offered /s | Requests | Req/s | p50 | p95  | p99   | TTFB p95 | Failed | Compressed | k6 CPU peak | API CPU peak | API probe p50 peak | API requests |
| ------------- | ----- | ------------------ | ---------- | -------- | ----- | --- | ---- | ----- | -------- | ------ | ---------- | ----------- | ------------ | ------------------ | ------------ |
| static-assets | 1     | node (1)           | 2          | 123      | 2.0   | 5.7 | 11.5 | 16.4  | 8.7      | 0.0 %  | 100.0 %    | 0.04        | 0.014        | 4.3                | 0            |
| static-assets | 1     | nextrs (2)         | 2          | 123      | 2.0   | 4.1 | 7.1  | 11.5  | 6.3      | 0.0 %  | 100.0 %    | 0.04        | 0.015        | 3.6                | 0            |
| static-assets | 2     | node (2)           | 2          | 123      | 2.0   | 6.2 | 16.1 | 19.0  | 11.1     | 0.0 %  | 100.0 %    | 0.04        | 0.017        | 5.1                | 0            |
| static-assets | 2     | nextrs (1)         | 2          | 122      | 2.0   | 4.6 | 9.7  | 15.7  | 8.8      | 0.0 %  | 100.0 %    | 0.03        | 0.017        | 4.2                | 0            |
| rsc           | 1     | node (1)           | 2          | 122      | 2.0   | 7.0 | 13.0 | 20.2  | 8.9      | 0.0 %  | 100.0 %    | 0.03        | 0.018        | 3.9                | 0            |
| rsc           | 1     | nextrs (2)         | 2          | 121      | 2.0   | 7.8 | 13.3 | 15.7  | 12.6     | 0.0 %  | 100.0 %    | 0.04        | 0.015        | 3.8                | 0            |
| rsc           | 2     | node (2)           | 2          | 122      | 2.0   | 6.1 | 11.8 | 22.1  | 8.3      | 0.0 %  | 100.0 %    | 0.04        | 0.012        | 5.0                | 0            |
| rsc           | 2     | nextrs (1)         | 2          | 121      | 2.0   | 7.9 | 15.2 | 23.5  | 12.4     | 0.0 %  | 100.0 %    | 0.03        | 0.011        | 5.5                | 0            |
| static-assets | 1     | node (1)           | 5          | 302      | 5.0   | 5.8 | 12.7 | 20.3  | 9.5      | 0.0 %  | 100.0 %    | 0.07        | 0.015        | 5.5                | 0            |
| static-assets | 1     | nextrs (2)         | 5          | 303      | 5.0   | 4.1 | 8.5  | 15.3  | 6.9      | 0.0 %  | 100.0 %    | 0.07        | 0.017        | 4.6                | 0            |
| static-assets | 2     | node (2)           | 5          | 303      | 5.0   | 6.0 | 12.3 | 19.6  | 9.4      | 0.0 %  | 100.0 %    | 0.06        | 0.024        | 5.1                | 0            |
| static-assets | 2     | nextrs (1)         | 5          | 302      | 5.0   | 4.7 | 10.6 | 21.8  | 9.6      | 0.0 %  | 100.0 %    | 0.06        | 0.017        | 3.8                | 0            |
| rsc           | 1     | node (1)           | 5          | 302      | 5.0   | 6.5 | 13.1 | 20.5  | 10.7     | 0.0 %  | 100.0 %    | 0.05        | 0.013        | 3.5                | 0            |
| rsc           | 1     | nextrs (2)         | 5          | 302      | 5.0   | 6.8 | 11.1 | 17.6  | 9.8      | 0.0 %  | 100.0 %    | 0.06        | 0.013        | 4.3                | 0            |
| rsc           | 2     | node (2)           | 5          | 301      | 5.0   | 6.0 | 11.8 | 35.5  | 8.2      | 0.0 %  | 100.0 %    | 0.06        | 0.011        | 4.5                | 0            |
| rsc           | 2     | nextrs (1)         | 5          | 302      | 5.0   | 6.7 | 12.7 | 18.0  | 11.2     | 0.0 %  | 100.0 %    | 0.06        | 0.028        | 5.1                | 0            |
| static-assets | 1     | node (1)           | 10         | 603      | 10.0  | 6.0 | 13.0 | 25.9  | 9.5      | 0.0 %  | 100.0 %    | 0.11        | 0.010        | 4.5                | 0            |
| static-assets | 1     | nextrs (2)         | 10         | 603      | 10.0  | 3.9 | 8.6  | 14.3  | 7.1      | 0.0 %  | 100.0 %    | 0.12        | 0.010        | 3.7                | 0            |
| static-assets | 2     | node (2)           | 10         | 602      | 10.0  | 5.3 | 11.9 | 16.9  | 8.6      | 0.0 %  | 100.0 %    | 0.11        | 0.011        | 4.3                | 0            |
| static-assets | 2     | nextrs (1)         | 10         | 603      | 10.0  | 4.1 | 11.0 | 343.8 | 9.6      | 0.0 %  | 100.0 %    | 0.11        | 0.010        | 4.8                | 0            |
| rsc           | 1     | node (1)           | 10         | 601      | 10.0  | 5.7 | 11.1 | 19.3  | 8.3      | 0.0 %  | 100.0 %    | 0.10        | 0.011        | 3.3                | 0            |
| rsc           | 1     | nextrs (2)         | 10         | 602      | 10.0  | 6.7 | 11.2 | 22.2  | 10.5     | 0.0 %  | 100.0 %    | 0.09        | 0.013        | 4.0                | 0            |
| rsc           | 2     | node (2)           | 10         | 602      | 10.0  | 5.8 | 11.3 | 17.2  | 8.5      | 0.0 %  | 100.0 %    | 0.10        | 0.011        | 3.8                | 0            |
| rsc           | 2     | nextrs (1)         | 10         | 602      | 10.0  | 6.6 | 13.3 | 26.5  | 12.6     | 0.0 %  | 100.0 %    | 0.08        | 0.011        | 3.5                | 0            |

## Stopped or not comparable

_None._

## Files

- `rate2/round-1/static-assets/pair.json`: comparable
- `rate2/round-2/static-assets/pair.json`: comparable
- `rate2/round-1/rsc/pair.json`: comparable
- `rate2/round-2/rsc/pair.json`: comparable
- `rate5/round-1/static-assets/pair.json`: comparable
- `rate5/round-2/static-assets/pair.json`: comparable
- `rate5/round-1/rsc/pair.json`: comparable
- `rate5/round-2/rsc/pair.json`: comparable
- `rate10/round-1/static-assets/pair.json`: comparable
- `rate10/round-2/static-assets/pair.json`: comparable
- `rate10/round-1/rsc/pair.json`: comparable
- `rate10/round-2/rsc/pair.json`: comparable

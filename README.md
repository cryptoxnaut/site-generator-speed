# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/cryptoxnaut/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/cryptoxnaut/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0: `solve.js` reimplements the static site generator from scratch (no vendor code copied) and returns byte-identical output for every case, faster than the house baseline. Built for the [site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).

## How it works

- `solve.js` is a dependency-free ES module whose `run(input)` returns makefun-site's answer for a case's input: the output tree (each page's `index.html`, the index and tag pages, `build-report.txt` and each static file), byte for byte.
- `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

## Verified

- Practice set: 3/3 cases byte-identical (kit scorer passed).
- Differential tests: 30 freshly generated cases, 0 mismatches; 134 hand-built adversarial edge cases, 0 failures.
- Timing on the practice set: ~1.63x faster end-to-end than the house baseline (makefun-site 1.0.0 itself).

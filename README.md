# markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/jose123hh/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/jose123hh/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer written from scratch for speed. It reproduces marked 18.1.3 output byte for byte across the CommonMark and GFM suites while running noticeably faster than the reference.

## Layout

- `parse.js` — the renderer itself: a single exported `parse` function, zero dependencies.
- `main.ts` — the batch harness: reads the case file, writes rendered HTML.

## Usage

```sh
node main.ts
```

The harness reads `/input/cases.json` and writes `/output/html.json`, one HTML string per case, in order.

---

Built for the bounty on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) — agents writing real software for real rewards.

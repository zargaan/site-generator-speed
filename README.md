[![make.fun · 
site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zargaan/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zargaan/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)


# site-generator-speed-01 entry: faster makefun-site 1.0.0 drop-in

Pure JavaScript, dependency-free, no WebAssembly / native addon / prebuilt
binary, nothing cached from one case to the next (every cache is created
inside `run()`). `solve.js` exports `run(input)` returning exactly what
makefun-site 1.0.0's `build` returns; `main.ts` is the house driver
(unchanged, including `--no-incremental-marking`).

## How it is faster (byte-identical semantics)

- **Markdown fused into one pass**: lexing and rendering are a single scan
  over the body's lines; inline rendering buffers plain runs and escapes
  them in bulk instead of one regex replace per character, and HTML-special
  characters are emitted as entities the moment they are seen.
- **Front matter**: body is kept as its split lines, so Markdown never
  re-joins and re-splits it; word counting for `reading_minutes` runs over
  those lines; `\r` normalisation is skipped when the text holds no `\r`.
- **Text**: `escapeHtml`/`slugify`/`wordsOf` are single-pass char-code loops.
  `slugify` has a per-run cache and an ASCII fast path that skips NFKD
  entirely (ASCII text normalises to itself); non-ASCII falls back to the
  reference algorithm verbatim.
- **Templates**: parsed once per case, then compiled to plain JS functions
  (`new Function`) with a single flattened scope object — a variable lookup
  is one property read, with save/restore around `for` loops (including the
  reference's rule that `loop` beats a loop variable of the same name, and
  the 8-deep include limit). Compiled templates return strings directly;
  a loop's `loop` record is one object per loop execution, fields rewritten
  per iteration (templates can only read it while that iteration renders).
- **Cards** are built once per source and reused for pages, index, tags
  and `recent` instead of being rebuilt per use.

## Verification (this VM, node v24.22.1)

- Practice set (3 cases): byte-identical to
  `practice/reference/expected.json` — 3/3 cases, verified through
  `main.ts` end-to-end and through the kit scorer.
- 6 extra cases generated from 2 unseen seeds with the kit's own
  generator (`program/generator/subject/sites.mjs` + `rng.ts`): 6/6
  identical to the reference. A hand-built adversarial case (loop variable
  named `loop`, self-recursive includes, nested shadowing, unclosed
  templates, colliding heading ids, unclosed fences/code spans, broken
  links, refused/draft sources): identical.
- CPU time for `run()` over the 3 practice cases (15 timed rounds,
  `process.cpuUsage`, warmup first): reference median 520 ms, this entry
  median 246 ms — about **2.1x faster** (min 467 ms vs 207 ms, 2.26x).

## What still needs the local route

Repo/push/submit: no GitHub credentials exist on this VM, so no repo was
created. Copy `solve.js`, `main.ts`, `package.json` (and this README) into
the entry repo and submit before Tue Nov 24, 2026 20:00 UTC
(Wed Nov 25 03:00 WIB). Entry total is well under the 4 MiB repo limit.

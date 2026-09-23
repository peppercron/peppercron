# peppercron

[![ci](https://github.com/peppercron/peppercron/actions/workflows/ci.yml/badge.svg)](https://github.com/peppercron/peppercron/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/peppercron.svg)](https://www.npmjs.com/package/peppercron)

Parse cron schedules in five common dialects — vixie, Kubernetes, GitHub Actions, Quartz and AWS —
and compute when they run, correctly across timezones and DST.

```sh
npm install peppercron
```

```ts
import { parse, next } from 'peppercron';

const s = parse('0 9 * * MON-FRI', { timezone: 'Europe/London' });
if (s.ok) next(s.value, { count: 2 });
```

Full API, options and examples: **[packages/core/README.md](packages/core/README.md)**.

## Why another cron library

Most cron libraries implement *a* cron. This one implements the cron you actually use, because the
five common dialects disagree — and they disagree most exactly where it hurts, on the two days a year
the clocks move.

| Dialect | A run in a spring-forward gap | A run in a fall-back overlap |
| --- | --- | --- |
| `vixie` (Linux crontab / cronie) | fixed-time job catches up at the end of the gap | fires once, on the first pass |
| `kubernetes` (robfig/cron v3) | silently skipped | fires **twice**, once per pass |
| `github-actions` | advances to the next valid time | first pass only (undocumented; assumed) |
| `quartz` | skipped | fires once, on the **second** pass |
| `aws` (EventBridge) | skipped | fires once, on the first pass |

Same expression, five different answers. A library that picks one and calls it "cron" is wrong for
four of your users.

Other properties, because a scheduling library that surprises you is worse than none:

- **Never throws.** `parse` returns a result; `next`, `prev` and `matches` return `[]` or `false`.
- **Zero runtime dependencies**, ESM + CJS, browser-safe, under 8 KB gzipped.
- **Every field and term carries its character span**, for editor underlines and error markers.
- **Intervals too** — Kubernetes `@every 1h30m` and EventBridge `rate(5 minutes)`.

## The corpus

`corpus/` is the source of truth, not the TypeScript. It is plain JSON plus prose evidence, with no
dependency on this implementation: dialect data, a closed list of behaviour strategies, JSON Schemas,
and 146 parse and run-time cases.

Two things make it worth looking at even if you never write a line of JavaScript:

- **[`corpus/DERIVATION.md`](corpus/DERIVATION.md)** records where every behaviour came from — read
  out of the cronie and Quartz source, out of robfig/cron v3 as pinned by Kubernetes, and out of
  GitHub's and AWS's own documentation, quoted with the file and line or the page.
- **[The Assumptions list](corpus/README.md#assumptions)** names every behaviour that *isn't*
  documented anywhere, and says what this project assumed instead. GitHub's fall-back behaviour is a
  guess. AWS's wildcard DST behaviour is a guess. They are labelled as guesses rather than dressed up
  as facts.

If a behaviour is not pinned by a case in the corpus, it is not a behaviour of this library. That
rule is also what makes ports to Go and Python tractable: reproduce the corpus, not the source.

## Layout

```
packages/core/     the library (published to npm as `peppercron`)
corpus/            dialect data, evidence and cases — the source of truth
.github/workflows/ CI: typecheck, test, build, bundle-size budget
```

## Status

`0.1.0`. The parser and the run-time engine are done for all five dialects, with 382 tests and
property tests over the DST transitions.

Planned, roughly in order: `lint` (flag expressions that are legal but don't mean what you think —
AWS's `?` rule first), `describe` (plain English), `convert` (between dialects), a CLI, the site, and
Go and Python ports built against the corpus.

## Development

```sh
npm install
npm test            # 382 tests across the suite and the corpus runner
npm run typecheck
npm run build
npm run size -w peppercron   # enforces the gzipped budget
```

The corpus is regenerated into the build automatically; `packages/core/src/generated/` is derived,
never edited by hand.

## Releasing

Tagging `vX.Y.Z` runs [`release.yml`](.github/workflows/release.yml), which refuses to publish
unless the tag matches `packages/core/package.json`, then publishes to npm with provenance.

It needs one repository secret, **`NPM_TOKEN`** — an npm granular access token with *Read and write*
on all packages. Nothing in npm's or GitHub's interface explains what that token is for, so: it
exists solely for that workflow, revoking it breaks releases and nothing else, and if it carries an
expiry the first release afterwards fails with a 401.

## Licence

MIT.

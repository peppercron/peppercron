# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major version is `0`, the
public API may still change in a minor release; each such change is listed here.

## 0.1.0 — 2026-09-21

First release. The parser and the run-time engine, for five dialects.

### Added

**Parsing.** `parse(input, opts?)` returns a `Result` — never throws, for any input, including one
that is not a string. Supports five dialects:

- `vixie` — Linux crontab, matching cronie
- `kubernetes` — a CronJob's `spec.schedule`, matching robfig/cron v3 as Kubernetes pins it
- `github-actions` — a workflow's `on.schedule` `cron:` entry
- `quartz` — Java Quartz's `CronExpression`, including `L`, `L-3`, `LW`, `15W`, `6L` and `6#3`
- `aws` — EventBridge's `cron(...)` and `rate(...)`

The dialect is detected when not given, and `candidates` names every dialect that reads the
expression identically rather than guessing between them. Macros (`@daily` and friends) and a
trailing crontab command are understood. Every field and term carries its `[start, end)` character
span into the untouched input, wrapper included.

**Run times.** `next`, `prev` and `matches`, each accepting a parsed `Schedule` or a string, with
`from`, `count`, `until` and `inclusive` options, returning the instant, the wall time with its
offset, and DST detail where it applies.

**DST, modelled per dialect rather than picked once.** A run in a spring-forward gap is caught up
(vixie), skipped (kubernetes, quartz, aws) or advanced to the next valid time (github-actions); a run
in a fall-back overlap fires on the first pass, the second pass, or both, depending on the dialect and
on whether the schedule is fixed-time or wildcard. Runs in a transition are tagged `skipped-adjusted`,
`ambiguous-first` or `ambiguous-second`.

**Intervals.** Kubernetes `@every 1h30m` (Go duration grammar) and EventBridge `rate(5 minutes)`,
parsed to `Schedule.interval` and computed arithmetically from an `anchor` option. The two platforms
disagree about the first run — Kubernetes fires one interval after the anchor, AWS at the anchor
itself — and both behaviours are reproduced.

**Custom timezone data.** `createCore(tz)` accepts an implementation of the small `Tz` interface, for
tests or a runtime without `Intl` zone support.

**The corpus.** `corpus/` holds the dialect data, the closed list of behaviour strategies, JSON
Schemas and 146 cases, with `DERIVATION.md` recording where each behaviour was read from — the cronie
and Quartz source, robfig/cron v3, and GitHub's and AWS's documentation — and an Assumptions list
naming every behaviour that no platform documents, so a guess is never presented as a fact.

### Notes

- Zero runtime dependencies. ESM and CommonJS builds with type declarations. 7668 bytes gzipped.
- Requires a runtime with `Intl.DateTimeFormat` timezone support.
- `describe`, `lint` and `convert` are planned and not in this release.

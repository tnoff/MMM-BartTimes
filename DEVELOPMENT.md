# Development

Local dev with a real MagicMirror harness, plus tests. User-facing
installation and config live in [README.md](README.md); for code
internals see [AGENTS.md](AGENTS.md).

## Prerequisites

- Node 20+ (CI runs `npm test` on Node 20 and 22; the built-in test
  runner is used)
- Git
- A browser to render the MagicMirror UI

## Install module dependencies

```bash
npm install
```

Three runtime deps only: `adm-zip`, `csv-parse`, `gtfs-realtime-bindings`.

## Local MagicMirror runner

`dev/run.sh` spins up a real MagicMirror with this repo symlinked as
a module:

```bash
./dev/run.sh
```

What it does:

1. Clones MagicMirror into `dev/MagicMirror/` (gitignored) if not
   already present. Override the source/branch with `MM_REPO` /
   `MM_REF` env vars.
2. Runs `npm install --omit=dev` inside MagicMirror.
3. Symlinks the repo to `dev/MagicMirror/modules/MMM-BartTimes`.
4. Copies `dev/config.js` to MagicMirror's config location.
5. Starts `npm run server` (server-only mode — no Electron, no native
   build).

Open the URL it prints (default `http://localhost:8080`) in any
browser. Edit `dev/config.js` to change the station or add other
modules.

## Tests

```bash
npm test
```

Uses Node's built-in `node --test` runner:

- `test/gtfs.test.js` — `lib/gtfs.js`, which is intentionally pure (no I/O,
  no MagicMirror dependencies — see
  [AGENTS.md](AGENTS.md#libgtfsjs-is-intentionally-pure)). Add new helper
  tests here.
- `test/fetching.test.js` — the retry policy in `lib/fetching.js`.
- `test/tracing.test.js` — span semantics against a real SDK.

## Iterating

The symlink in `dev/run.sh` is live — edit `MMM-BartTimes.js`,
`node_helper.js`, or `lib/gtfs.js` in the repo and restart the
MagicMirror server (Ctrl-C, re-run `./dev/run.sh`) to pick up
back-end changes. Front-end (`MMM-BartTimes.js`, `bart_times.css`)
takes effect on a browser reload.

## CI

GitHub Actions (`ci.yml`, PRs) runs `npm ci && npm test` on Node 20 and 22,
plus shared workflows from `tnoff/github-workflows`: `trufflehog.yml`,
`codeql.yml`, `check-workflow-contracts.yml`, and `bump-version.yml` on
`renovate/dev-*` PRs (bumps `version` in `package.json`).
`scheduled.yml` runs Renovate and branch cleanup; `notify-failure.yml` posts
failures to Discord.

## Releasing

There is no release job, git tag, or npm publish. The version lives in
`package.json` (CI bumps it on Renovate dependency PRs). Consumers pick up
changes by commit: `tnoff/magic-mirror-docker` pins this repo's `main` by
SHA (`ARG MMM_BARTTIMES_REF`, bumped by Renovate) and rebuilds the image.

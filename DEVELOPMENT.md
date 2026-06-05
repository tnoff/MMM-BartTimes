# Development

Local dev with a real MagicMirror harness, plus tests. User-facing
installation and config live in [README.md](README.md); for code
internals see [AGENTS.md](AGENTS.md).

## Prerequisites

- Node 22+ (Node's built-in test runner is used; older Nodes work for
  the module itself but not for `npm test`)
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

Uses Node's built-in `node --test` runner against
`test/gtfs.test.js`. All tests are against `lib/gtfs.js`, which is
intentionally pure (no I/O, no MagicMirror dependencies — see
[AGENTS.md](AGENTS.md#libgtfsjs-is-intentionally-pure)). Add new
helper tests to `test/gtfs.test.js`.

## Iterating

The symlink in `dev/run.sh` is live — edit `MMM-BartTimes.js`,
`node_helper.js`, or `lib/gtfs.js` in the repo and restart the
MagicMirror server (Ctrl-C, re-run `./dev/run.sh`) to pick up
back-end changes. Front-end (`MMM-BartTimes.js`, `bart_times.css`)
takes effect on a browser reload.

## Releasing

The version lives in `package.json`. Bump it on a release branch,
merge to `master`, push a matching `v<version>` git tag — there's no
publish-to-npm step; consumers clone the repo or pull the SHA via
their own MagicMirror Docker build (see
`tnoff-projects/magic-mirror-docker`).

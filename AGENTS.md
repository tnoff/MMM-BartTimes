# AGENTS.md

Guidance for AI coding agents working in this repository. For end-user
installation and config see [README.md](README.md); for local dev with
a MagicMirror harness and tests see [DEVELOPMENT.md](DEVELOPMENT.md).

## What this is

A MagicMirror² module that displays BART departure times and service
advisories for one station. Reads BART's GTFS-Realtime trip-update and
alerts feeds, joins them against the static GTFS schedule, and renders
the next few departures per headsign.

```
.
├── MMM-BartTimes.js   # Front-end module — renders the DOM, polls the helper
├── node_helper.js     # Back-end helper — fetches the feeds, holds static GTFS cache
├── lib/
│   └── gtfs.js        # Pure GTFS helpers (buildGtfsIndex, resolveStation,
│                      # extractDepartures, extractAdvisories) — no I/O, unit-tested
├── test/
│   └── gtfs.test.js   # Node's built-in test runner against lib/gtfs.js
├── dev/
│   ├── run.sh         # Spins up a local MagicMirror with this module symlinked
│   └── config.js      # The minimal MagicMirror config used by run.sh
├── bart_times.css     # Module styles
└── advisory.png       # README screenshot
```

## Non-obvious internals

### `lib/gtfs.js` is intentionally pure

`lib/gtfs.js` does **no I/O** and has zero MagicMirror dependencies. All
fetching lives in `node_helper.js`; `lib/gtfs.js` only takes parsed
GTFS objects and returns derived data structures. Keep it that way —
the test suite (`test/gtfs.test.js`) runs under Node's built-in test
runner with no mocks because the lib has nothing to mock.

If a new helper needs to fetch something, put the fetch in
`node_helper.js` and pass the result into a new pure function in
`lib/gtfs.js`.

### Static GTFS is cached for 24 hours with a singleflight guard

`node_helper.js` caches the static GTFS bundle (the
`google_transit.zip` from `bart.gov`) for 24 hours in process memory.
While a load is in flight, `getStaticGtfs()` returns the same promise
to every concurrent caller so we never fetch the 4 MB zip twice at
once. If you change the TTL, the constant is `STATIC_TTL_MS`. If you
add a new caller, return through `getStaticGtfs()` — don't call
`loadStaticGtfs()` directly.

### Station code matching is case-insensitive with `_` / `-` suffixes

BART's `stops.txt` has both parent stations (e.g. `DBRK`) and per-
platform stops (`DBRK_1`, `DBRK-N`). `resolveStation()` accepts either
form and walks the parent-station relationship to merge platforms.
User config supplies the parent code (e.g. `19TH`). If a user reports
"my station doesn't work", check that they used the parent code in
`stop_id`, not the GTFS `stop_name`.

### eBART trips often won't appear

The Pittsburg Center / Antioch line is run by a separate scheduling
system. Its trips are not always in the GTFS-Realtime trip-update
feed. This is upstream-BART behaviour, not a module bug. Don't add a
synthetic "fallback to static schedule" — that would conflict with
the realtime cancellation flags when the feed *is* live.

### `train_blacklist` matches GTFS `trip_headsign`, not custom strings

Headsigns come from `trips.txt` via `trip_headsign` (e.g.
`"Berryessa/North San Jose"`, `"SFIA"`, `"Richmond"`). User configs
written before the GTFS migration sometimes use short codes (`"DALY"`,
`"SFIA"`); only the SFIA case still happens to work because GTFS uses
the same string. If a user's blacklist stops filtering after an
upgrade, check what BART now publishes in `trip_headsign`.

### GTFS-RT requires no API key

`tripupdate.aspx` and `alerts.aspx` are public, unauthenticated, and
rate-limit-friendly. Don't reintroduce an API-key requirement — the
old V2 BART API has been retired and any "key" config from older
versions of this module is dead weight.

## Conventions

- New config options go in [README.md](README.md#configuration) with a
  type, default, and one-line description, matching the existing
  table.
- New pure helpers go in `lib/gtfs.js` with tests in
  `test/gtfs.test.js`.
- I/O stays in `node_helper.js`.
- CSS classes go in `bart_times.css`. No inline styles in
  `MMM-BartTimes.js` beyond what MagicMirror already requires.

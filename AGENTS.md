# AGENTS.md

Guidance for AI coding agents working in this repository. For end-user
installation and config see [README.md](README.md); for local dev with
a MagicMirror harness and tests see [DEVELOPMENT.md](DEVELOPMENT.md).

## What this is

A MagicMirror² module that displays departure times and service
advisories for one or more transit stops. Reads GTFS-Realtime trip-update
and alerts feeds, joins them against the static GTFS schedule, and renders
the next few departures per headsign. Two data providers: **BART**
(keyless, via bart.gov) and **511** (keyed, via api.511.org — covers all
Bay Area agencies). A single instance can render several stops as sections.

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

### Providers are just different feed URLs

`node_helper.js` has a `PROVIDERS` map (`bart`, `511`) that builds the
three feed URLs (trip updates, alerts, static GTFS zip) from a normalized
stop `{ provider, agency, apiKey, station }`. Everything downstream is
provider-agnostic — 511 serves the same GTFS-RT protobuf and static GTFS
zip (same `stops.txt`/`trips.txt`/`routes.txt`) as BART, so
`buildGtfsIndex` / `extractDepartures` / `extractAdvisories` are reused
unchanged. To add another GTFS provider, add an entry to `PROVIDERS`;
don't special-case anything in `lib/gtfs.js`.

The front-end normalizes both the legacy single-station config
(`station: '19TH'`) and the new `stops: [...]` list into one canonical
list in `normalizeStops()`, assigning each stop a stable `id`. Socket
requests carry `{ stop }`; responses echo `{ id, ... }` so the front-end
places each result in the right section (`this.stopData[id]`).

### `extractDepartures` returns a nested departures array

`extractDepartures` returns `{ station_name, departures: [{ headsign,
times }] }` (sorted by soonest). It used to return a flat object with
dynamic headsign keys alongside `station_name`/`trains`; that collided
with headsigns named like the reserved keys and didn't nest per stop.
If you touch its output, update `test/gtfs.test.js` to match.

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

`node_helper.js` caches the static GTFS bundle for 24 hours in process
memory, in a `Map` keyed per `(provider, agency)` — all BART stops share
the `bart` slot; each 511 agency gets its own (`511:SF`, …). Each slot
keeps a singleflight promise so concurrent callers never fetch the same
zip twice. If you change the TTL, the constant is `STATIC_TTL_MS`. If you
add a new caller, return through `getStaticGtfs(stop)` — don't call
`loadStaticGtfs(url)` directly.

Realtime feeds are additionally deduped per URL for a short window
(`FEED_DEDUPE_MS`, ~20s) via `fetchFeed(url)`, so N stops on the same
agency cost one trip-update / alerts request per refresh tick. This
protects the 511 token's hourly rate limit; a failed fetch is dropped
from the cache immediately so the next tick retries.

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

### Advisories: wrapped + truncated, muted by substring, not typed

`extractAdvisories` returns plain strings; the front-end renders each as one
wrapping `.bart-advisory` banner in `appendAdvisory` — NOT the old 40-char
manual chunker (which broke words mid-line). `advisoryMaxLength` truncates at a
word boundary with `…`; `maxAdvisories` caps the count; `advisory_blacklist`
(global + per-stop, case-insensitive substring) mutes recurring noise like the
Clipper / "Tap and Ride" ads. All three are front-end display filters
(alongside `train_blacklist`), so they live in `MMM-BartTimes.js`, not
`lib/gtfs.js` (the browser module can't `require` the lib).

Don't try to color/sort advisories by severity for BART: BART sends every alert
with `cause`/`effect`/`severityLevel` = `UNKNOWN` and `informedEntity` scoped to
`{agencyId:"BART"}` (never a stop), so all alerts are system-wide and untyped.
The fields exist in the GTFS-RT `Alert` message and some 511 agencies may
populate them, but BART does not.

### `train_blacklist` matches GTFS `trip_headsign`, not custom strings

Headsigns come from `trips.txt` via `trip_headsign` (e.g.
`"Berryessa/North San Jose"`, `"SFIA"`, `"Richmond"`). User configs
written before the GTFS migration sometimes use short codes (`"DALY"`,
`"SFIA"`); only the SFIA case still happens to work because GTFS uses
the same string. If a user's blacklist stops filtering after an
upgrade, check what BART now publishes in `trip_headsign`.

### BART GTFS-RT requires no API key; 511 does

BART's `tripupdate.aspx` and `alerts.aspx` are public, unauthenticated,
and rate-limit-friendly — don't reintroduce a key requirement for the
`bart` provider (the old V2 BART API was retired). The **511** provider
is different: every 511 endpoint requires an `api_key` query param, and
tokens are rate-limited (~60 req/hr), which is why 511 refresh intervals
are floored (≥90s) in the front-end and feeds are deduped in
`fetchFeed`. The key comes from `stop.apiKey` (per stop) or the
top-level `config.apiKey`.

## Conventions

- New config options go in [README.md](README.md#configuration) with a
  type, default, and one-line description, matching the existing
  table.
- New pure helpers go in `lib/gtfs.js` with tests in
  `test/gtfs.test.js`.
- I/O stays in `node_helper.js`.
- CSS classes go in `bart_times.css`. No inline styles in
  `MMM-BartTimes.js` beyond what MagicMirror already requires.

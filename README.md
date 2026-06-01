# MMM-BartTimes

Magic Mirror module that displays the upcoming departure times for all BART (Bay Area Rapid Transit) lines at a certain station, plus any active service advisories.

This module reads BART's [GTFS-Realtime](https://www.bart.gov/schedules/developers/gtfs-realtime) feeds (trip updates and service alerts) and joins them against the [static GTFS schedule](https://www.bart.gov/schedules/developers/gtfs) to compute live departure times. No API key or registration is required.

### Installation
1. Navigate to the magic mirror modules directory and clone this repository there.
2. Inside the `MMM-BartTimes` folder, run `npm install` to install dependencies.
3. Modify `config.js` to include `MMM-BartTimes`. An example config is below.

### Configuration

| Config Option | Type | Description |
|:------------- |:--------- |:----------- |
| `station` | string | The 4-letter station abbreviation (e.g. `DBRK`, `19TH`, `MONT`). Match is case-insensitive. Codes can be found in BART's [stops.txt](https://www.bart.gov/dev/schedules/google_transit.zip) (the `stop_id` column for parent stations). |
| `train_blacklist` | list of strings (optional) | Headsigns included in this list will not be displayed. Headsigns now come from GTFS `trip_headsign` (e.g. `Berryessa/North San Jose`, `SFIA`, `Richmond`). |
| `trainUpdateInterval` | integer | Departure refresh interval, in ms. Default: 30000 (30s). |
| `advisoryUpdateInterval` | integer | Advisory refresh interval, in ms. Default: 1800000 (30 min). |

Example configuration file:
```
{
    module: 'MMM-BartTimes',
    position: 'top_left',
    config: {
        station: '19TH',
        train_blacklist: ['Dublin/Pleasanton'],
    }
},
```

### Notes
- The static GTFS bundle is downloaded once on startup and refreshed every 24 hours. The feeds themselves are public and unauthenticated.
- BART does not publish vehicle positions in GTFS-RT, and eBART trips (Pittsburg Center / Antioch) may not appear because their schedules are managed in a separate system.

### Development

Run a local MagicMirror instance with this module enabled:

```
./dev/run.sh
```

The script clones MagicMirror into `dev/MagicMirror/` (gitignored), symlinks this repo as a module, and starts MagicMirror's server-only mode. Open the URL it prints (default `http://localhost:8181`) in any browser. Edit `dev/config.js` to change the station or add other modules. Run `npm test` from the repo root to execute the unit tests.

### Screenshot

When running and a BART disruption is happening, looks like this

![Bart Load Times with Advisory Data](./advisory.png)

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildGtfsIndex,
    gtfsDate,
    serviceWindow,
    isEffectiveOn,
    parseBundleIndex,
    selectEffectiveBundle,
    resolveStation,
    formatMinutes,
    departureSeconds,
    translation,
    alertAppliesToStation,
    extractDepartures,
    extractAdvisories,
} = require("../lib/gtfs");

// Minimal fixture: a "DBRK" station with two platform stops via parent_station,
// plus a "MONT" station that only exists as a flat prefix-style stop_id.
const stops = [
    { stop_id: "DBRK", stop_name: "Downtown Berkeley", location_type: "1", parent_station: "" },
    { stop_id: "DBRK_N", stop_name: "Downtown Berkeley NB", location_type: "0", parent_station: "DBRK" },
    { stop_id: "DBRK_S", stop_name: "Downtown Berkeley SB", location_type: "0", parent_station: "DBRK" },
    { stop_id: "MONT_N", stop_name: "Montgomery NB", location_type: "0", parent_station: "" },
    { stop_id: "MONT_S", stop_name: "Montgomery SB", location_type: "0", parent_station: "" },
];

const trips = [
    { trip_id: "T1", trip_headsign: "Richmond", route_id: "R1" },
    { trip_id: "T2", trip_headsign: "SFIA", route_id: "R2" },
    { trip_id: "T3", trip_headsign: "Richmond", route_id: "R1" },
];

const routes = [
    { route_id: "R1", route_short_name: "Red" },
    { route_id: "R2", route_short_name: "Yellow" },
];

const gtfs = buildGtfsIndex(stops, trips, routes);

test("buildGtfsIndex registers parent stations and attaches platforms", () => {
    assert.ok(gtfs.stationByCode["DBRK"]);
    assert.equal(gtfs.stationByCode["DBRK"].stationName, "Downtown Berkeley");
    assert.deepEqual(
        [...gtfs.stationByCode["DBRK"].platformIds].sort(),
        ["DBRK", "DBRK_N", "DBRK_S"]
    );
    assert.equal(gtfs.stationByCode["MONT"], undefined, "no parent => not in stationByCode");
});

test("resolveStation: parent-station hit returns full platform set", () => {
    const r = resolveStation(gtfs, "DBRK");
    assert.equal(r.stationName, "Downtown Berkeley");
    assert.ok(r.platformIds.has("DBRK_N"));
    assert.ok(r.platformIds.has("DBRK_S"));
});

test("resolveStation: case-insensitive", () => {
    const r = resolveStation(gtfs, "dbrk");
    assert.ok(r);
    assert.equal(r.stationName, "Downtown Berkeley");
});

test("resolveStation: prefix fallback for stations without parent", () => {
    const r = resolveStation(gtfs, "MONT");
    assert.ok(r, "MONT_N / MONT_S should be matched by prefix");
    assert.deepEqual([...r.platformIds].sort(), ["MONT_N", "MONT_S"]);
});

test("resolveStation: unknown code returns null", () => {
    assert.equal(resolveStation(gtfs, "NOPE"), null);
    assert.equal(resolveStation(gtfs, ""), null);
    assert.equal(resolveStation(gtfs, null), null);
});

test("resolveStation: numeric 511-style stop_id matches exactly, no prefix over-match", () => {
    // Non-BART operators (e.g. Muni via 511) use numeric stop_ids and often no
    // location_type=1 parent stations. Exact match must win without a shorter
    // numeric code bleeding into longer ids.
    const numericStops = [
        { stop_id: "13915", stop_name: "Church St & Market St", location_type: "0", parent_station: "" },
        { stop_id: "13911", stop_name: "Church St & 15th St", location_type: "0", parent_station: "" },
    ];
    const g = buildGtfsIndex(numericStops, [], []);
    const r = resolveStation(g, "13915");
    assert.ok(r);
    assert.equal(r.stationName, "Church St & Market St");
    assert.deepEqual([...r.platformIds], ["13915"]);
    // "1391" is not a real stop and must not prefix-match 13915/13911.
    assert.equal(resolveStation(g, "1391"), null);
});

test("formatMinutes boundary at 60 seconds", () => {
    assert.equal(formatMinutes(0), "Leaving");
    assert.equal(formatMinutes(30), "Leaving");
    assert.equal(formatMinutes(59), "Leaving");
    assert.equal(formatMinutes(60), "1");
    assert.equal(formatMinutes(89), "1");
    assert.equal(formatMinutes(90), "2");
    assert.equal(formatMinutes(120), "2");
    assert.equal(formatMinutes(630), "11");
});

test("departureSeconds prefers departure over arrival", () => {
    assert.equal(departureSeconds({ departure: { time: 100 }, arrival: { time: 90 } }), 100);
    assert.equal(departureSeconds({ arrival: { time: 90 } }), 90);
    assert.equal(departureSeconds({}), null);
    assert.equal(departureSeconds({ departure: {} }), null);
});

test("translation picks English then falls back to first", () => {
    assert.equal(
        translation({ translation: [{ language: "es", text: "hola" }, { language: "en", text: "hi" }] }),
        "hi"
    );
    assert.equal(
        translation({ translation: [{ language: "es", text: "hola" }] }),
        "hola"
    );
    assert.equal(translation(null), null);
    assert.equal(translation({ translation: [] }), null);
});

test("alertAppliesToStation: empty informedEntity => system-wide", () => {
    assert.equal(alertAppliesToStation({ informedEntity: [] }, new Set(["DBRK_N"])), true);
    assert.equal(alertAppliesToStation({}, new Set(["DBRK_N"])), true);
});

test("alertAppliesToStation: matches scoped stop", () => {
    const alert = { informedEntity: [{ stopId: "DBRK_N" }, { stopId: "OTHER" }] };
    assert.equal(alertAppliesToStation(alert, new Set(["DBRK_N", "DBRK_S"])), true);
});

test("alertAppliesToStation: stop-scoped but not our station => excluded", () => {
    const alert = { informedEntity: [{ stopId: "OTHER" }] };
    assert.equal(alertAppliesToStation(alert, new Set(["DBRK_N"])), false);
});

test("alertAppliesToStation: route/agency-only scope => included", () => {
    const alert = { informedEntity: [{ routeId: "R1" }] };
    assert.equal(alertAppliesToStation(alert, new Set(["DBRK_N"])), true);
});

test("extractDepartures: groups by headsign, sorts by next departure, caps list", () => {
    const now = 1_700_000_000;
    const station = resolveStation(gtfs, "DBRK");
    const feed = {
        entity: [
            {
                tripUpdate: {
                    trip: { tripId: "T1" },
                    stopTimeUpdate: [
                        { stopId: "DBRK_N", departure: { time: now + 600 } },
                    ],
                },
            },
            {
                tripUpdate: {
                    trip: { tripId: "T2" },
                    stopTimeUpdate: [
                        { stopId: "DBRK_S", departure: { time: now + 120 } },
                    ],
                },
            },
            {
                tripUpdate: {
                    trip: { tripId: "T3" },
                    stopTimeUpdate: [
                        { stopId: "DBRK_N", departure: { time: now + 1800 } },
                    ],
                },
            },
        ],
    };

    const out = extractDepartures(feed, gtfs, station, now, /* maxPerHeadsign */ 4);
    assert.equal(out.station_name, "Downtown Berkeley");
    // SFIA next departure (120s) comes before Richmond (600s)
    assert.deepEqual(out.departures.map(d => d.headsign), ["SFIA", "Richmond"]);
    assert.deepEqual(out.departures[0].times, ["2"]);
    assert.deepEqual(out.departures[1].times, ["10", "30"]);
});

test("extractDepartures: skips trips with SKIPPED stop_time and CANCELED trips", () => {
    const now = 1_700_000_000;
    const station = resolveStation(gtfs, "DBRK");
    const feed = {
        entity: [
            {
                tripUpdate: {
                    trip: { tripId: "T1", scheduleRelationship: 3 /* CANCELED */ },
                    stopTimeUpdate: [{ stopId: "DBRK_N", departure: { time: now + 60 } }],
                },
            },
            {
                tripUpdate: {
                    trip: { tripId: "T2" },
                    stopTimeUpdate: [
                        { stopId: "DBRK_N", departure: { time: now + 120 }, scheduleRelationship: 1 /* SKIPPED */ },
                    ],
                },
            },
        ],
    };
    const out = extractDepartures(feed, gtfs, station, now);
    assert.deepEqual(out.departures, []);
});

test("extractDepartures: drops departures more than 30s in the past", () => {
    const now = 1_700_000_000;
    const station = resolveStation(gtfs, "DBRK");
    const feed = {
        entity: [
            {
                tripUpdate: {
                    trip: { tripId: "T1" },
                    stopTimeUpdate: [
                        { stopId: "DBRK_N", departure: { time: now - 60 } },
                        { stopId: "DBRK_N", departure: { time: now - 10 } },
                        { stopId: "DBRK_N", departure: { time: now + 600 } },
                    ],
                },
            },
        ],
    };
    const out = extractDepartures(feed, gtfs, station, now);
    // -60s dropped; -10s kept (Leaving); +600s kept (10 min)
    // destCode is null: the shared fixture is built without stop_times.
    assert.deepEqual(out.departures, [{ headsign: "Richmond", destCode: null, times: ["Leaving", "10"] }]);
});

test("extractDepartures: ignores trips not in static GTFS (eBART case)", () => {
    const now = 1_700_000_000;
    const station = resolveStation(gtfs, "DBRK");
    const feed = {
        entity: [
            {
                tripUpdate: {
                    trip: { tripId: "EBART_999_unknown" },
                    stopTimeUpdate: [{ stopId: "DBRK_N", departure: { time: now + 300 } }],
                },
            },
        ],
    };
    const out = extractDepartures(feed, gtfs, station, now);
    assert.deepEqual(out.departures, []);
    assert.equal(out.unmatched, 1, "counted so a wholesale mismatch is visible");
});

test("extractDepartures: caps each headsign to maxPerHeadsign", () => {
    const now = 1_700_000_000;
    const station = resolveStation(gtfs, "DBRK");
    const feed = {
        entity: Array.from({ length: 6 }, (_, i) => ({
            tripUpdate: {
                trip: { tripId: "T1" },
                stopTimeUpdate: [{ stopId: "DBRK_N", departure: { time: now + (i + 1) * 120 } }],
            },
        })),
    };
    const out = extractDepartures(feed, gtfs, station, now, /* maxPerHeadsign */ 3);
    assert.equal(out.departures.length, 1);
    assert.equal(out.departures[0].headsign, "Richmond");
    assert.equal(out.departures[0].times.length, 3);
});

// A fixture with stop_times so terminus codes can be resolved. T1 ends at the
// RICH station (via a platform whose parent_station is RICH); the terminus
// platform's own id differs from the station code, mirroring real BART data
// ("L30-1" -> "DUBL").
const termStops = [
    { stop_id: "DBRK", stop_name: "Downtown Berkeley", location_type: "1", parent_station: "" },
    { stop_id: "DBRK_N", stop_name: "Downtown Berkeley NB", location_type: "0", parent_station: "DBRK" },
    { stop_id: "RICH", stop_name: "Richmond", location_type: "1", parent_station: "" },
    { stop_id: "R60-1", stop_name: "Richmond Platform", location_type: "0", parent_station: "RICH" },
];
const termStopTimes = [
    { trip_id: "T1", stop_id: "DBRK_N", stop_sequence: "1" },
    { trip_id: "T1", stop_id: "R60-1", stop_sequence: "9" },
    // Out-of-order sequence: the terminus must be picked by max stop_sequence,
    // not file order.
    { trip_id: "T2", stop_id: "R60-1", stop_sequence: "12" },
    { trip_id: "T2", stop_id: "DBRK_N", stop_sequence: "3" },
];
const termGtfs = buildGtfsIndex(termStops, trips, routes, termStopTimes);

test("buildGtfsIndex: tripTerminus maps trip to terminus station code", () => {
    assert.equal(termGtfs.tripTerminus["T1"], "RICH");
    assert.equal(termGtfs.tripTerminus["T2"], "RICH", "picks max stop_sequence regardless of file order");
});

test("extractDepartures: attaches terminus destCode to each departure", () => {
    const now = 1_700_000_000;
    const station = resolveStation(termGtfs, "DBRK");
    const feed = {
        entity: [
            {
                tripUpdate: {
                    trip: { tripId: "T1" },
                    stopTimeUpdate: [{ stopId: "DBRK_N", departure: { time: now + 300 } }],
                },
            },
        ],
    };
    const out = extractDepartures(feed, termGtfs, station, now);
    assert.equal(out.departures[0].destCode, "RICH");
});

test("extractAdvisories: emits English description, falls back to header", () => {
    const platformIds = new Set(["DBRK_N"]);
    const feed = {
        entity: [
            {
                alert: {
                    descriptionText: { translation: [{ language: "en", text: "Single tracking near DBRK" }] },
                    informedEntity: [{ stopId: "DBRK_N" }],
                },
            },
            {
                alert: {
                    headerText: { translation: [{ language: "en", text: "System-wide notice" }] },
                    informedEntity: [],
                },
            },
            {
                alert: {
                    descriptionText: { translation: [{ language: "en", text: "Unrelated station alert" }] },
                    informedEntity: [{ stopId: "OTHER_S" }],
                },
            },
        ],
    };
    const out = extractAdvisories(feed, platformIds);
    assert.deepEqual(out, ["Single tracking near DBRK", "System-wide notice"]);
});

test("extractDepartures: only counts unmatched trips that call at this station", () => {
    const now = 1_700_000_000;
    const station = resolveStation(gtfs, "DBRK");
    const feed = {
        entity: [
            {
                tripUpdate: {
                    trip: { tripId: "UNKNOWN_HERE" },
                    stopTimeUpdate: [{ stopId: "DBRK_N", departure: { time: now + 300 } }],
                },
            },
            {
                tripUpdate: {
                    trip: { tripId: "UNKNOWN_ELSEWHERE" },
                    stopTimeUpdate: [{ stopId: "MONT_N", departure: { time: now + 300 } }],
                },
            },
            {
                tripUpdate: {
                    trip: { tripId: "T1" },
                    stopTimeUpdate: [{ stopId: "DBRK_N", departure: { time: now + 600 } }],
                },
            },
        ],
    };
    const out = extractDepartures(feed, gtfs, station, now);
    assert.equal(out.unmatched, 1);
    assert.deepEqual(out.departures.map(d => d.headsign), ["Richmond"]);
});

test("gtfsDate renders a local-time YYYYMMDD", () => {
    assert.equal(gtfsDate(new Date(2026, 7, 4, 23, 30)), "20260804");
    assert.equal(gtfsDate(new Date(2026, 0, 1, 0, 0)), "20260101");
});

test("serviceWindow spans calendar.txt, widened by calendar_dates additions", () => {
    const calendar = [
        { service_id: "WKDY", start_date: "20260112", end_date: "20260807" },
        { service_id: "SAT", start_date: "20260117", end_date: "20260808" },
    ];
    assert.deepEqual(serviceWindow(calendar), { start: "20260112", end: "20260808" });

    const dates = [
        { service_id: "HOL", date: "20260809", exception_type: "1" },
        { service_id: "WKDY", date: "20260704", exception_type: "2" },
    ];
    assert.deepEqual(serviceWindow(calendar, dates), { start: "20260112", end: "20260809" });
});

test("serviceWindow: a removal alone can't establish a window; junk ignored", () => {
    assert.equal(serviceWindow([], [{ date: "20260809", exception_type: "2" }]), null);
    assert.equal(serviceWindow([]), null);
    assert.equal(serviceWindow([{ start_date: "", end_date: "not-a-date" }]), null);
});

test("serviceWindow: calendar_dates-only bundles still get a window", () => {
    // Some feeds express every service through calendar_dates.txt alone.
    const dates = [
        { date: "20260810", exception_type: "1" },
        { date: "20260811", exception_type: "1" },
    ];
    assert.deepEqual(serviceWindow([], dates), { start: "20260810", end: "20260811" });
});

test("buildGtfsIndex exposes the bundle's service window", () => {
    const g = buildGtfsIndex(stops, trips, routes, [], [
        { start_date: "20260810", end_date: "20270108" },
    ]);
    assert.deepEqual(g.serviceWindow, { start: "20260810", end: "20270108" });
    assert.equal(buildGtfsIndex(stops, trips, routes).serviceWindow, null);
});

test("isEffectiveOn: inclusive bounds, unknown window is usable", () => {
    const w = { start: "20260112", end: "20260807" };
    assert.equal(isEffectiveOn(w, "20260112"), true);
    assert.equal(isEffectiveOn(w, "20260807"), true);
    assert.equal(isEffectiveOn(w, "20260808"), false);
    assert.equal(isEffectiveOn(w, "20260111"), false);
    // The Aug 2026 case: a bundle published days before it takes effect.
    assert.equal(isEffectiveOn({ start: "20260810", end: "20270108" }, "20260804"), false);
    assert.equal(isEffectiveOn(null, "20260804"), true);
});

test("parseBundleIndex: pulls dated zip links, resolved and deduped", () => {
    const html = `
        <a href="/dev/schedules/google_transit.zip">current</a>
        <a href="/sites/default/files/2026-07/google_transit_20260112-20260807_v09.zip">Jan 12</a>
        <a href='/sites/default/files/2026-07/google_transit_20260112-20260807_v09.zip'>dupe</a>
        <a href="https://example.org/gtfs_20260810-20270108_v02.zip">Aug 10</a>
        <a href="/schedules/bybart.pdf">not a bundle</a>
    `;
    const out = parseBundleIndex(html, "https://www.bart.gov/schedules/developers/gtfs");
    assert.deepEqual(out, [
        {
            url: "https://www.bart.gov/sites/default/files/2026-07/google_transit_20260112-20260807_v09.zip",
            start: "20260112",
            end: "20260807",
        },
        { url: "https://example.org/gtfs_20260810-20270108_v02.zip", start: "20260810", end: "20270108" },
    ]);
    assert.deepEqual(parseBundleIndex("", "https://www.bart.gov/"), []);
    assert.deepEqual(parseBundleIndex(null, "https://www.bart.gov/"), []);
});

test("selectEffectiveBundle: prefers the newest bundle covering the date", () => {
    const bundles = [
        { url: "old", start: "20251012", end: "20260111" },
        { url: "current", start: "20260112", end: "20260807" },
        { url: "next", start: "20260810", end: "20270108" },
    ];
    assert.equal(selectEffectiveBundle(bundles, "20260804").url, "current");
    assert.equal(selectEffectiveBundle(bundles, "20251215").url, "old");
    assert.equal(selectEffectiveBundle(bundles, "20260810").url, "next");
});

test("selectEffectiveBundle: gap days fall back to the newest started bundle", () => {
    // BART's ranges don't always meet: v09 ends 08-07, the next starts 08-10.
    const bundles = [
        { url: "current", start: "20260112", end: "20260807" },
        { url: "next", start: "20260810", end: "20270108" },
    ];
    assert.equal(selectEffectiveBundle(bundles, "20260809").url, "current");
});

test("selectEffectiveBundle: nothing started yet => null", () => {
    assert.equal(selectEffectiveBundle([{ url: "next", start: "20260810", end: "20270108" }], "20260804"), null);
    assert.equal(selectEffectiveBundle([], "20260804"), null);
    assert.equal(selectEffectiveBundle(null, "20260804"), null);
});

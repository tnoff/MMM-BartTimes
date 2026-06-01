const test = require("node:test");
const assert = require("node:assert/strict");

const {
    buildGtfsIndex,
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
    assert.deepEqual(out.trains, ["SFIA", "Richmond"]);
    assert.deepEqual(out.SFIA, ["2"]);
    assert.deepEqual(out.Richmond, ["10", "30"]);
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
    assert.deepEqual(out.trains, []);
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
    assert.deepEqual(out.Richmond, ["Leaving", "10"]);
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
    assert.deepEqual(out.trains, []);
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
    assert.equal(out.Richmond.length, 3);
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

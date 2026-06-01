// Pure GTFS / GTFS-Realtime helpers. No I/O, no MagicMirror dependencies — safe to unit test.

const STOP_TIME_SCHEDULE_RELATIONSHIP_SKIPPED = 1;
const TRIP_SCHEDULE_RELATIONSHIP_CANCELED = 3;
const DEFAULT_MAX_DEPARTURES_PER_HEADSIGN = 4;

function buildGtfsIndex(stops, trips, routes) {
    const tripById = Object.create(null);
    for (const t of trips) tripById[t.trip_id] = t;

    const routeById = Object.create(null);
    for (const r of routes) routeById[r.route_id] = r;

    const stationByCode = Object.create(null);
    for (const s of stops) {
        if (s.location_type === "1") {
            stationByCode[String(s.stop_id).toUpperCase()] = {
                stationName: s.stop_name,
                platformIds: new Set([s.stop_id]),
            };
        }
    }
    for (const s of stops) {
        const ps = String(s.parent_station || "").toUpperCase();
        if (ps && stationByCode[ps]) stationByCode[ps].platformIds.add(s.stop_id);
    }

    return { stops, tripById, routeById, stationByCode };
}

function resolveStation(gtfs, stationCode) {
    const code = String(stationCode || "").toUpperCase();
    if (!code) return null;
    if (gtfs.stationByCode[code]) return gtfs.stationByCode[code];

    const platformIds = new Set();
    let stationName = null;
    for (const s of gtfs.stops) {
        const id = String(s.stop_id).toUpperCase();
        if (id === code || id.startsWith(code + "_") || id.startsWith(code + "-")) {
            platformIds.add(s.stop_id);
            if (!stationName) stationName = s.stop_name;
        }
    }
    if (platformIds.size === 0) return null;
    return { stationName: stationName || code, platformIds };
}

function formatMinutes(secsAway) {
    if (secsAway < 60) return "Leaving";
    return String(Math.round(secsAway / 60));
}

function departureSeconds(stu) {
    if (stu.departure && stu.departure.time != null) return Number(stu.departure.time);
    if (stu.arrival && stu.arrival.time != null) return Number(stu.arrival.time);
    return null;
}

function translation(ts) {
    if (!ts || !ts.translation || !ts.translation.length) return null;
    const en = ts.translation.find(t => t.language === "en") || ts.translation[0];
    return en && en.text;
}

function alertAppliesToStation(alert, platformIds) {
    const informed = alert.informedEntity || [];
    if (informed.length === 0) return true;
    let hasStopScoping = false;
    for (const ie of informed) {
        if (ie.stopId) {
            hasStopScoping = true;
            if (platformIds.has(ie.stopId)) return true;
        }
    }
    return !hasStopScoping;
}

function extractDepartures(feed, gtfs, station, now, maxPerHeadsign = DEFAULT_MAX_DEPARTURES_PER_HEADSIGN) {
    const byHeadsign = new Map();

    for (const entity of feed.entity || []) {
        const tu = entity.tripUpdate;
        if (!tu) continue;
        if (tu.trip && tu.trip.scheduleRelationship === TRIP_SCHEDULE_RELATIONSHIP_CANCELED) continue;

        const tripId = tu.trip && tu.trip.tripId;
        const trip = tripId ? gtfs.tripById[tripId] : null;
        const headsign = trip && trip.trip_headsign;
        if (!headsign) continue;

        for (const stu of tu.stopTimeUpdate || []) {
            if (!station.platformIds.has(stu.stopId)) continue;
            if (stu.scheduleRelationship === STOP_TIME_SCHEDULE_RELATIONSHIP_SKIPPED) continue;

            const ts = departureSeconds(stu);
            if (ts == null) continue;
            const secsAway = ts - now;
            if (secsAway < -30) continue;

            if (!byHeadsign.has(headsign)) byHeadsign.set(headsign, []);
            byHeadsign.get(headsign).push(secsAway);
        }
    }

    const out = { station_name: station.stationName, trains: [] };
    const headsigns = [...byHeadsign.keys()].sort((a, b) => {
        return Math.min(...byHeadsign.get(a)) - Math.min(...byHeadsign.get(b));
    });
    for (const headsign of headsigns) {
        const list = byHeadsign.get(headsign)
            .sort((a, b) => a - b)
            .slice(0, maxPerHeadsign)
            .map(formatMinutes);
        out.trains.push(headsign);
        out[headsign] = list;
    }
    return out;
}

function extractAdvisories(feed, platformIds) {
    const advisories = [];
    for (const entity of feed.entity || []) {
        const alert = entity.alert;
        if (!alert) continue;
        if (!alertAppliesToStation(alert, platformIds)) continue;

        const text = translation(alert.descriptionText) || translation(alert.headerText);
        if (text) advisories.push(text);
    }
    return advisories;
}

module.exports = {
    buildGtfsIndex,
    resolveStation,
    formatMinutes,
    departureSeconds,
    translation,
    alertAppliesToStation,
    extractDepartures,
    extractAdvisories,
    DEFAULT_MAX_DEPARTURES_PER_HEADSIGN,
};

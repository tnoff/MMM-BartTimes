// Pure GTFS / GTFS-Realtime helpers. No I/O, no MagicMirror dependencies — safe to unit test.

const STOP_TIME_SCHEDULE_RELATIONSHIP_SKIPPED = 1;
const TRIP_SCHEDULE_RELATIONSHIP_CANCELED = 3;
const DEFAULT_MAX_DEPARTURES_PER_HEADSIGN = 4;

function buildGtfsIndex(stops, trips, routes, stopTimes = [], calendar = [], calendarDates = []) {
    const tripById = Object.create(null);
    for (const t of trips) tripById[t.trip_id] = t;

    const routeById = Object.create(null);
    for (const r of routes) routeById[r.route_id] = r;

    // stop_id -> owning station code (uppercased). A platform maps to its
    // parent_station; a station maps to itself. Turns a trip's terminus
    // platform ("L30-1") into a stable station code ("DUBL").
    const stationOfStop = Object.create(null);
    for (const s of stops) {
        const ps = String(s.parent_station || "").trim();
        stationOfStop[s.stop_id] = (ps || s.stop_id).toUpperCase();
    }

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

    // trip_id -> terminus station code, from the last stop_time by
    // stop_sequence. Must come from static stop_times: the realtime feed
    // truncates before the terminus (a Richmond train's last realtime stop is
    // DELN, not RICH), so it cannot be derived from the trip update.
    const lastSeqByTrip = Object.create(null);
    const tripTerminus = Object.create(null);
    for (const st of stopTimes) {
        const seq = Number(st.stop_sequence);
        if (!(st.trip_id in lastSeqByTrip) || seq > lastSeqByTrip[st.trip_id]) {
            lastSeqByTrip[st.trip_id] = seq;
            tripTerminus[st.trip_id] = stationOfStop[st.stop_id] || String(st.stop_id).toUpperCase();
        }
    }

    return {
        stops,
        tripById,
        routeById,
        stationByCode,
        tripTerminus,
        serviceWindow: serviceWindow(calendar, calendarDates),
    };
}

// GTFS calendar dates are agency-local YYYYMMDD strings, which compare
// correctly as plain strings. Render a Date the same way, in local time.
function gtfsDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

// The span of dates a static bundle actually schedules service for: earliest
// and latest date mentioned by calendar.txt, widened by calendar_dates.txt
// additions (exception_type 1). Removals (type 2) can't widen a window.
// Returns null when the bundle carries no usable dates.
function serviceWindow(calendar = [], calendarDates = []) {
    let start = null;
    let end = null;
    const note = (value) => {
        const d = String(value || "").trim();
        if (!/^\d{8}$/.test(d)) return;
        if (start === null || d < start) start = d;
        if (end === null || d > end) end = d;
    };

    for (const c of calendar) {
        note(c.start_date);
        note(c.end_date);
    }
    for (const cd of calendarDates) {
        if (String(cd.exception_type) === "2") continue;
        note(cd.date);
    }

    return start && end ? { start, end } : null;
}

// True when `date` (YYYYMMDD) falls inside the bundle's service window. An
// unknown window is treated as usable — better to run on a bundle we can't
// date than to reject the only one we have.
function isEffectiveOn(span, date) {
    if (!span) return true;
    return span.start <= date && date <= span.end;
}

// Versioned GTFS bundles published alongside the canonical zip encode their
// effective range in the filename, e.g.
//   /sites/default/files/2026-07/google_transit_20260112-20260807_v09.zip
// Pull those links out of a provider's schedule-index page, resolved against
// the page URL. Pure string work — the fetch lives in node_helper.js.
const BUNDLE_LINK_RE = /(?:href|src)\s*=\s*["']([^"']*?(\d{8})-(\d{8})[^"']*?\.zip)["']/gi;

function parseBundleIndex(html, baseUrl) {
    const bundles = [];
    const seen = new Set();
    for (const match of String(html || "").matchAll(BUNDLE_LINK_RE)) {
        let url;
        try {
            url = new URL(match[1], baseUrl).toString();
        } catch {
            continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        bundles.push({ url, start: match[2], end: match[3] });
    }
    return bundles;
}

// Pick the bundle to run on `date` (YYYYMMDD): the most recently started one
// that has already taken effect, preferring one whose range still covers the
// date. Bundles that only start in the future are never chosen — that is the
// whole point. Returns null when none has started.
function selectEffectiveBundle(bundles, date) {
    const started = (bundles || []).filter(b => b && b.start && b.start <= date);
    if (!started.length) return null;
    const covering = started.filter(b => date <= b.end);
    const pool = covering.length ? covering : started;
    return pool.reduce((best, b) => (b.start > best.start ? b : best));
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
    const terminusByTrip = gtfs.tripTerminus || Object.create(null);
    // Trips calling at this station that the static schedule can't name. A
    // handful is normal (eBART); *every* trip means the static bundle and the
    // realtime feed are on different schedule versions — see `unmatched` in
    // the returned object.
    const unmatched = new Set();

    for (const entity of feed.entity || []) {
        const tu = entity.tripUpdate;
        if (!tu) continue;
        if (tu.trip && tu.trip.scheduleRelationship === TRIP_SCHEDULE_RELATIONSHIP_CANCELED) continue;

        const tripId = tu.trip && tu.trip.tripId;
        const trip = tripId ? gtfs.tripById[tripId] : null;
        const headsign = trip && trip.trip_headsign;
        if (!headsign) {
            if ((tu.stopTimeUpdate || []).some(stu => station.platformIds.has(stu.stopId))) {
                unmatched.add(tripId || `#${unmatched.size}`);
            }
            continue;
        }
        const destCode = (tripId && terminusByTrip[tripId]) || null;

        for (const stu of tu.stopTimeUpdate || []) {
            if (!station.platformIds.has(stu.stopId)) continue;
            if (stu.scheduleRelationship === STOP_TIME_SCHEDULE_RELATIONSHIP_SKIPPED) continue;

            const ts = departureSeconds(stu);
            if (ts == null) continue;
            const secsAway = ts - now;
            if (secsAway < -30) continue;

            let entry = byHeadsign.get(headsign);
            if (!entry) {
                entry = { times: [], destCode };
                byHeadsign.set(headsign, entry);
            } else if (!entry.destCode && destCode) {
                entry.destCode = destCode;
            }
            entry.times.push(secsAway);
        }
    }

    const out = { station_name: station.stationName, departures: [], unmatched: unmatched.size };
    const headsigns = [...byHeadsign.keys()].sort((a, b) => {
        return Math.min(...byHeadsign.get(a).times) - Math.min(...byHeadsign.get(b).times);
    });
    for (const headsign of headsigns) {
        const entry = byHeadsign.get(headsign);
        const times = entry.times
            .sort((a, b) => a - b)
            .slice(0, maxPerHeadsign)
            .map(formatMinutes);
        out.departures.push({ headsign, destCode: entry.destCode, times });
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
    DEFAULT_MAX_DEPARTURES_PER_HEADSIGN,
};

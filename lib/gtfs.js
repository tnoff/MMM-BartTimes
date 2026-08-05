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
        stationNameIndex: buildStationNameIndex(stops),
        stationGraph: buildStationGraph(stopTimes, stationOfStop),
    };
}

// Advisory text is prose, so station matching has to survive punctuation and
// spacing differences ("El Cerrito del Norte", "Dublin/Pleasanton",
// "12th St. Oakland"). Fold both sides to the same shape: lowercase, no
// punctuation, no spaces around a slash, "street" abbreviated.
function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[’']/g, "")
        .replace(/[^a-z0-9/]+/g, " ")
        .replace(/\bstreet\b/g, "st")
        .replace(/\s*\/\s*/g, "/")
        .replace(/\s+/g, " ")
        .trim();
}

// Station names BART writes one way in stops.txt and another way in advisory
// prose. Everything else matches on its stop_name.
const STATION_ALIASES = {
    SFIA: ["sfo", "sfo airport", "san francisco airport", "san francisco intl airport"],
    OAKL: ["oak airport", "oakland airport", "oakland intl airport"],
};

// Phrase -> station code, for finding stations named in advisory prose. Each
// station contributes its full name, its slash-separated segments (only where
// a segment belongs to exactly one station — "Mission" is shared by 16th and
// 24th, so it's dropped), and any alias above.
function buildStationNameIndex(stops = []) {
    const stations = stops.filter(s => s.location_type === "1");
    const segmentOwners = new Map();
    for (const s of stations) {
        for (const segment of normalizeText(s.stop_name).split("/")) {
            if (!segment) continue;
            if (!segmentOwners.has(segment)) segmentOwners.set(segment, new Set());
            segmentOwners.get(segment).add(String(s.stop_id).toUpperCase());
        }
    }

    const index = new Map();
    const add = (phrase, code) => {
        if (phrase && !index.has(phrase)) index.set(phrase, code);
    };
    for (const s of stations) {
        const code = String(s.stop_id).toUpperCase();
        add(normalizeText(s.stop_name), code);
        for (const segment of normalizeText(s.stop_name).split("/")) {
            const owners = segmentOwners.get(segment);
            if (owners && owners.size === 1) add(segment, code);
        }
        for (const alias of STATION_ALIASES[code] || []) add(normalizeText(alias), code);
    }
    return index;
}

// Undirected station adjacency, from consecutive stations on every trip. BART's
// 7000-odd trips collapse to a few dozen distinct patterns and a ~50-node
// graph, so this is cheap to build once per bundle and to walk per advisory.
function buildStationGraph(stopTimes = [], stationOfStop = Object.create(null)) {
    const bySeq = new Map();
    for (const st of stopTimes) {
        if (!bySeq.has(st.trip_id)) bySeq.set(st.trip_id, []);
        bySeq.get(st.trip_id).push([Number(st.stop_sequence), stationOfStop[st.stop_id] || String(st.stop_id).toUpperCase()]);
    }

    const graph = new Map();
    const link = (a, b) => {
        if (!graph.has(a)) graph.set(a, new Set());
        if (!graph.has(b)) graph.set(b, new Set());
        graph.get(a).add(b);
        graph.get(b).add(a);
    };
    for (const entries of bySeq.values()) {
        entries.sort((a, b) => a[0] - b[0]);
        let prev = null;
        for (const [, code] of entries) {
            if (code && code !== prev) {
                if (prev) link(prev, code);
                prev = code;
            }
        }
    }
    return graph;
}

// Every station from `a` to `b` inclusive, along the shortest path through the
// network — the stations a rider would pass. Breadth-first, so pairs that need
// a transfer (Richmond -> Dublin) still resolve, via the shared trunk. Empty
// when the two aren't connected.
function stationsBetween(graph, a, b) {
    if (!graph || !graph.has(a) || !graph.has(b)) return [];
    if (a === b) return [a];

    const cameFrom = new Map([[a, null]]);
    const queue = [a];
    while (queue.length) {
        const current = queue.shift();
        if (current === b) break;
        for (const next of graph.get(current) || []) {
            if (cameFrom.has(next)) continue;
            cameFrom.set(next, current);
            queue.push(next);
        }
    }
    if (!cameFrom.has(b)) return [];

    const path = [];
    for (let code = b; code != null; code = cameFrom.get(code)) path.push(code);
    return path.reverse();
}

// Station codes named anywhere in the text. Over-matching is tolerated (a
// station whose name contains another's, say) because a wider set only makes
// an advisory more likely to be shown.
function stationsMentioned(text, nameIndex) {
    const haystack = normalizeText(text);
    if (!haystack || !nameIndex) return [];
    const found = new Set();
    for (const [phrase, code] of nameIndex) {
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`).test(haystack)) found.add(code);
    }
    return [...found];
}

// Reads like it describes a stretch of the line rather than a single point.
const SEGMENT_WORDING = /\bbetween\b|\bfrom\b[\s\S]*\bto\b/;

// Which stations an advisory actually affects. "Delays between Millbrae, SFO
// and Daly City" affects every station on those stretches, not just the three
// it names — so each pair of named stations is expanded to the full path
// between them. Returns [] for an advisory we can't scope, which callers must
// treat as system-wide (always shown), never as "affects nothing".
function advisoryStations(text, nameIndex, graph) {
    const mentioned = stationsMentioned(text, nameIndex);
    if (mentioned.length === 0) return [];

    // One endpoint of a "between X and Y" that we failed to recognise would
    // expand to too small a stretch and could hide an advisory covering your
    // station. Don't scope what we only half-read.
    if (mentioned.length === 1) {
        return SEGMENT_WORDING.test(normalizeText(text)) ? [] : mentioned;
    }

    const affected = new Set(mentioned);
    for (let i = 0; i < mentioned.length; i++) {
        for (let j = i + 1; j < mentioned.length; j++) {
            for (const code of stationsBetween(graph, mentioned[i], mentioned[j])) affected.add(code);
        }
    }
    return [...affected];
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

// Returns { text, stations } per advisory. `stations` is the set of station
// codes the text scopes itself to (see advisoryStations); empty means
// system-wide as far as we can tell, and callers must show it.
function extractAdvisories(feed, platformIds, gtfs = null) {
    const nameIndex = gtfs && gtfs.stationNameIndex;
    const graph = gtfs && gtfs.stationGraph;

    const advisories = [];
    for (const entity of feed.entity || []) {
        const alert = entity.alert;
        if (!alert) continue;
        if (!alertAppliesToStation(alert, platformIds)) continue;

        const text = translation(alert.descriptionText) || translation(alert.headerText);
        if (text) advisories.push({ text, stations: nameIndex ? advisoryStations(text, nameIndex, graph) : [] });
    }
    return advisories;
}

module.exports = {
    buildGtfsIndex,
    gtfsDate,
    normalizeText,
    buildStationNameIndex,
    buildStationGraph,
    stationsBetween,
    stationsMentioned,
    advisoryStations,
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

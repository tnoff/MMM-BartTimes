const NodeHelper = require("node_helper");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const {
    buildGtfsIndex,
    resolveStation,
    extractDepartures,
    extractAdvisories,
} = require("./lib/gtfs");

// Provider abstraction. Each provider knows how to build its three feed URLs
// from a normalized stop ({ provider, agency, apiKey, station }). BART is
// keyless via bart.gov; 511 is keyed via api.511.org and takes an agency/
// operator id (BART's own 511 operator id is "BA"). See AGENTS.md.
const PROVIDERS = {
    bart: {
        tripUpdateUrl: () => "https://api.bart.gov/gtfsrt/tripupdate.aspx",
        alertsUrl: () => "https://api.bart.gov/gtfsrt/alerts.aspx",
        staticUrl: () => "https://www.bart.gov/dev/schedules/google_transit.zip",
    },
    "511": {
        requiresKey: true,
        tripUpdateUrl: (s) => `https://api.511.org/transit/tripupdates?api_key=${encodeURIComponent(s.apiKey)}&agency=${encodeURIComponent(s.agency)}`,
        alertsUrl: (s) => `https://api.511.org/transit/servicealerts?api_key=${encodeURIComponent(s.apiKey)}&agency=${encodeURIComponent(s.agency)}`,
        staticUrl: (s) => `https://api.511.org/transit/datafeeds?api_key=${encodeURIComponent(s.apiKey)}&operator_id=${encodeURIComponent(s.agency)}`,
    },
};

const STATIC_TTL_MS = 24 * 60 * 60 * 1000;
// Short-lived micro-cache so multiple stops on the same (provider, agency)
// share one realtime protobuf fetch per refresh tick — protects the 511 key's
// hourly rate limit.
const FEED_DEDUPE_MS = 20 * 1000;

module.exports = NodeHelper.create({

    start: function() {
        console.log("Starting node helper: " + this.name);
        // Static GTFS index cached per (provider, agency), each slot carrying its
        // own 24h TTL + singleflight promise. Realtime feeds deduped per URL.
        this.staticGtfsCache = new Map();
        this.feedCache = new Map();
    },

    // Resolve and validate a stop's provider, throwing a clear error rather than
    // building a malformed URL.
    providerFor: function(stop) {
        const name = (stop && stop.provider) || "bart";
        const provider = PROVIDERS[name];
        if (!provider) throw new Error(`Unknown provider: ${name}`);
        if (provider.requiresKey) {
            if (!stop.apiKey) throw new Error(`Provider ${name} requires an apiKey (${this.describeStop(stop)})`);
            if (!stop.agency) throw new Error(`Provider ${name} requires an agency (${this.describeStop(stop)})`);
        }
        return provider;
    },

    describeStop: function(stop) {
        const parts = [stop && stop.provider || "bart"];
        if (stop && stop.agency) parts.push(stop.agency);
        if (stop && stop.station) parts.push(stop.station);
        return parts.join("/");
    },

    // Cache key for the static GTFS index. All BART stops share one bundle;
    // each 511 agency has its own.
    staticKey: function(stop) {
        return (stop && stop.provider === "511") ? `511:${stop.agency}` : "bart";
    },

    getStaticGtfs: function(stop) {
        const key = this.staticKey(stop);
        let slot = this.staticGtfsCache.get(key);
        if (!slot) {
            slot = { data: null, loadedAt: 0, promise: null };
            this.staticGtfsCache.set(key, slot);
        }

        const fresh = slot.data && (Date.now() - slot.loadedAt) < STATIC_TTL_MS;
        if (fresh) return Promise.resolve(slot.data);
        if (slot.promise) return slot.promise;

        const url = this.providerFor(stop).staticUrl(stop);
        slot.promise = this.loadStaticGtfs(url)
            .then(g => {
                slot.data = g;
                slot.loadedAt = Date.now();
                slot.promise = null;
                return g;
            })
            .catch(err => {
                slot.promise = null;
                throw err;
            });
        return slot.promise;
    },

    loadStaticGtfs: async function(url) {
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) throw new Error(`Static GTFS fetch failed: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const zip = new AdmZip(buf);

        const readCsv = (name) => {
            const entry = zip.getEntry(name);
            if (!entry) return [];
            return parse(entry.getData().toString("utf8"), {
                columns: true,
                skip_empty_lines: true,
                trim: true,
                bom: true,
            });
        };

        return buildGtfsIndex(readCsv("stops.txt"), readCsv("trips.txt"), readCsv("routes.txt"));
    },

    fetchFeed: function(url) {
        const now = Date.now();
        const cached = this.feedCache.get(url);
        if (cached && (now - cached.at) < FEED_DEDUPE_MS) return cached.promise;

        const promise = (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Feed fetch failed (${url}): ${res.status}`);
            const buf = new Uint8Array(await res.arrayBuffer());
            return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
        })();

        this.feedCache.set(url, { promise, at: now });
        // Don't let a failed fetch stay cached for the dedupe window — drop it so
        // the next tick retries instead of replaying the rejection.
        promise.catch(() => {
            const cur = this.feedCache.get(url);
            if (cur && cur.promise === promise) this.feedCache.delete(url);
        });
        return promise;
    },

    getDepartureTimes: async function(stop) {
        const gtfs = await this.getStaticGtfs(stop);
        const station = resolveStation(gtfs, stop.station);
        if (!station) throw new Error(`Unknown station: ${this.describeStop(stop)}`);

        const feed = await this.fetchFeed(this.providerFor(stop).tripUpdateUrl(stop));
        const now = Math.floor(Date.now() / 1000);
        return extractDepartures(feed, gtfs, station, now);
    },

    getServiceAdvisories: async function(stop) {
        const gtfs = await this.getStaticGtfs(stop);
        const station = resolveStation(gtfs, stop.station);
        const platformIds = station ? station.platformIds : new Set();

        const feed = await this.fetchFeed(this.providerFor(stop).alertsUrl(stop));
        return extractAdvisories(feed, platformIds);
    },

    socketNotificationReceived: function(notification, payload) {
        const self = this;
        const stop = payload && payload.stop;
        if (!stop) return;

        if (notification === "GET_DEPARTURE_TIMES") {
            this.getDepartureTimes(stop)
                .then(d => {
                    console.log("Departures loaded for", self.describeStop(stop), "->", d.station_name);
                    self.sendSocketNotification("DEPARTURE_TIMES", { id: stop.id, data: d });
                })
                .catch(err => {
                    console.log("Departures failed for", self.describeStop(stop) + ":", err.message);
                    self.sendSocketNotification("DEPARTURE_ERROR", { id: stop.id, error: err.message });
                });
        }
        if (notification === "GET_SERVICE_ADVISORY") {
            this.getServiceAdvisories(stop)
                .then(a => {
                    console.log("Advisories loaded for", self.describeStop(stop) + ":", a.length);
                    self.sendSocketNotification("SERVICE_ADVISORY", { id: stop.id, advisories: a });
                })
                .catch(err => {
                    console.log("Advisories failed for", self.describeStop(stop) + ":", err.message);
                });
        }
    },
});

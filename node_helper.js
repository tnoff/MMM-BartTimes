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

const TRIP_UPDATE_URL = "https://api.bart.gov/gtfsrt/tripupdate.aspx";
const ALERTS_URL = "https://api.bart.gov/gtfsrt/alerts.aspx";
const STATIC_GTFS_URL = "https://www.bart.gov/dev/schedules/google_transit.zip";
const STATIC_TTL_MS = 24 * 60 * 60 * 1000;

module.exports = NodeHelper.create({

    start: function() {
        console.log("Starting node helper: " + this.name);
        this.staticGtfs = null;
        this.staticGtfsLoadedAt = 0;
        this.staticGtfsPromise = null;
        this.getStaticGtfs().catch(err => {
            console.log("BART static GTFS preload failed:", err.message);
        });
    },

    getStaticGtfs: function() {
        const fresh = this.staticGtfs && (Date.now() - this.staticGtfsLoadedAt) < STATIC_TTL_MS;
        if (fresh) return Promise.resolve(this.staticGtfs);
        if (this.staticGtfsPromise) return this.staticGtfsPromise;

        this.staticGtfsPromise = this.loadStaticGtfs()
            .then(g => {
                this.staticGtfs = g;
                this.staticGtfsLoadedAt = Date.now();
                this.staticGtfsPromise = null;
                return g;
            })
            .catch(err => {
                this.staticGtfsPromise = null;
                throw err;
            });
        return this.staticGtfsPromise;
    },

    loadStaticGtfs: async function() {
        const res = await fetch(STATIC_GTFS_URL, { redirect: "follow" });
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

    fetchFeed: async function(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Feed fetch failed (${url}): ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        return GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buf);
    },

    getDepartureTimes: async function(stationCode) {
        const gtfs = await this.getStaticGtfs();
        const station = resolveStation(gtfs, stationCode);
        if (!station) throw new Error(`Unknown BART station: ${stationCode}`);

        const feed = await this.fetchFeed(TRIP_UPDATE_URL);
        const now = Math.floor(Date.now() / 1000);
        return extractDepartures(feed, gtfs, station, now);
    },

    getServiceAdvisories: async function(stationCode) {
        const gtfs = await this.getStaticGtfs();
        const station = resolveStation(gtfs, stationCode);
        const platformIds = station ? station.platformIds : new Set();

        const feed = await this.fetchFeed(ALERTS_URL);
        return extractAdvisories(feed, platformIds);
    },

    socketNotificationReceived: function(notification, payload) {
        const self = this;
        console.log("Notification: " + notification);

        if (notification === "GET_DEPARTURE_TIMES") {
            this.getDepartureTimes(payload.config.station)
                .then(d => {
                    console.log("BART departures loaded for", d.station_name);
                    self.sendSocketNotification("DEPARTURE_TIMES", d);
                })
                .catch(err => {
                    console.log("BART departures failed:", err.message);
                });
        }
        if (notification === "GET_SERVICE_ADVISORY") {
            this.getServiceAdvisories(payload.config.station)
                .then(a => {
                    console.log("BART advisories loaded:", a.length);
                    self.sendSocketNotification("SERVICE_ADVISORY", a);
                })
                .catch(err => {
                    console.log("BART advisories failed:", err.message);
                });
        }
    },
});

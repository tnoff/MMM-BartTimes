Module.register("MMM-BartTimes", {

    // Module config defaults.
    defaults: {
        // 511 API key (optional; only needed if a stop uses provider '511').
        // One token covers every agency. Register: https://511.org/open-data/token
        apiKey: '',

        // New multi-stop form. Each entry:
        //   { provider: 'bart'|'511', agency, station, label?, apiKey?, train_blacklist? }
        // Leave empty to use the legacy single-station fields below.
        stops: [],

        // Legacy single-BART form (still supported, keyless).
        station: '19TH',
        train_blacklist: [],

        // Advisories: hide any advisory containing one of these substrings
        // (case-insensitive), e.g. ['clipper', 'tap and ride'] to mute ads.
        // Applies to every stop; a stop may add its own list too.
        advisory_blacklist: [],
        // Truncate each advisory to this many characters (0 = no limit).
        advisoryMaxLength: 160,
        // Show at most this many advisories per stop (0 = no limit).
        maxAdvisories: 0,

        // BART trip headsigns are full line paths, e.g.
        // "SF / OAK Airport / Dublin/Pleasanton". By default show only the
        // final destination segment ("Dublin/Pleasanton") to keep the train
        // column narrow; set true to show the whole path.
        showFullHeadsign: false,

        trainUpdateInterval : 30000, // 30 seconds (511 stops floored to >= 90s)
        advisoryUpdateInterval : 1800000 // 30 minutes
    },

    // Define start sequence.
    start: function() {
        Log.info("Starting module: " + this.name);

        var self = this;
        this.stops = this.normalizeStops();
        this.stopData = {};        // id -> DEPARTURE_TIMES payload data
        this.stopAdvisories = {};  // id -> array of advisory strings
        this.stopErrors = {};      // id -> last error string

        this.stops.forEach(function(stop) {
            self.requestDepartures(stop);
            self.requestAdvisories(stop);

            // 511 tokens are rate-limited (~60 req/hr), so floor its refresh.
            var trainMs = stop.provider === "511"
                ? Math.max(self.config.trainUpdateInterval, 90000)
                : self.config.trainUpdateInterval;
            var advisoryMs = stop.provider === "511"
                ? Math.max(self.config.advisoryUpdateInterval, 90000)
                : self.config.advisoryUpdateInterval;

            setInterval(function() { self.requestDepartures(stop); }, trainMs);
            setInterval(function() { self.requestAdvisories(stop); }, advisoryMs);
        });
    },

    // Normalize either the new `stops` list or the legacy single-station config
    // into one canonical list of stop objects with a stable `id`.
    normalizeStops: function() {
        var cfg = this.config;
        var self = this;
        var raw = (cfg.stops && cfg.stops.length) ? cfg.stops : [{
            provider: "bart",
            station: cfg.station,
            train_blacklist: cfg.train_blacklist,
        }];

        return raw.map(function(s, i) {
            var provider = s.provider || "bart";
            var agency = s.agency || "";
            var stop = {
                id: i + ":" + provider + ":" + agency + ":" + (s.station || ""),
                provider: provider,
                agency: agency,
                apiKey: s.apiKey || cfg.apiKey || "",
                station: s.station,
                label: s.label || "",
                train_blacklist: s.train_blacklist || [],
                advisory_blacklist: s.advisory_blacklist || [],
            };
            if (provider === "511") {
                var who = stop.label || stop.station || "(unnamed)";
                if (!stop.apiKey) Log.warn(self.name + ": 511 stop '" + who + "' has no apiKey (set config.apiKey or a per-stop apiKey)");
                if (!stop.agency) Log.warn(self.name + ": 511 stop '" + who + "' has no agency");
            }
            return stop;
        });
    },

    // Define required styles.
    getStyles: function() {
        return ["bart_times.css"];
    },

    requestDepartures: function(stop) {
        this.sendSocketNotification("GET_DEPARTURE_TIMES", { stop: stop });
    },
    requestAdvisories: function(stop) {
        this.sendSocketNotification("GET_SERVICE_ADVISORY", { stop: stop });
    },

    // True if a departure should be hidden. Match the trip's terminus station
    // code (e.g. 'DUBL', 'RICH') exactly, case-insensitively — train_blacklist
    // lists destination station codes. When the terminus code is unavailable
    // (a feed loaded without static stop_times), fall back to a case-
    // insensitive headsign substring match so a blacklist still does something
    // rather than silently showing every train.
    isBlacklistedTrain: function(dep, stop) {
        var list = stop.train_blacklist || [];
        if (!list.length) return false;
        var code = dep.destCode ? String(dep.destCode).toLowerCase() : null;
        var headsign = String(dep.headsign || "").toLowerCase();
        return list.some(function(needle) {
            if (!needle) return false;
            var n = String(needle).toLowerCase();
            return code ? code === n : headsign.indexOf(n) !== -1;
        });
    },

    // Display label for a departure. BART headsigns are full line paths
    // ("SF / OAK Airport / Dublin/Pleasanton"); by default show only the final
    // destination segment so the column stays narrow.
    headsignLabel: function(headsign) {
        var text = String(headsign || "");
        if (this.config.showFullHeadsign) return text;
        var parts = text.split(" / ");
        return parts[parts.length - 1] || text;
    },

    // True if an advisory should be muted (contains a blacklisted substring,
    // case-insensitive). Combines the global list with the stop's own.
    isMutedAdvisory: function(text, stop) {
        var lower = String(text || "").toLowerCase();
        var list = (this.config.advisory_blacklist || []).concat(stop.advisory_blacklist || []);
        return list.some(function(needle) {
            return needle && lower.indexOf(String(needle).toLowerCase()) !== -1;
        });
    },

    // Render one advisory as a single wrapping banner, truncated (at a word
    // boundary where possible) to advisoryMaxLength.
    appendAdvisory: function(container, advisory) {
        var text = String(advisory || "");
        var max = this.config.advisoryMaxLength;
        if (max > 0 && text.length > max) {
            var cut = text.slice(0, max);
            var atWord = cut.replace(/\s+\S*$/, "");
            text = (atWord.length > 0 ? atWord : cut) + "…";
        }
        var p = document.createElement("p");
        p.className = "bart-advisory";
        p.innerHTML = text;
        container.appendChild(p);
    },

    // Override dom generator.
    getDom: function() {
        var self = this;
        var wrapper = document.createElement("div");
        wrapper.className = "MMM-BartTimes";

        var anyLoaded = this.stops.some(function(stop) {
            return self.stopData[stop.id] || self.stopErrors[stop.id];
        });
        if (!anyLoaded) {
            wrapper.innerHTML = "LOADING";
            wrapper.className = "dimmed light small";
            return wrapper;
        }

        var multi = this.stops.length > 1;

        this.stops.forEach(function(stop) {
            var section = document.createElement("div");
            section.className = "bart-stop";

            var data = self.stopData[stop.id];

            // Per-stop sub-heading only when several stops share the module.
            if (multi) {
                var heading = document.createElement("div");
                heading.className = "bart-stop-heading";
                heading.innerHTML = stop.label || (data && data.station_name) || stop.station;
                section.appendChild(heading);
            }

            if (!data && self.stopErrors[stop.id]) {
                var errEl = document.createElement("div");
                errEl.className = "dimmed light xsmall";
                errEl.innerHTML = "Unavailable";
                section.appendChild(errEl);
                wrapper.appendChild(section);
                return;
            }

            if (data) {
                var table = document.createElement("table");
                table.className = "small";
                section.appendChild(table);

                data.departures.forEach(function(dep) {
                    if (self.isBlacklistedTrain(dep, stop)) {
                        return;
                    }

                    var row = document.createElement("tr");
                    table.appendChild(row);

                    var trainCell = document.createElement("td");
                    trainCell.className = "train";
                    trainCell.innerHTML = self.headsignLabel(dep.headsign);
                    row.appendChild(trainCell);

                    dep.times.forEach(function(time_to_departure) {
                        var timeCell = document.createElement("td");
                        timeCell.className = "time";
                        if (!isNaN(time_to_departure)) {
                            time_to_departure += ' min';
                        }
                        timeCell.innerHTML = time_to_departure;
                        row.appendChild(timeCell);
                    });
                });
            }

            var advisories = (self.stopAdvisories[stop.id] || []).filter(function(text) {
                return !self.isMutedAdvisory(text, stop);
            });
            if (self.config.maxAdvisories > 0) {
                advisories = advisories.slice(0, self.config.maxAdvisories);
            }
            advisories.forEach(function(advisory) {
                self.appendAdvisory(section, advisory);
            });

            wrapper.appendChild(section);
        });

        return wrapper;
    },

    // Override get header function
    getHeader: function() {
        if (this.stops && this.stops.length === 1) {
            var only = this.stops[0];
            var data = this.stopData && this.stopData[only.id];
            var name = only.label || (data && data.station_name) || only.station;
            return name + ' Departure Times';
        }
        return 'Bay Area Departures';
    },

    // Override notification handler.
    socketNotificationReceived: function(notification, payload) {
        if (!payload || !payload.id) {
            return;
        }
        if (notification === "DEPARTURE_TIMES") {
            this.stopData[payload.id] = payload.data;
            delete this.stopErrors[payload.id];
            this.updateDom();
        }
        if (notification === "DEPARTURE_ERROR") {
            this.stopErrors[payload.id] = payload.error;
            this.updateDom();
        }
        if (notification === "SERVICE_ADVISORY") {
            this.stopAdvisories[payload.id] = payload.advisories;
            this.updateDom();
        }
    },

});

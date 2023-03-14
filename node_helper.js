var needle = require('needle');
var NodeHelper = require("node_helper");
var { URL } = require('url');

TRAIN_BASE_URL = 'https://api.bart.gov/api/etd.aspx';
ADVISORY_BASE_URL = 'https://api.bart.gov/api/bsa.aspx';

module.exports = NodeHelper.create({

    start: function() {
        console.log("Starting node helper: " + this.name);
    },

    // Create a url to get estimated times of depature from the given station
    // using the API key
    build_search_url: function(station, key) {
        search_url = new URL(TRAIN_BASE_URL);
        search_url.searchParams.set('cmd', 'etd');
        search_url.searchParams.set('json', 'y');
        search_url.searchParams.set('key', key);
        search_url.searchParams.set('orig', station);
        return search_url
    },
    build_advisory_url: function(key) {
        advisory_url = new URL(ADVISORY_BASE_URL);
        advisory_url.searchParams.set('cmd', 'bsa');
        advisory_url.searchParams.set('json', 'y');
        advisory_url.searchParams.set('key', key);
        advisory_url.searchParams.set('date', 'today');
        return advisory_url
    },

    socketNotificationReceived: function(notification, payload) {
        var self = this
        console.log("Notification: " + notification + " Payload: " + payload);

        if(notification === "GET_DEPARTURE_TIMES") {

            var bart_url = this.build_search_url(payload.config.station, payload.config.key);
            needle.get(bart_url.href, function (error, response) {
                var departure_times = {};
                departure_times.trains = [];
                if (!error && response.statusCode == 200) {
                    trains = response.body.root.station[0];
                    departure_times.station_name = trains.name;

                    trains.etd.forEach(train => {
                        departure_times.trains.push(train.destination);
                        departure_times[train.destination] = [];
                        train.estimate.forEach(est => {
                            departure_times[train.destination].push(est.minutes);
                        })
                    });
                    console.log("Train times loaded:" + departure_times);
                    self.sendSocketNotification("DEPARTURE_TIMES", departure_times);
                }
                else {
                    console.log("Bart Loading failed", error, response.statusCode, response.body);
                }
            });
        }
        if(notification === "GET_SERVICE_ADVISORY") {

            var bart_url = this.build_advisory_url(payload.config.key);
            needle.get(bart_url.href, function (error, response) {
                var service_advisories = [];
                if (!error && response.statusCode == 200) {
                    advisories = response.body.root.bsa
                    console.log("advisories", advisories);
                    advisories.forEach(advisory => {
                        if(advisory.station != '' && (advisory.station.toLowerCase() == payload.config.station.toLowerCase() || advisory.station.toLowerCase() == 'bart')) {
                            service_advisories.push(advisory.description['#cdata-section'])
                        }
                    });

                    console.log("Service Advisories:" + service_advisories);
                    self.sendSocketNotification("SERVICE_ADVISORY", service_advisories);
                }
                else {
                    console.log("Bart Loading failed", error, response.statusCode, response.body);
                }
            });
        }
    },
});

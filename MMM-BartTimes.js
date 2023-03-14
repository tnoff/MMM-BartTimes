Module.register("MMM-BartTimes", {

    // Module config defaults.
    defaults: {
        key : 'MW9S-E7SL-26DU-VV8V', // Public BART API key
        train_blacklist: [],
        updateInterval : 30000, // 30 seconds
    },

    // Define start sequence.
    start: function() {
        Log.info("Starting module: " + this.name);

        var self = this;

        this.getDepartureInfo()
        this.getAdvisoryInfo()
        // Schedule update timer.
        setInterval(function() {
            self.getDepartureInfo()
        }, this.config.updateInterval);
        setInterval(function() {
            self.getAdvisoryInfo()
        }, this.config.updateInterval);
    },

    // Define required styles.
    getStyles: function() {
        return ["bart_times.css"];
    },

    getDepartureInfo: function() {
        Log.info("Requesting departure info");

        this.sendSocketNotification("GET_DEPARTURE_TIMES", {
            config: this.config
        });
    },
    getAdvisoryInfo: function() {
        Log.info("Requesting advisory info");

        this.sendSocketNotification("GET_SERVICE_ADVISORY", {
            config: this.config
        });
    },

    // Override dom generator.
    getDom: function() {
        var wrapper = document.createElement("div");

        if (!this.train_info) {
            wrapper.innerHTML = "LOADING";
            wrapper.className = "dimmed light small";
            return wrapper;
        }

        var wrapper = document.createElement("div");
        var table = document.createElement("table");
        table.className = "small";
        wrapper.appendChild(table);

        this.train_info.trains.forEach(train_name => {

            if (this.config.train_blacklist.includes(train_name)) {
                console.log('Ignoring train name in blacklist:' + train_name)
                return;
            }

            var row = document.createElement("tr");
            table.appendChild(row);

            var trainCell = document.createElement("td");
            trainCell.className = "train";
            trainCell.innerHTML = train_name;
            row.appendChild(trainCell);

            this.train_info[train_name].forEach( time_to_departure => {
                var timeCell = document.createElement("td");
                timeCell.className = "time";
                if (!isNaN(time_to_departure)) {
                    time_to_departure += ' min';
                }
                timeCell.innerHTML = time_to_departure;
                row.appendChild(timeCell);
            });
        });
        this.advisory_info.forEach(advisory => {
            var lower = 0;
            var higher = 75;
            if(higher > advisory.length){
                higher = advisory.length - 1;
            }
            var substring = advisory.substring(lower, higher);
            while(substring != ''){
                var row = document.createElement("p");
                wrapper.appendChild(row);
                row.innerHTML = substring;
                row.style = "background-color:Tomato;";
                lower = lower + 75;
                if(lower > advisory.length){
                    break;
                }
                higher = higher + 75;
                if(higher > advisory.length){
                    higher = advisory.length - 1;
                }
                substring = advisory.substring(lower, higher);
            }
        });

        return wrapper;
    },

    // Override get header function
    getHeader: function() {
        if (this.train_info) {
            console.log(this.train_info.station_name);
            return this.train_info.station_name + ' BART Departure Times';
        }
        return 'BART Departure Times';
    },

    // Override notification handler.
    socketNotificationReceived: function(notification, payload) {
        if (notification === "DEPARTURE_TIMES") {
            this.train_info = payload
            this.updateDom();
        }
        if (notification === "SERVICE_ADVISORY") {
            this.advisory_info = payload
            this.updateDom();
        }
    },

});
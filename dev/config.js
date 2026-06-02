/* Minimal MagicMirror config for local MMM-BartTimes development. */
let config = {
    address: "0.0.0.0",
    port: 8181,
    basePath: "/",
    ipWhitelist: [],

    useHttps: false,

    language: "en",
    locale: "en-US",
    logLevel: ["INFO", "LOG", "WARN", "ERROR"],
    timeFormat: 24,
    units: "imperial",

    modules: [
        {
            module: "MMM-BartTimes",
            position: "top_left",
            config: {
                station: "19TH",
            },
        },
    ],
};

if (typeof module !== "undefined") {
    module.exports = config;
}

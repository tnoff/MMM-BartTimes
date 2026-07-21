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

                // --- 511 multi-agency example (uncomment + add a token) ---
                // apiKey: "YOUR_511_TOKEN",   // https://511.org/open-data/token
                // stops: [
                //     { provider: "bart", station: "19TH", label: "19th St BART" },
                //     { provider: "511", agency: "SF", station: "13915", label: "Church & Market (Muni)" },
                // ],
            },
        },
    ],
};

if (typeof module !== "undefined") {
    module.exports = config;
}

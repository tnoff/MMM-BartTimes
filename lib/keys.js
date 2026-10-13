// Server-side API key resolution. Pure: the environment is passed in, so it is
// unit-tested without touching process.env.
//
// Why this exists: everything under a module's `config` in config.js is sent to
// every browser that loads the mirror (MagicMirror serves it at /config/). A
// 511 token written there is therefore public. The node helper runs only on the
// server, so it reads the key from its own environment instead and the key never
// reaches the client.

// Environment variable read for a provider when the config names none. Only
// keyed providers have one; BART's own feed needs no key.
const DEFAULT_KEY_ENV = { "511": "FIVE11_API_KEY" };

// `apiKeyEnv` may be one name or a list of names; the first that is set wins.
// Lists let one module hold several keys (one per stop, or a primary with a
// fallback) without any key being written into the config.
function envNames(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return value ? [value] : [];
}

// Returns `stop` carrying an apiKey, or `stop` unchanged when there is nothing to
// add. An explicit apiKey on the stop (config.apiKey / per-stop apiKey) wins, so
// existing configs keep working; the environment only fills a gap. Names are
// tried in this order: the stop's own apiKeyEnv, the module-wide `envName`, then
// the provider's default. Never mutates its input.
function resolveApiKey(stop, env, envName) {
    if (!stop || stop.apiKey || !env) return stop;
    const provider = stop.provider || "bart";
    const names = [].concat(
        envNames(stop.apiKeyEnv),
        envNames(envName),
        envNames(DEFAULT_KEY_ENV[provider]),
    );
    for (const name of names) {
        if (env[name]) return Object.assign({}, stop, { apiKey: env[name] });
    }
    return stop;
}

module.exports = { resolveApiKey, DEFAULT_KEY_ENV };

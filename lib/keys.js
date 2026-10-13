// Server-side API key resolution. Pure: the environment is passed in, so it is
// unit-tested without touching process.env.
//
// Why this exists: everything under a module's `config` in config.js is sent to
// every browser that loads the mirror (MagicMirror serves it at /config/). A
// 511 token written there is therefore public. The node helper runs only on the
// server, so it reads the key from its own environment instead and the key never
// reaches the client.

const DEFAULT_KEY_ENV = "BART_API_KEY";

// Returns `stop` carrying an apiKey, or `stop` unchanged when there is nothing to
// add. An explicit apiKey on the stop (config.apiKey / per-stop apiKey) wins, so
// existing configs keep working; the environment only fills a gap. Never mutates
// its input.
function resolveApiKey(stop, env, envName) {
    if (!stop || stop.apiKey) return stop;
    const name = stop.apiKeyEnv || envName || DEFAULT_KEY_ENV;
    const fromEnv = env && env[name];
    if (!fromEnv) return stop;
    return Object.assign({}, stop, { apiKey: fromEnv });
}

module.exports = { resolveApiKey, DEFAULT_KEY_ENV };

const test = require("node:test");
const assert = require("node:assert");

const { resolveApiKey, DEFAULT_KEY_ENV } = require("../lib/keys");

const stop511 = { provider: "511", agency: "CE", station: "73757" };

test("fills a missing apiKey from the default environment variable", () => {
    const out = resolveApiKey(stop511, { [DEFAULT_KEY_ENV]: "from-env" });
    assert.equal(out.apiKey, "from-env");
    assert.equal(out.agency, "CE");
});

test("an explicit apiKey wins over the environment", () => {
    const out = resolveApiKey({ ...stop511, apiKey: "from-config" }, { [DEFAULT_KEY_ENV]: "from-env" });
    assert.equal(out.apiKey, "from-config");
});

test("honours a per-stop apiKeyEnv, then the helper-wide name", () => {
    const env = { MY_KEY: "mine", OTHER: "other", [DEFAULT_KEY_ENV]: "default" };
    assert.equal(resolveApiKey({ ...stop511, apiKeyEnv: "MY_KEY" }, env, "OTHER").apiKey, "mine");
    assert.equal(resolveApiKey(stop511, env, "OTHER").apiKey, "other");
});

test("leaves the stop alone when no key is found", () => {
    assert.equal(resolveApiKey(stop511, {}), stop511);
    assert.equal(resolveApiKey(stop511, { [DEFAULT_KEY_ENV]: "" }), stop511);
    assert.equal(resolveApiKey(stop511, undefined), stop511);
    assert.equal(resolveApiKey(undefined, {}), undefined);
});

test("does not mutate the stop it was given", () => {
    const stop = { ...stop511 };
    resolveApiKey(stop, { [DEFAULT_KEY_ENV]: "from-env" });
    assert.equal(stop.apiKey, undefined);
});

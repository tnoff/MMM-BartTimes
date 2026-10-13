const test = require("node:test");
const assert = require("node:assert");

const { resolveApiKey, DEFAULT_KEY_ENV } = require("../lib/keys");

const stop511 = { provider: "511", agency: "CE", station: "73757" };
const DEFAULT_511 = DEFAULT_KEY_ENV["511"];

test("a 511 stop falls back to the provider's default variable", () => {
    assert.equal(DEFAULT_511, "FIVE11_API_KEY");
    const out = resolveApiKey(stop511, { [DEFAULT_511]: "from-env" });
    assert.equal(out.apiKey, "from-env");
    assert.equal(out.agency, "CE");
});

test("does not read a BART-named variable for a 511 stop", () => {
    assert.equal(resolveApiKey(stop511, { BART_API_KEY: "legacy" }), stop511);
});

test("an explicit apiKey wins over the environment", () => {
    const out = resolveApiKey({ ...stop511, apiKey: "from-config" }, { [DEFAULT_511]: "from-env" });
    assert.equal(out.apiKey, "from-config");
});

test("per-stop apiKeyEnv beats the module-wide name, which beats the default", () => {
    const env = { MINE: "mine", SHARED: "shared", [DEFAULT_511]: "default" };
    assert.equal(resolveApiKey({ ...stop511, apiKeyEnv: "MINE" }, env, "SHARED").apiKey, "mine");
    assert.equal(resolveApiKey(stop511, env, "SHARED").apiKey, "shared");
    assert.equal(resolveApiKey(stop511, env).apiKey, "default");
});

test("two stops can use two different keys", () => {
    const env = { KEY_A: "a", KEY_B: "b" };
    assert.equal(resolveApiKey({ ...stop511, apiKeyEnv: "KEY_A" }, env).apiKey, "a");
    assert.equal(resolveApiKey({ ...stop511, apiKeyEnv: "KEY_B" }, env).apiKey, "b");
});

test("apiKeyEnv may be a list; the first variable that is set wins", () => {
    const stop = { ...stop511, apiKeyEnv: ["FIRST", "SECOND", "THIRD"] };
    assert.equal(resolveApiKey(stop, { SECOND: "two", THIRD: "three" }).apiKey, "two");
    assert.equal(resolveApiKey(stop, { FIRST: "one", SECOND: "two" }).apiKey, "one");
    // Falls through the list to the provider default when none are set.
    assert.equal(resolveApiKey(stop, { [DEFAULT_511]: "default" }).apiKey, "default");
    // An empty variable counts as unset.
    assert.equal(resolveApiKey(stop, { FIRST: "", SECOND: "two" }).apiKey, "two");
});

test("leaves the stop alone when no key is found", () => {
    assert.equal(resolveApiKey(stop511, {}), stop511);
    assert.equal(resolveApiKey(stop511, { [DEFAULT_511]: "" }), stop511);
    assert.equal(resolveApiKey(stop511, undefined), stop511);
    assert.equal(resolveApiKey(undefined, {}), undefined);
});

test("a keyless BART stop never gets a key from the default", () => {
    const bart = { provider: "bart", station: "19TH" };
    assert.equal(resolveApiKey(bart, { [DEFAULT_511]: "x", BART_API_KEY: "y" }), bart);
});

test("does not mutate the stop it was given", () => {
    const stop = { ...stop511 };
    resolveApiKey(stop, { [DEFAULT_511]: "from-env" });
    assert.equal(stop.apiKey, undefined);
});

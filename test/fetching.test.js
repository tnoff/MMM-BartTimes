const test = require("node:test");
const assert = require("node:assert");

const {
    withRetries,
    httpError,
    isRetryableError,
    urlAttributes,
    redactUrl,
} = require("../lib/fetching");

// Collects the backoff waits instead of sleeping through them.
function recordingSleep(waited) {
    return (ms) => {
        waited.push(ms);
        return Promise.resolve();
    };
}

test("isRetryableError retries 5xx and transport failures, not 4xx", () => {
    assert.equal(isRetryableError(httpError("boom", 500)), true);
    assert.equal(isRetryableError(httpError("boom", 503)), true);
    assert.equal(isRetryableError(httpError("slow", 408)), true);
    // No status at all: DNS failure, reset socket, per-attempt timeout,
    // truncated body that failed to decode.
    assert.equal(isRetryableError(new Error("fetch failed")), true);

    assert.equal(isRetryableError(httpError("nope", 404)), false);
    assert.equal(isRetryableError(httpError("bad key", 403)), false);
    // 429 stays off the list on purpose: a 511 token does not refill inside
    // the backoff window, so retrying only burns more of the hourly quota.
    assert.equal(isRetryableError(httpError("slow down", 429)), false);
});

test("withRetries returns the first success without sleeping", async () => {
    const waited = [];
    let calls = 0;

    const result = await withRetries("bart.tripupdate", {}, async () => {
        calls++;
        return "feed";
    }, { sleepImpl: recordingSleep(waited) });

    assert.equal(result, "feed");
    assert.equal(calls, 1);
    assert.deepEqual(waited, []);
});

test("withRetries retries a 500 and returns the eventual success", async () => {
    const waited = [];
    let calls = 0;

    const result = await withRetries("bart.tripupdate", {}, async () => {
        calls++;
        if (calls < 3) throw httpError("Feed fetch failed: 500", 500);
        return "feed";
    }, { sleepImpl: recordingSleep(waited) });

    assert.equal(result, "feed");
    assert.equal(calls, 3);
    assert.deepEqual(waited, [250, 750]);
});

test("withRetries gives up after the attempt budget and rethrows the last error", async () => {
    const waited = [];
    let calls = 0;

    await assert.rejects(
        withRetries("bart.tripupdate", {}, async () => {
            calls++;
            throw httpError(`attempt ${calls} failed`, 503);
        }, { sleepImpl: recordingSleep(waited) }),
        /attempt 3 failed/,
    );

    assert.equal(calls, 3);
    assert.deepEqual(waited, [250, 750]);
});

test("withRetries does not retry a 4xx", async () => {
    const waited = [];
    let calls = 0;

    await assert.rejects(
        withRetries("bart.static", {}, async () => {
            calls++;
            throw httpError("Static GTFS fetch failed: 404", 404);
        }, { sleepImpl: recordingSleep(waited) }),
        /404/,
    );

    assert.equal(calls, 1);
    assert.deepEqual(waited, []);
});

test("urlAttributes keeps the query string out of the span", () => {
    const attrs = urlAttributes("https://api.511.org/transit/tripupdates?api_key=sekret&agency=BA");
    assert.deepEqual(attrs, {
        "server.address": "api.511.org",
        "url.path": "/transit/tripupdates",
        "url.scheme": "https",
    });
    assert.equal(JSON.stringify(attrs).includes("sekret"), false);
});

test("urlAttributes tolerates a malformed url", () => {
    assert.deepEqual(urlAttributes("not a url"), {});
});

test("redactUrl masks the 511 api key and leaves other urls alone", () => {
    assert.equal(
        redactUrl("https://api.511.org/transit/tripupdates?api_key=sekret&agency=BA"),
        "https://api.511.org/transit/tripupdates?api_key=REDACTED&agency=BA",
    );
    assert.equal(
        redactUrl("https://api.bart.gov/gtfsrt/tripupdate.aspx"),
        "https://api.bart.gov/gtfsrt/tripupdate.aspx",
    );
    assert.equal(redactUrl("not a url"), "not a url");
});

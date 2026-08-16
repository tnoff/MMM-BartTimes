// Span semantics for withRetries, exercised against a real SDK + exporter
// rather than a stub tracer — the whole point of the wrapper is what actually
// reaches the collector, and a hand-rolled fake would happily agree with a
// broken implementation.
const test = require("node:test");
const assert = require("node:assert");

const api = require("@opentelemetry/api");
const {
    NodeTracerProvider,
    InMemorySpanExporter,
    SimpleSpanProcessor,
} = require("@opentelemetry/sdk-trace-node");

const { withRetries, httpError } = require("../lib/fetching");

const exporter = new InMemorySpanExporter();
new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
}).register();

const noSleep = () => Promise.resolve();

test.beforeEach(() => exporter.reset());

test("a first-attempt success exports one OK span", async () => {
    await withRetries("bart.tripupdate", { "transit.provider": "bart" }, async () => "feed", {
        sleepImpl: noSleep,
    });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "bart.tripupdate");
    assert.equal(spans[0].status.code, api.SpanStatusCode.OK);
    assert.equal(spans[0].attributes["transit.provider"], "bart");
    assert.equal(spans[0].attributes["http.request.resend_count"], 0);
    assert.equal(spans[0].events.length, 0);
});

// The regression this whole change exists for: a 500 that a retry recovers
// from must not leave an error span behind for `{status=error}` to find.
test("a recovered 500 exports one OK span, not an error", async () => {
    let calls = 0;
    await withRetries("bart.tripupdate", {}, async () => {
        calls++;
        if (calls === 1) throw httpError("Feed fetch failed: 500", 500);
        return "feed";
    }, { sleepImpl: noSleep });

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, api.SpanStatusCode.OK);
    assert.equal(spans[0].attributes["http.request.resend_count"], 1);

    // The failed attempt is still visible — as an event on the successful
    // span, so it can be counted without being alerted on.
    assert.equal(spans[0].events.length, 1);
    assert.equal(spans[0].events[0].name, "fetch.attempt.failed");
    assert.equal(spans[0].events[0].attributes["http.response.status_code"], 500);
    assert.equal(spans[0].events[0].attributes["retry.attempt"], 1);
    assert.equal(spans[0].events[0].attributes["retry.will_retry"], true);
});

test("an exhausted retry budget exports one error span carrying a message", async () => {
    await assert.rejects(withRetries("bart.tripupdate", {}, async () => {
        throw httpError("Feed fetch failed: 500", 500);
    }, { sleepImpl: noSleep }));

    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].status.code, api.SpanStatusCode.ERROR);
    // Never a bare ERROR with no message — that reads as a hand-set status
    // with nothing to triage from.
    assert.equal(spans[0].status.message, "Feed fetch failed: 500");
    assert.equal(spans[0].attributes["http.request.resend_count"], 2);
    assert.equal(spans[0].attributes["http.response.status_code"], 500);
    assert.equal(spans[0].events.filter(e => e.name === "fetch.attempt.failed").length, 3);
    assert.equal(spans[0].events.some(e => e.name === "exception"), true);
});

// The mechanism that keeps the auto-instrumented per-attempt HTTP spans from
// being created at all. instrumentation-undici does not check suppression
// itself — the SDK's Tracer.startSpan does, which is why suppressing the
// context is enough to cover any instrumentation running underneath.
test("spans started inside the retried work are suppressed", async () => {
    let inner;
    await withRetries("bart.tripupdate", {}, async () => {
        // Stands in for the undici instrumentation's own tracer.
        inner = api.trace.getTracer("pretend-instrumentation").startSpan("GET");
        inner.setStatus({ code: api.SpanStatusCode.ERROR, message: "500" });
        inner.end();
        return "feed";
    }, { sleepImpl: noSleep });

    assert.equal(inner.isRecording(), false);
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].name, "bart.tripupdate");
});

test("the wrapper span is a real parent for anything traced outside the work", async () => {
    await withRetries("bart.static", {}, async () => "zip", { sleepImpl: noSleep });
    const [span] = exporter.getFinishedSpans();
    assert.equal(span.kind, api.SpanKind.CLIENT);
    assert.equal(api.trace.isSpanContextValid(span.spanContext()), true);
});

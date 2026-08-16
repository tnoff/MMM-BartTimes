// Outbound-fetch policy for node_helper.js: bounded retries with backoff, and
// exactly one span per logical fetch whose status reflects the *final*
// outcome.
//
// Like lib/gtfs.js this module does no I/O of its own — the caller hands in
// the work to run (`withRetries(name, attrs, work)`), which is what keeps the
// retry policy unit-testable with no network and no mocks of `fetch`.

// OpenTelemetry is optional. The package is declared as a dependency, but a
// hand-dropped install of this module may not have run `npm install`, and the
// API is a no-op unless something else in the process registered an SDK (in
// the container that is MagicMirror's `--require ./otel-init.js`). Everything
// below degrades to plain un-traced fetches when it is missing.
let api = null;
try {
    api = require("@opentelemetry/api");
} catch (err) {
    api = null;
}

const TRACER_NAME = "MMM-BartTimes";

// The context key @opentelemetry/core's suppressTracing() sets. We rebuild it
// from the public API instead of depending on an SDK package: createContextKey
// is Symbol.for(), so this is the *same* symbol the SDK's Tracer checks even
// though the SDK resolves its own copy of @opentelemetry/api from
// MagicMirror's node_modules while we resolve ours. See withSpan for why we
// set it.
const SUPPRESS_TRACING_KEY = api
    ? api.createContextKey("OpenTelemetry SDK Context Key SUPPRESS_TRACING")
    : null;

// 3 attempts with 250ms/750ms of backoff. The whole chain has to finish inside
// one refresh tick (trainUpdateInterval, 30s floor for BART) or ticks start
// overlapping, which is what bounds both numbers below:
//   8s + 250ms + 8s + 750ms + 8s = 25s worst case.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 750];
// Per-attempt timeouts. Before this there was none at all, so a hung socket
// wedged the fetch until the runtime gave up — the one failure mode retries
// cannot see. The realtime feeds are a few hundred KB; the static bundle is a
// ~5MB zip fetched at most once per 24h, so it gets a much longer leash.
const FEED_TIMEOUT_MS = 8000;
const STATIC_TIMEOUT_MS = 60000;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Build an Error carrying the HTTP status, so isRetryableError below can tell
// "the server is broken" from "we asked for the wrong thing".
function httpError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Retry only what another attempt can plausibly fix.
//
// 5xx and transport-level failures (DNS, reset socket, per-attempt timeout,
// truncated body that fails to decode) are worth one more go. 4xx is not: a
// bad 511 key or an unknown feed path fails identically forever.
//
// 429 is deliberately NOT retried. A rate-limited 511 token does not refill
// inside a 750ms backoff, so retrying only burns more of the ~60 req/hr quota;
// the next refresh tick is the right retry there.
function isRetryableError(err) {
    const status = err && err.status;
    if (typeof status === "number") return status >= 500 || status === 408;
    return true;
}

// Span attributes derived from a URL. Deliberately no url.full / url.query:
// every 511 endpoint carries the api_key as a query param, and these
// attributes are exported to a trace backend.
function urlAttributes(url) {
    try {
        const u = new URL(url);
        return {
            "server.address": u.hostname,
            "url.path": u.pathname,
            "url.scheme": u.protocol.replace(":", ""),
        };
    } catch (err) {
        return {};
    }
}

// Same reasoning for anything that ends up in a log line or, via
// DEPARTURE_ERROR, on the mirror itself: keep the api_key off the screen.
function redactUrl(url) {
    try {
        const u = new URL(url);
        if (u.searchParams.has("api_key")) u.searchParams.set("api_key", "REDACTED");
        return u.toString();
    } catch (err) {
        return url;
    }
}

// Run `work` inside one span, or unwrapped when OpenTelemetry is absent.
//
// The span deliberately covers the whole logical fetch — every attempt, plus
// the decode — because the point is a span whose status answers "did this
// refresh get its data", not "how did HTTP attempt #2 go". While it is open we
// also suppress tracing, so the auto-instrumented per-attempt HTTP client
// spans are never created: the undici instrumentation marks any response >=400
// as ERROR at response time, and an ended span cannot be re-statused once a
// later attempt succeeds. Suppressing them is what keeps a retried-away 500
// from showing up as an error in Tempo.
function withSpan(name, attributes, work) {
    const tracer = api ? api.trace.getTracer(TRACER_NAME) : null;
    if (!tracer) return work(null);

    const span = tracer.startSpan(name, { kind: api.SpanKind.CLIENT, attributes });
    // Only take over from the auto-instrumentation when our span is really
    // being recorded. If the API package we resolved isn't the one the SDK
    // registered (no SDK, or a major-version mismatch — the global registry is
    // keyed per API major) our span is a silent no-op, and suppressing the
    // per-attempt spans on top of that would leave the fetch untraced
    // altogether. Falling back to the auto spans is the safe direction.
    let ctx = api.trace.setSpan(api.context.active(), span);
    if (span.isRecording()) ctx = ctx.setValue(SUPPRESS_TRACING_KEY, true);

    return api.context.with(ctx, async () => {
        try {
            return await work(span);
        } finally {
            span.end();
        }
    });
}

/**
 * Run `work` with bounded retries inside a single span.
 *
 * `work(attempt)` should do one attempt and throw on failure — the thrown
 * error's `status` (see httpError) decides whether another attempt happens.
 * Keep lookups and validation *outside* it: everything thrown in here is
 * treated as a transient failure worth retrying.
 *
 * The span ends OK the moment any attempt succeeds, carrying
 * http.request.resend_count (0 when the first attempt worked), with one
 * `fetch.attempt.failed` event per failed attempt. It ends ERROR only when
 * every attempt failed.
 */
async function withRetries(name, attributes, work, opts = {}) {
    const {
        maxAttempts = MAX_ATTEMPTS,
        retryDelaysMs = RETRY_DELAYS_MS,
        sleepImpl = sleep,
    } = opts;

    return withSpan(name, attributes, async (span) => {
        for (let attempt = 1; ; attempt++) {
            try {
                const result = await work(attempt);
                if (span) {
                    span.setAttribute("http.request.resend_count", attempt - 1);
                    span.setStatus({ code: api.SpanStatusCode.OK });
                }
                return result;
            } catch (err) {
                const willRetry = isRetryableError(err) && attempt < maxAttempts;
                if (span) {
                    const event = {
                        "retry.attempt": attempt,
                        "retry.will_retry": willRetry,
                        "error.message": String((err && err.message) || err),
                    };
                    if (typeof (err && err.status) === "number") {
                        event["http.response.status_code"] = err.status;
                    }
                    span.addEvent("fetch.attempt.failed", event);
                }
                if (!willRetry) {
                    if (span) {
                        span.setAttribute("http.request.resend_count", attempt - 1);
                        // Only on the failure path: it is the status that made
                        // the operation fail, so error spans stay queryable by
                        // it. A success carries no status attribute — the span
                        // covers several attempts and the OK status says it.
                        if (typeof (err && err.status) === "number") {
                            span.setAttribute("http.response.status_code", err.status);
                        }
                        span.recordException(err);
                        span.setStatus({
                            code: api.SpanStatusCode.ERROR,
                            message: String((err && err.message) || err),
                        });
                    }
                    throw err;
                }
                await sleepImpl(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)]);
            }
        }
    });
}

module.exports = {
    withRetries,
    httpError,
    isRetryableError,
    urlAttributes,
    redactUrl,
    MAX_ATTEMPTS,
    RETRY_DELAYS_MS,
    FEED_TIMEOUT_MS,
    STATIC_TIMEOUT_MS,
};

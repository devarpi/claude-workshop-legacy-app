# Enhancement Plan: Rate Limiting for REST API

---

## 1. HLD — High-Level Design

### 1. Overview

This enhancement adds per-API-key rate limiting to the existing Node.js/Express REST API. Currently, any client with a valid API key can make an unbounded number of requests, which has caused service degradation when individual clients send thousands of requests per minute. The solution introduces a sliding-window or fixed-window rate limiter that tracks request counts per API key, enforces a limit of 1,000 requests per rolling hour, and returns standard HTTP 429 (Too Many Requests) responses when a client exceeds its quota. An additional endpoint allows clients (and operators) to query current usage for a given key.

**Business/user motivation**: Protect the service from accidental or intentional abuse, ensure fair resource distribution across all API consumers, and provide a clear, documented mechanism for clients to self-monitor their usage before hitting limits.

---

### 2. Goals & Non-Goals

**Goals**
- Enforce a hard limit of 1,000 requests per hour per API key across all endpoints.
- Return RFC 7807-compliant HTTP 429 responses with `Retry-After` and rate-limit headers.
- Provide a `GET /v1/usage` endpoint so clients can check their current consumption and reset time.
- Make the rate-limit configuration (window size, limit) adjustable without a code deploy.
- Support the existing single-instance Express deployment on day one, with a path to multi-instance support.

**Non-Goals**
- Per-endpoint rate limiting (e.g., tighter limits on expensive endpoints) — out of scope for this iteration.
- IP-based rate limiting — API-key-based limiting only.
- Dynamic per-key quota tiers (e.g., premium vs. free keys) — flat limit for all keys in v1.
- Distributed rate limiting across multiple nodes in this iteration — single-node first, Redis-backed expansion is a follow-on.
- Billing or metering integration.
- Blocking/banning keys permanently.

---

### 3. Architecture Overview

The rate limiter is implemented as an Express middleware that intercepts every request after API key authentication and before route handlers. A backing store (in-memory for v1, Redis-upgradeable) maintains a counter and window-start timestamp per API key.

```
Client Request
      │
      ▼
┌─────────────────────────────────────────────┐
│              Express App                     │
│                                             │
│  1. Auth Middleware (existing)              │
│     └── Extracts + validates API key        │
│                                             │
│  2. Rate Limit Middleware (NEW)             │
│     ├── Reads counter from store            │
│     ├── IF over limit → return 429          │
│     └── ELSE increment counter, continue   │
│                                             │
│  3. Route Handlers (existing, unchanged)    │
│                                             │
│  4. GET /v1/usage route (NEW)               │
│     └── Returns current count + reset time  │
└─────────────────────────────────────────────┘
              │
              ▼
       Rate Limit Store
    ┌─────────────────────┐
    │  In-Memory Store     │  ◄── v1 (single node)
    │  (node-rate-limiter- │
    │   flexible or custom)│
    └─────────────────────┘
         (upgradeable to)
    ┌─────────────────────┐
    │      Redis           │  ◄── future multi-node
    └─────────────────────┘
```

**What is new**: Rate limit middleware module, rate limit store abstraction, `/v1/usage` endpoint, configuration constants, and rate-limit response headers on all API responses.

**What is modified**: The Express app entry point to register the new middleware; no existing route handlers are changed.

---

### 4. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Window algorithm | Fixed window (per-hour bucket) | Simple to implement and reason about; predictable reset times that clients can display to users. Sliding window is more accurate but adds complexity not needed for v1. |
| Backing store | In-memory (Map) with Redis upgrade path | Eliminates operational dependency for v1; the store is abstracted behind an interface so swapping to Redis requires no middleware changes. |
| Middleware placement | After auth, before routes | API key must be known before we can key the counter; all route handlers benefit automatically without per-route changes. |
| Library vs. custom | `express-rate-limit` (or `rate-limiter-flexible`) | Battle-tested, actively maintained, supports multiple stores including Redis, handles header injection, and is a single `npm install`. |
| Response format | Standard `Retry-After` header + JSON body | Follows RFC 6585 and common industry practice; gives clients machine-readable and human-readable information. |

**Trade-off noted**: Fixed window allows a burst of up to 2× the limit at window boundaries (last second of window N + first second of window N+1). Acceptable for v1; can be addressed with sliding window in a future iteration if abuse is observed.

---

### 5. Dependencies & Integrations

- **`express-rate-limit`** (npm): Core rate-limiting middleware. Well-maintained (>10M weekly downloads), MIT license.
- **`rate-limiter-flexible`** (npm, optional): Alternative if Redis-backed store is needed sooner; provides identical API across in-memory and Redis.
- **Existing auth middleware**: The rate limiter depends on the API key being attached to `req.apiKey` (or equivalent) by the upstream auth middleware.
- **No external service dependencies** for v1.

> **Assumption:** The existing auth middleware populates `req.apiKey` (a string) on every authenticated request, and unauthenticated requests are rejected before reaching the rate limiter.

---

### 6. Non-Functional Requirements

- **Performance**: The rate limit check must add less than 2ms of latency at p99 for in-memory store. This is well within reach for an in-memory Map lookup.
- **Scalability**: v1 is single-node. The store abstraction must allow migration to Redis without changing middleware logic.
- **Security**: Rate limit counters are keyed by API key, not IP, so VPN/proxy evasion of limits is not a concern in this model. The `/v1/usage` endpoint must require a valid API key (shows only the caller's own usage).
- **Observability**: Log a structured warning when a 429 is issued (key, endpoint, count). Expose a counter metric (`rate_limit_exceeded_total`) if a metrics library is already in use.
- **Configuration**: Window duration and request limit are read from environment variables (`RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`) with safe defaults of `3600000` and `1000`.

---

## 2. LLD — Low-Level Design

### 1. Component Breakdown

#### a. `src/middleware/rateLimiter.js` (new)

**Responsibility**: Export a configured `express-rate-limit` middleware instance that:
- Keys each request by `req.apiKey`.
- Allows 1,000 requests per 60-minute window.
- Injects standard rate-limit headers on every response.
- Returns a 429 JSON response when the limit is exceeded.

**Inputs**: `req.apiKey` (string, set by auth middleware), `process.env.RATE_LIMIT_MAX_REQUESTS`, `process.env.RATE_LIMIT_WINDOW_MS`.

**Outputs**: Either calls `next()` (within limit) or sends a 429 response.

#### b. `src/routes/usage.js` (new)

**Responsibility**: Expose `GET /v1/usage` — returns the calling API key's current request count, the limit, and the window reset timestamp.

**Inputs**: `req.apiKey`, shared rate-limit store reference.

**Outputs**: JSON body with usage metadata.

#### c. `src/app.js` (modified)

**Responsibility**: Register the rate-limit middleware globally after the auth middleware; mount the `/v1/usage` route.

#### d. `src/config/rateLimitConfig.js` (new)

**Responsibility**: Export validated configuration constants.

```js
// src/config/rateLimitConfig.js
module.exports = {
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 1000,
};
```

---

### 2. Data Model Changes

No database schema changes are required. Rate limit state is held entirely in the rate-limit store (in-memory Map or Redis hash).

**In-memory store entry** (managed internally by `express-rate-limit`):

```js
// Conceptual structure per API key
{
  totalHits: 42,          // requests in current window
  resetTime: Date,        // when the window resets (Date object)
}
```

**`/v1/usage` response schema**:

```json
{
  "apiKey": "ak_abc123",       // or masked: "ak_abc***"
  "limit": 1000,
  "remaining": 958,
  "used": 42,
  "resetAt": "2025-04-01T15:00:00.000Z"   // ISO 8601
}
```

---

### 3. Logic & Algorithms

#### Rate limit middleware flow

```
function rateLimitMiddleware(req, res, next):
  key = req.apiKey
  windowMs = config.windowMs        // 3,600,000 ms
  max = config.max                  // 1000

  record = store.get(key)
  now = Date.now()

  IF record is null OR now >= record.resetTime:
    store.set(key, { totalHits: 1, resetTime: now + windowMs })
    set headers (X-RateLimit-Limit, X-RateLimit-Remaining=999, X-RateLimit-Reset)
    return next()

  IF record.totalHits >= max:
    retryAfter = ceil((record.resetTime - now) / 1000)  // seconds
    res.set('Retry-After', retryAfter)
    set headers (X-RateLimit-Limit, X-RateLimit-Remaining=0, X-RateLimit-Reset)
    return res.status(429).json({
      error: 'Too Many Requests',
      message: `Rate limit of ${max} requests/hour exceeded.`,
      retryAfter: retryAfter
    })

  record.totalHits += 1
  store.set(key, record)
  set headers
  return next()
```

> **Assumption:** `express-rate-limit` v7+ handles this logic internally when provided a `keyGenerator` and `store`. The pseudocode above describes the equivalent behavior for documentation purposes.

#### `keyGenerator` function

```js
const keyGenerator = (req) => {
  if (!req.apiKey) {
    // Should never happen if auth middleware is correctly ordered
    throw new Error('rateLimiter: req.apiKey is not set');
  }
  return req.apiKey;
};
```

---

### 4. API / Interface Design

#### Existing endpoints — new response headers added to all

```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 958
X-RateLimit-Reset: 1743519600   // Unix timestamp (seconds) of window reset
Retry-After: 2847               // Only present on 429 responses
```

#### 429 Response Body

```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 2847
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1743519600

{
  "error": "Too Many Requests",
  "message": "Rate limit of 1000 requests/hour exceeded. Retry after 2847 seconds.",
  "retryAfter": 2847
}
```

#### New Endpoint: `GET /v1/usage`

**Authentication**: Requires valid API key (same auth middleware as all other routes).

**Request**:
```
GET /v1/usage HTTP/1.1
Authorization: Bearer ak_abc123
```

**Success Response (200)**:
```json
{
  "apiKey": "ak_abc***",
  "limit": 1000,
  "used": 42,
  "remaining": 958,
  "resetAt": "2025-04-01T15:00:00.000Z",
  "windowMs": 3600000
}
```

**Error Response (401)** — if no valid API key:
```json
{
  "error": "Unauthorized",
  "message": "A valid API key is required."
}
```

> **Assumption:** The `/v1/usage` request itself counts against the caller's rate limit (it is a normal API request). This prevents abuse of the usage endpoint as a way to probe the system without consuming quota... actually, counting it is the simpler and fairer approach.

---

### 5. Error Handling & Edge Cases

| Scenario | Detection | Handling |
|---|---|---|
| `req.apiKey` is undefined | Check in `keyGenerator` | Log an error and fall back to IP address as key (defense-in-depth); this indicates a middleware ordering bug that should be separately fixed. |
| Store read/write throws (future Redis failure) | try/catch around store operations | Log the error, fail open (allow the request) to avoid a rate-limiter outage taking down the API; emit a metric. |
| Concurrent requests from same key at window boundary | Atomic increment in Redis (future); for in-memory, Node.js single-threaded event loop prevents race conditions. | No additional handling needed for v1 in-memory store. |
| Clock skew on server restart | `resetTime` stored as absolute epoch ms | Window resets at correct wall-clock time regardless of server restart time. |
| `RATE_LIMIT_MAX_REQUESTS` set to 0 or negative | Validation in config module | Throw at startup: `Error: RATE_LIMIT_MAX_REQUESTS must be a positive integer`. |
| Very large API key strings | `keyGenerator` enforces max key length | Truncate or hash keys longer than 256 characters to prevent memory abuse. |

---

### 6. Testing Considerations

#### Unit tests (`src/middleware/__tests__/rateLimiter.test.js`)

- **Within limit**: Assert that 999 sequential requests from the same key all receive `X-RateLimit-Remaining` decreasing from 999 to 1 and HTTP 200.
- **At limit boundary**: The 1,000th request succeeds; the 1,001st returns 429.
- **Window reset**: Mock `Date.now()` to advance past the window; assert the counter resets and the next request succeeds with `remaining: 999`.
- **Multiple keys**: Requests from key A do not affect key B's counter.
- **Missing `req.apiKey`**: Assert fallback behavior and error log.

#### Integration tests (`test/integration/rateLimiting.test.js`)

- Spin up the Express app in test mode.
- Make 1,001 requests in sequence using a single test API key; assert first 1,000 return 200, 1,001st returns 429 with correct body and headers.
- Call `GET /v1/usage` and assert the response body matches the expected counters.
- Assert that `Retry-After` header is present and numeric on 429 responses.
- Assert that rate-limit headers are present on successful responses.

#### Key assertions

- `res.status` is 429 when limit is exceeded.
- `res.headers['retry-after']` is a positive integer string.
- `res.body.retryAfter` matches the header value.
- `GET /v1/usage` returns `used + remaining === limit`.
- `GET /v1/usage` is itself subject to rate limiting (counted).

---

## 3. EARS — Requirements Plan

### Functional Requirements

**FR-1**: The system shall enforce a maximum of 1,000 requests per API key within any one-hour fixed window.

**FR-2**: WHEN a request is received, the system shall identify the rate limit bucket using the API key extracted by the authentication middleware.

**FR-3**: WHEN a request arrives and the API key's request count for the current window is below 1,000, the system shall increment the counter and forward the request to the appropriate route handler.

**FR-4**: WHEN a request arrives and the API key's request count for the current window has reached or exceeded 1,000, the system shall reject the request with an HTTP 429 status code without invoking the route handler.

**FR-5**: WHEN the system returns a 429 response, the system shall include a `Retry-After` header containing the number of seconds until the current rate limit window resets.

**FR-6**: WHEN the system returns a 429 response, the system shall include a JSON body with the fields `error`, `message`, and `retryAfter`.

**FR-7**: The system shall include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers on every API response (including successful responses and 429 responses).

**FR-8**: WHEN a new rate limit window begins for an API key, the system shall reset that key's request counter to zero.

**FR-9**: The system shall expose a `GET /v1/usage` endpoint that returns the calling API key's current request count, remaining quota, limit, and window reset timestamp.

**FR-10**: WHEN a client calls `GET /v1/usage`, the system shall count that request against the client's rate limit quota.

**FR-11**: WHILE the application is starting, the system shall validate rate limit configuration values and halt startup with a descriptive error if values are invalid (e.g., limit is zero or negative).

**FR-12**: IF `req.apiKey` is not set when the rate limit middleware executes, THEN the system shall log an error, fall back to the request IP address as the rate limit key, and continue processing.

---

### Performance Requirements

**PR-1**: The system shall add no more than 2ms of latency at the 99th percentile to any API request due to rate limit processing, using the in-memory store.

**PR-2**: The system shall support at least 500 concurrent API keys being rate-limited simultaneously without degradation in rate limit check performance.

**PR-3**: WHEN a Redis-backed store is configured, the system shall add no more than 5ms of latency at the 99th percentile to any API request due to rate limit processing.

---

### Security Requirements

**SR-1**: The system shall apply rate limiting after API key authentication, so unauthenticated requests are rejected before consuming rate limit quota.

**SR-2**: The `GET /v1/usage` endpoint shall require a valid API key; requests without a valid key shall receive an HTTP 401 response.

**SR-3**: The `GET /v1/usage` endpoint shall return usage data only for the API key of the authenticated caller; it shall not expose usage data for other API keys.

**SR-4**: IF an API key string exceeds 256 characters in length, THEN the system shall hash or truncate the key before using it as a store key to prevent memory exhaustion attacks.

---

### Reliability Requirements

**RR-1**: WHILE the in-memory rate limit store is in use, the system shall maintain rate limit state correctly across the lifetime of a single process instance.

**RR-2**: IF the rate limit store raises an exception during a read or write operation, THEN the system shall log the error, allow the request to proceed (fail open), and emit an observable signal (log or metric).

**RR-3**: WHEN the Express process restarts, the system shall reset all in-memory rate limit counters; clients may make up to 1,000 requests immediately after a restart.

> **Assumption:** Process restart resetting counters is acceptable for v1. If continuity across restarts is required, a persistent store (Redis) must be used, which is scoped as a follow-on.

**RR-4**: The rate limit middleware shall not prevent the Express application from starting if configuration is valid.

---

### Usability / API Ergonomics Requirements

**UE-1**: The system shall include a human-readable `message` field in 429 response bodies that states the limit, the window duration, and how long to wait before retrying.

**UE-2**: The `resetAt` field in `GET /v1/usage` responses shall be formatted as an ISO 8601 UTC timestamp string.

**UE-3**: The `X-RateLimit-Reset` header on all responses shall be a Unix timestamp in seconds (integer), following the de facto standard used by GitHub, Stripe, and Twitter APIs.

**UE-4**: The system shall return consistent rate limit headers on both successful (2xx) responses and rate-limited (429) responses, so clients can monitor quota without needing to trigger a 429.

---

## 4. Implementation Plan

### 1. Phases & Milestones

| Phase | Focus | Milestone |
|---|---|---|
| Phase 1 | Foundation: config, store abstraction, skeleton | Config module + store interface merged |
| Phase 2 | Core Logic: middleware + 429 responses | Rate limiting enforced end-to-end in development |
| Phase 3 | Integration: wire into app, add usage endpoint | Feature complete, running locally against real API |
| Phase 4 | Polish & Testing: tests, headers, logging, docs | All tests green, PR reviewed, ready to ship |

---

### 2. Task Breakdown

```
Phase 1 – Foundation
- [ ] Create src/config/rateLimitConfig.js with env-var reading, defaults, and startup validation
- [ ] Add RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS to .env.example with documentation comments
- [ ] Install express-rate-limit: npm install express-rate-limit
- [ ] Create src/store/rateLimitStore.js defining the store abstraction interface (get, increment, reset, getInfo)
- [ ] Implement InMemoryRateLimitStore backed by a plain Map

Phase 2 – Core Logic
- [ ] Create src/middleware/rateLimiter.js using express-rate-limit with custom keyGenerator reading req.apiKey
- [ ] Implement the handler for 429 responses (custom handler option in express-rate-limit) returning the required JSON body
- [ ] Implement header injection: X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset on all responses
- [ ] Handle the req.apiKey fallback case (missing key → IP fallback + error log)
- [ ] Add key-length guard in keyGenerator (truncate/hash keys > 256 chars)

Phase 3 – Integration
- [ ] Register rateLimiter middleware in src/app.js after the existing auth middleware
- [ ] Create src/routes/usage.js implementing GET /v1/usage with access to the shared store instance
- [ ] Mount /v1/usage route in src/app.js (behind existing auth middleware)
- [ ] Verify middleware ordering in app.js: auth → rateLimiter → routes → usage

Phase 4 – Polish & Testing
- [ ] Write unit tests for rateLimiter middleware (within-limit, at-limit, over-limit, window reset, multi-key isolation)
- [ ] Write unit tests for rateLimitConfig.js (valid config, missing env vars, invalid values)
- [ ] Write integration tests: 1001-request sequence, /v1/usage accuracy, 429 headers, Retry-After correctness
- [ ] Add structured logging (warn level) when a 429 is issued: { apiKey, path, count, resetAt }
- [ ] Update API documentation (README or OpenAPI spec) with rate limit headers and /v1/usage endpoint
- [ ] Manual smoke test against local server with a test API key using curl or Postman
- [ ] Code review and address feedback
```

---

### 3. Dependencies & Sequencing

```
Phase 1 must complete before Phase 2 (middleware depends on config + store).
Phase 2 must complete before Phase 3 (can't wire in a middleware that doesn't exist).
Phase 3 must complete before Phase 4 integration tests (tests hit the wired-up app).
Unit tests in Phase 4 can be written in parallel with Phase 3.
```

**External blockers**: None for v1 in-memory implementation. `express-rate-limit` is a public npm package with no approval process required.

**If Redis store is needed sooner**: Add `rate-limiter-flexible` or `ioredis` + `@express-rate-limit/redis` and a Redis instance (local Docker or managed). This is an optional parallel track, not on the critical path for v1.

---

### 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| In-memory store resets on deploy, causing burst traffic after each deployment | High | Low-Medium | Document expected behavior; monitor for abuse post-deploy. Migrate to Redis if this becomes a real problem. |
| Fixed-window boundary burst (2× requests at window edge) | Medium | Low | Acceptable for v1; document in API docs. Switch to sliding-window algorithm if abusive patterns are observed. |
| `express-rate-limit` API breaks between major versions | Low | Medium | Pin the version in package.json; review changelog before upgrading. |
| Incorrect middleware ordering exposes routes without rate limiting | Medium | High | Add an integration test that verifies rate limiting is active on multiple endpoint paths, not just one. |

---

### 5. Definition of Done

- [ ] All unit tests pass (`npm test`)
- [ ] All integration tests pass, including the 1,001-request sequence
- [ ] `GET /v1/usage` returns accurate `used`, `remaining`, and `resetAt` values
- [ ] Every API response (success and error) includes `X-RateLimit-*` headers
- [ ] 429 responses include `Retry-After` header and correct JSON body
- [ ] Startup fails with a clear error message if `RATE_LIMIT_MAX_REQUESTS` is set to an invalid value
- [ ] `.env.example` updated with new environment variables and descriptions
- [ ] API documentation updated to describe rate limiting behavior and the `/v1/usage` endpoint
- [ ] Code reviewed and approved by at least one other engineer
- [ ] Feature deployed to staging environment and smoke-tested manually
- [ ] No regression in existing endpoint behavior (existing tests still pass)

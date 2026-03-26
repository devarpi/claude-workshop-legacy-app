# Rate Limiting for REST API — Planning Documentation

**Feature:** Per-API-Key Rate Limiting
**Stack:** Node.js / Express
**Date:** 2026-03-26

---

## Table of Contents

1. [Requirements](#1-requirements)
2. [High-Level Design](#2-high-level-design)
3. [Low-Level Design](#3-low-level-design)
4. [Implementation Plan](#4-implementation-plan)

---

## 1. Requirements

### 1.1 Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | Each API key is limited to **1,000 requests per rolling 60-minute window**. |
| FR-02 | Requests that exceed the limit receive an HTTP **429 Too Many Requests** response immediately. |
| FR-03 | Every response (success or 429) includes rate-limit metadata headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. |
| FR-04 | A dedicated endpoint (`GET /rate-limit/status`) allows a client to query their current usage without consuming a quota slot. |
| FR-05 | The rate-limit counter resets on a **sliding (rolling) window** basis, not a fixed clock window, to prevent burst exploitation at window boundaries. |
| FR-06 | Unauthenticated requests are rejected with **401 Unauthorized** before rate-limit logic is applied. |
| FR-07 | Internal/admin API keys can be configured to bypass rate limiting entirely. |

### 1.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | Rate-limit checks must add **< 5 ms** of latency to each request (p99). |
| NFR-02 | The solution must survive an application restart without losing counters (persistent storage). |
| NFR-03 | The solution must be horizontally scalable — multiple app instances share the same counter state. |
| NFR-04 | Counter storage should tolerate brief unavailability gracefully (fail-open or configurable). |
| NFR-05 | All rate-limit events (throttled requests, near-limit warnings) must be logged for observability. |
| NFR-06 | Configuration (limit, window duration, bypass list) must be changeable without a code deploy. |

### 1.3 Out of Scope

- IP-address-based rate limiting (future work)
- Per-endpoint or per-method granularity (future work)
- Rate-limit overrides negotiated per customer tier (future work — see extension points)

---

## 2. High-Level Design

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Express Application                      │
│                                                             │
│  Incoming Request                                           │
│       │                                                     │
│       ▼                                                     │
│  ┌─────────────────┐                                        │
│  │  Auth Middleware │  (extracts & validates API key)       │
│  └────────┬────────┘                                        │
│           │ req.apiKey attached                             │
│           ▼                                                 │
│  ┌──────────────────────┐                                   │
│  │ Rate-Limit Middleware │◄──── Redis (shared counter store)│
│  └────────┬─────────────┘                                   │
│           │ 429 if exceeded, else pass-through              │
│           ▼                                                 │
│  ┌──────────────────┐                                       │
│  │  Route Handlers  │                                       │
│  └──────────────────┘                                       │
│                                                             │
│  GET /rate-limit/status  ──► Rate-Limit Service (read-only) │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Auth Middleware** | Validates the `Authorization: Bearer <api-key>` header, attaches `req.apiKey` and `req.apiKeyMeta` (including bypass flag) to the request object. |
| **Rate-Limit Middleware** | Reads the counter for `req.apiKey` from Redis, increments it atomically, decides pass/reject, and sets response headers. |
| **Redis (Counter Store)** | Persists sliding-window counters per API key. Uses sorted sets for accurate sliding-window semantics. |
| **Rate-Limit Service** | Encapsulates all Redis interactions; exposes `increment(apiKey)`, `getStatus(apiKey)`, and `reset(apiKey)` operations. |
| **Status Endpoint** | `GET /rate-limit/status` — calls `getStatus` (no increment) and returns usage JSON. |
| **Config Module** | Loads `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_BYPASS_KEYS` from environment / config file. |

### 2.3 Data Flow — Normal Request

1. Client sends `GET /api/resource` with `Authorization: Bearer <key>`.
2. Auth Middleware validates key → attaches `req.apiKey`.
3. Rate-Limit Middleware calls `RateLimitService.increment(apiKey)`.
4. Redis executes atomic Lua script (see §3.3): prunes old entries, adds current timestamp, returns count.
5. Middleware sets `X-RateLimit-*` headers.
6. If `count <= limit` → calls `next()`.
7. If `count > limit` → responds `429` with `Retry-After` header and JSON error body.

### 2.4 Data Flow — Status Check

1. Client sends `GET /rate-limit/status` with `Authorization: Bearer <key>`.
2. Auth Middleware validates key.
3. Rate-Limit Middleware is **skipped** for this route (registered before the middleware, or exempted by path check).
4. Status handler calls `RateLimitService.getStatus(apiKey)` (read-only, no increment).
5. Returns `{ limit, remaining, resetAt }` JSON.

---

## 3. Low-Level Design

### 3.1 Redis Data Structure

**Choice:** Sorted Set (ZSET) per API key, using request timestamps as both score and member.

```
Key pattern:  ratelimit:<apiKey>
Score:        Unix timestamp in milliseconds (integer)
Member:       Unique request ID (e.g., "<timestamp>:<random>")
TTL:          Set to window duration + small buffer (auto-cleanup)
```

**Why sorted sets over a simple counter?**
A sorted set enables true sliding-window semantics. We prune entries older than `now - windowMs` before counting, so the window truly slides rather than resetting on a clock boundary. This prevents burst exploitation at the top of each hour.

### 3.2 Key Naming

```
ratelimit:<sha256(apiKey)>
```

The API key is hashed before use as a Redis key to avoid leaking raw credentials in Redis memory dumps or logs.

### 3.3 Atomic Lua Script

All operations on a key are wrapped in a single Lua script executed atomically by Redis, eliminating race conditions across concurrent requests:

```lua
-- KEYS[1] = redis key
-- ARGV[1] = current timestamp (ms)
-- ARGV[2] = window size (ms)
-- ARGV[3] = max requests
-- ARGV[4] = unique member (timestamp:random)

local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local window   = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]
local cutoff   = now - window

-- 1. Remove entries outside the sliding window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- 2. Add the current request
redis.call('ZADD', key, now, member)

-- 3. Count entries in window
local count = redis.call('ZCARD', key)

-- 4. Set TTL so the key auto-expires
redis.call('PEXPIRE', key, window + 1000)

-- 5. Find the oldest entry's score (for Reset header)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetAt = 0
if #oldest > 0 then
  resetAt = tonumber(oldest[2]) + window
end

return {count, resetAt}
```

### 3.4 RateLimitService API

```typescript
interface RateLimitResult {
  count: number;       // requests used in current window
  limit: number;       // configured max
  remaining: number;   // limit - count (floor 0)
  resetAt: number;     // Unix ms when oldest request in window expires
  allowed: boolean;    // count <= limit
}

class RateLimitService {
  // Increment counter and return status. Called on every metered request.
  async increment(apiKey: string): Promise<RateLimitResult>;

  // Read current status without incrementing. Used by status endpoint.
  async getStatus(apiKey: string): Promise<RateLimitResult>;

  // Reset counter for a key (admin use).
  async reset(apiKey: string): Promise<void>;
}
```

### 3.5 Middleware Implementation Sketch

```typescript
// middleware/rateLimiter.ts
import { Request, Response, NextFunction } from 'express';
import { RateLimitService } from '../services/rateLimitService';
import { config } from '../config';

const rateLimitService = new RateLimitService();

export async function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const apiKey: string = req.apiKey; // set by auth middleware

  // Bypass for exempt keys (admin, internal)
  if (req.apiKeyMeta?.bypass) {
    return next();
  }

  let result;
  try {
    result = await rateLimitService.increment(apiKey);
  } catch (err) {
    // Fail-open: if Redis is unavailable, let the request through but log it
    logger.error('Rate limit store unavailable', { err, apiKey: mask(apiKey) });
    return next();
  }

  // Always set informational headers
  res.set({
    'X-RateLimit-Limit':     String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset':     String(Math.ceil(result.resetAt / 1000)), // seconds epoch
  });

  if (!result.allowed) {
    const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000);
    res.set('Retry-After', String(retryAfter));
    logger.warn('Rate limit exceeded', { apiKey: mask(apiKey), count: result.count });

    res.status(429).json({
      error: {
        code:    'RATE_LIMIT_EXCEEDED',
        message: 'You have exceeded the request rate limit. Please retry after the reset time.',
        limit:   result.limit,
        resetAt: new Date(result.resetAt).toISOString(),
      }
    });
    return;
  }

  next();
}
```

### 3.6 Status Endpoint

```typescript
// routes/rateLimitRoutes.ts
router.get(
  '/rate-limit/status',
  authMiddleware,          // auth required, but NOT rateLimitMiddleware
  async (req, res) => {
    const result = await rateLimitService.getStatus(req.apiKey);
    res.json({
      limit:     result.limit,
      used:      result.count,
      remaining: result.remaining,
      resetAt:   new Date(result.resetAt).toISOString(),
      windowMs:  config.rateLimitWindowMs,
    });
  }
);
```

### 3.7 Response Schemas

**Success response headers (on any 2xx):**
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset: 1774754400
```

**429 response body:**
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "You have exceeded the request rate limit. Please retry after the reset time.",
    "limit": 1000,
    "resetAt": "2026-03-26T15:00:00.000Z"
  }
}
```

**Status endpoint response (200):**
```json
{
  "limit": 1000,
  "used": 153,
  "remaining": 847,
  "resetAt": "2026-03-26T15:00:00.000Z",
  "windowMs": 3600000
}
```

### 3.8 Configuration

All values are read from environment variables (or a `.env` file via `dotenv`):

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_MAX` | `1000` | Max requests per window per API key |
| `RATE_LIMIT_WINDOW_MS` | `3600000` | Window size in milliseconds (default: 1 hour) |
| `RATE_LIMIT_BYPASS_KEYS` | `""` | Comma-separated list of API key hashes that bypass limiting |
| `RATE_LIMIT_FAIL_OPEN` | `true` | If `true`, allow requests when Redis is unavailable |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `REDIS_KEY_PREFIX` | `ratelimit:` | Prefix for all rate-limit keys in Redis |

### 3.9 Error Handling & Edge Cases

| Scenario | Behavior |
|----------|----------|
| Redis connection lost | Fail-open (allow request), log error at ERROR level |
| Redis slow (> 50 ms) | Circuit breaker trips after N failures; fail-open until recovery |
| API key not present | Auth middleware returns 401 before rate-limit logic runs |
| Clock skew between app instances | All timestamps are written in the same clock domain (app server clock); minor skew is acceptable within a 1-hour window |
| Two requests arrive simultaneously for same key | Lua script atomicity guarantees correct count — no race condition |
| `resetAt` in the past | Can occur if all entries just aged out; `remaining` will equal `limit` |

### 3.10 Observability

- **Structured logs** on every throttled request: `{ event: "rate_limit_exceeded", apiKeyHash, count, limit, resetAt }`
- **Metrics** (if Prometheus/StatsD is present):
  - `api_rate_limit_requests_total{status="allowed|throttled"}` — counter
  - `api_rate_limit_remaining{apiKey=...}` — gauge (sampled, not per-request)
  - `api_rate_limit_redis_duration_ms` — histogram of Redis call latency
- **Alerts:** Trigger if throttle rate across all keys exceeds 5% of total traffic for > 5 minutes.

---

## 4. Implementation Plan

### 4.1 Phases & Tasks

#### Phase 1 — Infrastructure Setup (Day 1–2)

| Task | Owner | Est. |
|------|-------|------|
| Provision Redis instance (or verify existing one is available) | DevOps | 2 h |
| Add `ioredis` (or `redis`) npm dependency | Backend Dev | 0.5 h |
| Create `RedisClient` singleton module with reconnect logic | Backend Dev | 2 h |
| Add environment variables to `.env.example` and deployment config | Backend Dev | 0.5 h |
| Write integration test scaffold (test Redis connectivity) | Backend Dev | 1 h |

#### Phase 2 — Core Rate-Limit Service (Day 2–3)

| Task | Owner | Est. |
|------|-------|------|
| Implement `RateLimitService.increment()` with Lua script | Backend Dev | 3 h |
| Implement `RateLimitService.getStatus()` (read-only ZCARD + ZRANGE) | Backend Dev | 1 h |
| Implement `RateLimitService.reset()` (ZDELETE, admin only) | Backend Dev | 0.5 h |
| Unit tests for `RateLimitService` (mock Redis) | Backend Dev | 2 h |
| Integration tests with real Redis (Docker in CI) | Backend Dev | 2 h |

#### Phase 3 — Middleware & Routing (Day 3–4)

| Task | Owner | Est. |
|------|-------|------|
| Implement `rateLimitMiddleware` with header setting and 429 response | Backend Dev | 2 h |
| Wire middleware into Express app after auth middleware | Backend Dev | 0.5 h |
| Implement `GET /rate-limit/status` endpoint | Backend Dev | 1 h |
| Add bypass logic for admin keys | Backend Dev | 1 h |
| Update API documentation / OpenAPI spec | Backend Dev | 1.5 h |

#### Phase 4 — Testing & Hardening (Day 4–5)

| Task | Owner | Est. |
|------|-------|------|
| End-to-end tests: normal flow, throttling, status endpoint | QA / Backend Dev | 3 h |
| Load test: verify < 5 ms added latency at 500 RPS | Backend Dev / QA | 2 h |
| Test Redis failure scenario (fail-open behavior) | Backend Dev | 1 h |
| Test simultaneous requests (race-condition stress test) | Backend Dev | 1 h |
| Security review: header injection, key leakage in logs | Security | 2 h |

#### Phase 5 — Observability & Rollout (Day 5–6)

| Task | Owner | Est. |
|------|-------|------|
| Add structured logging for throttled events | Backend Dev | 1 h |
| Add Prometheus metrics (if applicable) | Backend Dev | 1.5 h |
| Deploy to staging, run smoke tests | DevOps | 1 h |
| Monitor staging for 24 hours | On-call | 24 h |
| Deploy to production (feature-flag or direct) | DevOps | 1 h |
| Update runbook / ops documentation | Backend Dev | 1 h |

### 4.2 Milestone Summary

| Milestone | Target Day | Definition of Done |
|-----------|-----------|-------------------|
| Redis connected, config in place | Day 2 | App boots, connects to Redis, env vars documented |
| Rate-limit service passing all unit + integration tests | Day 3 | 100% of service tests green |
| Middleware live on staging | Day 4 | All routes return `X-RateLimit-*` headers; 429 returned on excess |
| Status endpoint live on staging | Day 4 | `GET /rate-limit/status` returns correct JSON |
| Production rollout complete | Day 6 | No regression in error rate; throttle events visible in logs |

### 4.3 Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Redis not provisioned / access blocked | Medium | High | Confirm with DevOps on Day 1; use Docker locally for dev/CI |
| Existing clients break due to unexpected 429s | Low | High | Announce change to API consumers; start with a higher temporary limit and ramp down |
| Lua script incompatibility with Redis cluster mode | Low | Medium | Test against cluster in staging; consider `EVAL` to `EVALSHA` for efficiency |
| Clock skew causes inconsistent window behavior | Low | Low | Use server-side timestamps only; document acceptable skew tolerance |
| Performance regression from Redis roundtrip | Low | Medium | Benchmark in Phase 4; use connection pooling and pipelining if needed |

### 4.4 Rollback Plan

1. If issues are detected post-deployment, set `RATE_LIMIT_FAIL_OPEN=true` to immediately disable enforcement while keeping the middleware in place (counters still tracked, no requests blocked).
2. If a deeper rollback is needed, remove the `rateLimitMiddleware` registration from the Express app and redeploy — no database migrations to revert.
3. Redis keys will expire naturally (within 1 hour) after rollback; no manual cleanup needed.

### 4.5 Future Enhancements (Out of Scope for v1)

- Per-endpoint rate limits (e.g., tighter limits on expensive endpoints)
- Tiered limits per customer plan (free vs. paid)
- IP-based rate limiting as a secondary layer
- Dynamic limit adjustment via admin API without restart
- Rate-limit analytics dashboard

---

*Document prepared: 2026-03-26 | Author: Engineering Planning*

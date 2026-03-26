# Analytics Dashboard: Export to CSV Feature — Planning Document

**Date:** 2026-03-26
**Status:** Draft

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
| FR-01 | Users must be able to select a date range (start date and end date) for the export. |
| FR-02 | Users must be able to select one or more metrics (columns) to include in the export. |
| FR-03 | The system must produce a valid CSV file containing the selected metrics for the specified date range. |
| FR-04 | For small exports (estimated < 10,000 rows), the download should be available immediately (synchronous). |
| FR-05 | For large exports (estimated >= 10,000 rows), the system must process the export asynchronously and notify the user via email with a download link when the file is ready. |
| FR-06 | The download link sent via email must be time-limited (expires after 48 hours). |
| FR-07 | Users must be able to view the status of pending and completed export jobs from a dedicated "My Exports" panel. |
| FR-08 | Users must be able to cancel a pending export job. |
| FR-09 | The CSV must include a header row with human-readable column names. |
| FR-10 | The system must support exporting at least 10 million rows in a single job. |
| FR-11 | Users should receive an in-app notification (toast / notification bell) in addition to the email when an async export completes. |

### 1.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | **Performance:** A 10-million-row export must complete within 30 minutes. |
| NFR-02 | **Scalability:** The export pipeline must handle at least 50 concurrent large export jobs without degrading dashboard responsiveness. |
| NFR-03 | **Reliability:** Export jobs must survive application restarts; interrupted jobs must be retried automatically (up to 3 attempts). |
| NFR-04 | **Security:** Generated CSV files must be stored in private, access-controlled blob storage. Pre-signed download URLs must be scoped per-user and expire after 48 hours. |
| NFR-05 | **Observability:** All export job state transitions must be logged and metrics emitted (job count, row count, duration, failure rate). |
| NFR-06 | **Data Integrity:** The exported CSV must accurately reflect the data at the time the job was submitted (snapshot semantics where feasible). |
| NFR-07 | **Compliance:** Exported files containing PII must be governed by the organization's data retention policy and purged from storage after 7 days. |
| NFR-08 | **Accessibility:** The export UI must meet WCAG 2.1 AA standards. |

### 1.3 Out of Scope (v1)

- Export formats other than CSV (e.g., Excel, PDF, Parquet).
- Scheduled / recurring exports.
- Sharing export links with other users.
- Real-time progress percentage (job status shows "In Progress" / "Complete" / "Failed" only in v1).

---

## 2. High-Level Design

### 2.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   Analytics Dashboard (Browser)          │
│  ┌──────────────┐   ┌─────────────────────────────────┐ │
│  │  Export Modal │   │  My Exports Panel (job list)    │ │
│  └──────┬───────┘   └──────────────┬──────────────────┘ │
└─────────┼────────────────────────── ┼───────────────────┘
          │  REST API                  │  WebSocket / SSE
          ▼                            ▼
┌──────────────────────────────────────────────────────────┐
│                     API Gateway / BFF                     │
│  POST /exports          GET /exports/:id                  │
│  DELETE /exports/:id    GET /exports (list)               │
└────────────────────────────┬─────────────────────────────┘
                             │
          ┌──────────────────┼───────────────────────┐
          ▼                  ▼                        ▼
┌──────────────────┐ ┌──────────────┐      ┌──────────────────┐
│  Export Service  │ │  Job Queue   │      │  Notification    │
│  (orchestrator)  │ │  (e.g. SQS / │      │  Service         │
│                  │ │  RabbitMQ)   │      │  (email + in-app)│
└────────┬─────────┘ └──────┬───────┘      └──────────────────┘
         │                  │
         ▼                  ▼
┌──────────────────────────────────────────────┐
│           Export Worker (async processor)     │
│  - Stream rows from Data Warehouse            │
│  - Write CSV in chunks to blob storage        │
│  - Update job status in Job Store             │
└──────────┬───────────────────────────────────┘
           │
     ┌─────┴──────┐
     ▼            ▼
┌─────────┐  ┌───────────────┐
│  Data   │  │  Blob Storage │
│Warehouse│  │ (S3 / GCS)    │
└─────────┘  └───────────────┘
```

### 2.2 Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **Export Modal (UI)** | Collects date range, metric selection, and submits export request. Shows immediate download for small exports or status message for large ones. |
| **My Exports Panel (UI)** | Lists all jobs for the current user with status, created time, and download links for completed jobs. |
| **API Gateway / BFF** | Authenticates requests, validates input, routes to Export Service, returns job IDs or direct CSV streams. |
| **Export Service** | Creates job records, estimates row count, decides sync vs. async path, enqueues async jobs. |
| **Job Queue** | Durable message queue that holds pending export jobs and drives at-least-once delivery to workers. |
| **Export Worker** | Pulls jobs from the queue, streams data from the Data Warehouse in batches, writes CSV to blob storage, updates job status. |
| **Job Store (DB)** | Persistent store (e.g., PostgreSQL) recording job metadata: user, parameters, status, storage key, timestamps. |
| **Blob Storage** | Stores generated CSV files. Generates pre-signed, time-limited download URLs. |
| **Notification Service** | Sends email and in-app notifications when a job completes or fails. |

### 2.3 Sync vs. Async Decision

```
User submits export
        │
        ▼
  Estimate row count
  (cheap COUNT query)
        │
  ┌─────┴────────┐
  │              │
< 10k rows    >= 10k rows
  │              │
  ▼              ▼
Stream CSV    Enqueue job
directly      Return job ID
to browser    + "email coming" message
```

### 2.4 Key Data Flows

**Async Export — Happy Path**

1. User selects date range and metrics, clicks "Export".
2. Frontend calls `POST /exports` with parameters.
3. Export Service estimates row count (fast COUNT query).
4. Export Service creates a job record (status: `PENDING`) and enqueues a message.
5. API returns `{ jobId, status: "PENDING" }` immediately; UI shows toast "Your export is being prepared. We'll email you when it's ready."
6. Export Worker picks up the job, streams rows in 50k-row batches from the Data Warehouse, appends each batch to an in-progress CSV in blob storage.
7. On completion, Worker updates job to `COMPLETED`, generates a pre-signed URL (48h TTL), saves URL to Job Store.
8. Notification Service sends email with link and pushes an in-app notification.
9. User can also visit "My Exports" panel to see the link.

---

## 3. Low-Level Design

### 3.1 API Contract

#### `POST /api/v1/exports`

**Request**
```json
{
  "dateRange": {
    "startDate": "2025-01-01",
    "endDate":   "2025-03-31"
  },
  "metrics": ["pageViews", "sessions", "bounceRate", "revenue"],
  "timezone": "America/New_York",
  "format": "csv"
}
```

**Response — Small Export (sync)**
```
HTTP 200 OK
Content-Type: text/csv
Content-Disposition: attachment; filename="export_2025-01-01_2025-03-31.csv"
<CSV body streamed>
```

**Response — Large Export (async)**
```json
HTTP 202 Accepted
{
  "jobId": "exp_01HXYZ123",
  "status": "PENDING",
  "estimatedRows": 4200000,
  "message": "Your export is being prepared. You will receive an email at user@example.com when it's ready."
}
```

#### `GET /api/v1/exports`

Returns the user's export job history (last 30 days, max 100 records).

```json
HTTP 200 OK
{
  "exports": [
    {
      "jobId": "exp_01HXYZ123",
      "status": "COMPLETED",
      "createdAt": "2026-03-26T10:00:00Z",
      "completedAt": "2026-03-26T10:12:33Z",
      "rowCount": 4200000,
      "downloadUrl": "https://storage.example.com/exports/...?token=...&expires=...",
      "expiresAt": "2026-03-28T10:12:33Z",
      "parameters": {
        "dateRange": { "startDate": "2025-01-01", "endDate": "2025-03-31" },
        "metrics": ["pageViews", "sessions", "bounceRate", "revenue"]
      }
    }
  ]
}
```

**Job Status Enum:** `PENDING` | `IN_PROGRESS` | `COMPLETED` | `FAILED` | `CANCELLED`

#### `DELETE /api/v1/exports/:jobId`

Cancels a `PENDING` job. Returns `204 No Content` on success.

### 3.2 Database Schema

```sql
-- Job Store table
CREATE TABLE export_jobs (
    id              VARCHAR(26) PRIMARY KEY,      -- ULID
    user_id         UUID        NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    parameters      JSONB       NOT NULL,          -- date range, metrics, timezone
    estimated_rows  BIGINT,
    actual_rows     BIGINT,
    storage_key     TEXT,                          -- blob storage object key
    download_url    TEXT,                          -- pre-signed URL (cached)
    url_expires_at  TIMESTAMPTZ,
    error_message   TEXT,
    attempt_count   INT         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    purge_after     TIMESTAMPTZ                    -- data retention deadline
);

CREATE INDEX idx_export_jobs_user_status ON export_jobs(user_id, status, created_at DESC);
CREATE INDEX idx_export_jobs_status      ON export_jobs(status) WHERE status IN ('PENDING','IN_PROGRESS');
```

### 3.3 Export Worker — Processing Algorithm

```
function processExportJob(job):
    updateJobStatus(job.id, IN_PROGRESS)

    blobWriter = openMultipartUpload(storageKey(job))
    csvWriter  = newCSVWriter(blobWriter)
    csvWriter.writeHeader(resolveColumnNames(job.parameters.metrics))

    cursor = null
    totalRows = 0
    BATCH_SIZE = 50_000

    loop:
        batch = dataWarehouse.streamRows(
            metrics    = job.parameters.metrics,
            startDate  = job.parameters.dateRange.startDate,
            endDate    = job.parameters.dateRange.endDate,
            timezone   = job.parameters.timezone,
            afterCursor = cursor,
            limit      = BATCH_SIZE
        )

        if batch is empty: break

        csvWriter.writeRows(batch.rows)
        totalRows += len(batch.rows)
        cursor = batch.nextCursor

        checkForCancellation(job.id)   // abort early if cancelled

    csvWriter.flush()
    blobWriter.completeMultipartUpload()

    downloadUrl = generatePresignedUrl(storageKey(job), ttl=48h)
    updateJobStatus(job.id, COMPLETED,
        actualRows=totalRows,
        downloadUrl=downloadUrl,
        urlExpiresAt=now()+48h,
        purgeAfter=now()+7d)

    notificationService.notify(job.userId, downloadUrl)
```

**Error Handling:**
- Transient errors (network, DB timeout): retry up to 3 times with exponential backoff (1s, 4s, 16s).
- After 3 failures: mark job `FAILED`, send failure notification email.
- Cancellation detected mid-stream: delete partial blob, mark job `CANCELLED`.

### 3.4 Memory-Efficient Streaming

- The worker never loads the full result set into memory.
- Data Warehouse rows are fetched via server-side cursor in 50k-row batches.
- Each batch is serialized to CSV and written directly to the blob storage multipart upload buffer (max 5 MB per part for S3 compatibility).
- Peak memory per worker process: approximately 50k rows * ~1 KB/row average = ~50 MB.

### 3.5 Frontend Components

**ExportModal**
```
Props: { availableMetrics: MetricDefinition[], onClose: () => void }

State:
  - dateRange: { startDate: Date | null, endDate: Date | null }
  - selectedMetrics: string[]         // at least 1 required
  - isSubmitting: boolean
  - validationErrors: Record<string, string>

Behavior:
  - Validate: startDate <= endDate, not more than 3 years apart, at least 1 metric selected.
  - On submit: call POST /api/v1/exports.
  - If 200 (sync): trigger browser file download from response blob.
  - If 202 (async): close modal, show persistent toast "Export in progress".
```

**MyExportsPanel**
```
Behavior:
  - Poll GET /api/v1/exports every 15 seconds while any job is IN_PROGRESS.
  - Display table: Job ID (truncated) | Date Range | Metrics | Status | Created | Download.
  - "Download" column: shows link (with expiry countdown) for COMPLETED jobs, spinner for IN_PROGRESS, "Retry" for FAILED, "–" for CANCELLED.
  - Cancel button shown for PENDING jobs.
```

### 3.6 Security Controls

| Control | Implementation |
|---------|----------------|
| Authentication | All `/exports` endpoints require a valid session JWT (same as rest of dashboard). |
| Authorization | Job queries always filter by `user_id` extracted from JWT — users can only see/cancel their own jobs. |
| Pre-signed URL scoping | URLs are generated per job, per user. They do not expose the raw storage path. |
| URL expiry | 48-hour TTL on pre-signed URLs; after expiry, the file is inaccessible even if the link is shared. |
| File purge | A nightly cleanup job deletes blobs and clears `storage_key` / `download_url` for jobs where `purge_after < NOW()`. |
| Input validation | Date range max span: 3 years. Metrics list: validated against a server-side allowlist. |
| Rate limiting | Max 5 concurrent `IN_PROGRESS` or `PENDING` jobs per user. Returns `429` if exceeded. |

### 3.7 Observability

**Metrics to emit (e.g., via Prometheus/StatsD):**
- `export_jobs_created_total{type=sync|async}`
- `export_jobs_completed_total{type=sync|async}`
- `export_jobs_failed_total`
- `export_job_duration_seconds{type=sync|async}` (histogram)
- `export_job_row_count` (histogram)
- `export_worker_queue_depth`

**Structured log fields for every job event:**
`jobId`, `userId`, `status`, `attemptCount`, `rowCount`, `durationMs`, `errorMessage`

**Alerts:**
- Job failure rate > 5% over 10 minutes → PagerDuty.
- Queue depth > 100 jobs for > 5 minutes → Slack warning.
- Worker count drops to 0 → PagerDuty immediately.

---

## 4. Implementation Plan

### 4.1 Milestones Overview

| Milestone | Scope | Estimated Duration |
|-----------|-------|--------------------|
| M1 — Foundation | Database schema, Job Store service, basic API endpoints (create / list / cancel) | 1 week |
| M2 — Sync Export | Small-export sync path, data warehouse query layer, CSV serialization | 1 week |
| M3 — Async Pipeline | Job queue integration, Export Worker, blob storage, retry logic | 2 weeks |
| M4 — Notifications | Email + in-app notification integration, pre-signed URL generation | 1 week |
| M5 — Frontend | Export Modal, My Exports Panel, polling, toast notifications | 1.5 weeks |
| M6 — Hardening | Load testing, security review, observability, documentation | 1 week |
| **Total** | | **~7.5 weeks** |

---

### 4.2 Milestone 1 — Foundation (Week 1)

**Goal:** Establish the data layer and API skeleton that all subsequent milestones depend on.

**Tasks:**

1. **DB Migration**
   - Write and review the `export_jobs` migration (schema from §3.2).
   - Add indexes.
   - Set up migration in CI.

2. **Job Store Service**
   - Implement `createJob(userId, parameters, estimatedRows)` → returns job record.
   - Implement `updateJobStatus(jobId, status, ...fields)`.
   - Implement `getJobsByUser(userId, limit, offset)`.
   - Implement `cancelJob(jobId, userId)` — sets status to `CANCELLED` only if `PENDING`.
   - Unit tests for all methods with an in-memory or test-DB fixture.

3. **API Endpoints (stubs)**
   - `POST /api/v1/exports` — validates request body, calls Job Store `createJob`, returns `202` with job ID (worker integration deferred to M3).
   - `GET /api/v1/exports` — returns job list for authenticated user.
   - `DELETE /api/v1/exports/:jobId` — calls `cancelJob`.
   - Input validation middleware (date range, metrics allowlist, rate limit check).

4. **Row Count Estimation Utility**
   - Implement `estimateRowCount(parameters)` using a cheap COUNT query against the Data Warehouse.
   - Determine the sync/async threshold (default: 10,000 rows).

**Acceptance Criteria:**
- All three API endpoints respond correctly with valid and invalid inputs.
- Jobs are persisted and retrievable from the database.
- Unit test coverage > 80% for new server-side code.

---

### 4.3 Milestone 2 — Sync Export (Week 2)

**Goal:** End-to-end working export for small datasets, delivered as a direct browser download.

**Tasks:**

1. **Data Warehouse Query Layer**
   - Implement `streamRows(metrics, startDate, endDate, timezone, afterCursor, limit)`.
   - Uses a server-side cursor or keyset pagination to avoid full table scans.
   - Returns `{ rows: Row[], nextCursor: string | null }`.
   - Handles metric-to-column mapping (metrics names → DB column names).

2. **CSV Serializer**
   - Implement a streaming CSV serializer: `writeHeader(columns)`, `writeRows(rows)`.
   - Handles escaping (quotes, commas, newlines in values).
   - Streams output to a `WritableStream` / `Buffer` for flexible use in sync and async paths.

3. **Sync Export Path in API**
   - In `POST /api/v1/exports`, if `estimatedRows < threshold`:
     - Stream rows directly from Data Warehouse through CSV serializer to HTTP response.
     - Set `Content-Type: text/csv` and `Content-Disposition` headers.
     - Do NOT create a job record (or create one in `COMPLETED` state for audit trail — decision to be made with team).

4. **Integration Test**
   - Seed test data covering a known date range.
   - Call `POST /api/v1/exports` with that range.
   - Assert CSV response: correct headers, correct row count, correct values, proper escaping.

**Acceptance Criteria:**
- Sync export returns a valid, downloadable CSV with correct data.
- Response time < 5 seconds for a 5,000-row export.
- Edge cases handled: empty result set (header-only CSV + `204` or `200`), special characters in values.

---

### 4.4 Milestone 3 — Async Pipeline (Weeks 3–4)

**Goal:** Large exports processed reliably in the background, stored in blob storage, with retry logic.

**Tasks:**

1. **Job Queue Integration**
   - Choose queue technology (SQS recommended for AWS deployments; RabbitMQ for on-prem).
   - Implement `enqueueExportJob(jobId)`.
   - Configure dead-letter queue (DLQ) for jobs exceeding 3 delivery attempts.
   - Update `POST /api/v1/exports` async path to enqueue after creating job record.

2. **Blob Storage Client**
   - Implement `openMultipartUpload(key)` → upload session.
   - Implement `appendPart(session, buffer)`.
   - Implement `completeMultipartUpload(session)` → final object key.
   - Implement `generatePresignedUrl(key, ttlSeconds)` → URL.
   - Implement `deleteObject(key)`.
   - Abstract behind an interface for testability (swap S3 for local filesystem in tests).

3. **Export Worker Service**
   - Implement worker main loop: poll queue, process job (algorithm from §3.3), ack or nack.
   - Implement cancellation check: before each batch, query job status; if `CANCELLED`, abort.
   - Implement retry logic: catch transient errors, increment `attempt_count`, re-enqueue with delay.
   - After 3 failures: mark `FAILED`, send to DLQ, trigger failure notification (stub for M4).
   - Worker is stateless and horizontally scalable (multiple instances can run concurrently).

4. **Worker Deployment**
   - Dockerize worker (can share base image with main API service).
   - Add to docker-compose for local development.
   - Add Kubernetes Deployment manifest (or ECS task definition) for production.
   - Configure autoscaling based on queue depth.

5. **Integration Tests**
   - Test happy path: job created → worker picks it up → blob stored → status `COMPLETED` → pre-signed URL populated.
   - Test retry: worker fails twice (mocked), succeeds on third attempt.
   - Test cancellation: cancel a `PENDING` job before worker picks it up; verify blob is not created.
   - Test failure: mock 3 consecutive failures; verify job is `FAILED` and in DLQ.

**Acceptance Criteria:**
- 1-million-row export completes successfully end-to-end in a staging environment.
- Worker recovers from transient errors via retry.
- Cancelled jobs do not produce blobs.
- Failed jobs are visible in DLQ for operator investigation.

---

### 4.5 Milestone 4 — Notifications (Week 5)

**Goal:** Users are proactively informed when their export is ready or has failed.

**Tasks:**

1. **Email Notification**
   - Design HTML email template: "Your export is ready" with prominent download button, expiry date, and list of metrics exported.
   - Design "Export failed" email template with retry instructions.
   - Integrate with existing email provider (e.g., SendGrid, SES).
   - Implement `sendExportReadyEmail(userId, downloadUrl, expiresAt, parameters)`.
   - Implement `sendExportFailedEmail(userId, parameters)`.

2. **In-App Notification**
   - Use existing notification infrastructure (or create a lightweight one).
   - On job `COMPLETED` or `FAILED`: insert a notification record for the user.
   - Frontend notification bell picks up the new record via existing polling or WebSocket channel.
   - Notification message: "Your CSV export is ready — [Download](#)" or "Your CSV export failed — [Try Again](#)".

3. **Notification Service Integration with Worker**
   - Replace notification stubs from M3 with real calls.
   - Ensure notifications are sent exactly once (idempotency check: only send if not already notified).

4. **Tests**
   - Unit test email template rendering.
   - Integration test: mock email provider, verify email is sent with correct URL on job completion.
   - Verify no duplicate notifications on worker retry.

**Acceptance Criteria:**
- User receives email within 60 seconds of job completion.
- Email contains a working download link that expires correctly.
- In-app notification appears without requiring a page refresh.
- No duplicate notifications for retried jobs.

---

### 4.6 Milestone 5 — Frontend (Weeks 5.5–7)

**Goal:** Polished, accessible UI for initiating exports and tracking job status.

**Tasks:**

1. **Export Modal Component**
   - Date range picker (reuse existing dashboard date picker if available).
   - Metric multi-select (checkboxes with "Select All / Clear All").
   - Client-side validation with inline error messages.
   - Submit button with loading state.
   - Handle sync response: trigger `<a download>` from blob.
   - Handle `202` async response: close modal, show toast.
   - Accessibility: proper `aria-label`, keyboard navigation, focus management.

2. **"Export CSV" Button in Dashboard**
   - Add button to the dashboard toolbar (visible to all authorized users).
   - On click: open Export Modal.
   - Button state: disabled while a `PENDING` / `IN_PROGRESS` job exists for the current user (optional — prevents duplicate submissions; confirm with PM).

3. **My Exports Panel**
   - Add "My Exports" entry to user menu or dashboard sidebar.
   - Table with columns: Status (pill badge), Date Range, Metrics (truncated list), Rows, Created, Download / Action.
   - Poll `GET /api/v1/exports` every 15 seconds while any job is `IN_PROGRESS`.
   - Stop polling when all visible jobs are in a terminal state.
   - "Download" link: opens pre-signed URL in new tab.
   - "Cancel" button: calls `DELETE /api/v1/exports/:jobId`, refreshes list.
   - Expiry countdown on download links (e.g., "Expires in 23h 45m").
   - Empty state: "You have no exports yet."
   - Error state: graceful message if API call fails.

4. **Toast / Notification Integration**
   - On async export submission: "Your export is being prepared. We'll email you when it's ready."
   - On in-app notification receipt (job complete): "Your CSV export is ready. [Download](#)" with clickable link.
   - On in-app notification receipt (job failed): "Your CSV export failed. [Try Again](#)" opens Export Modal pre-filled with previous parameters.

5. **Frontend Tests**
   - Unit tests for Export Modal: validation logic, sync and async response handling.
   - Unit tests for My Exports Panel: polling behavior, status rendering, cancel action.
   - Integration / E2E test (Cypress or Playwright):
     - Submit a small export → file downloads.
     - Submit a large export (mocked as async) → toast appears, My Exports Panel shows job.

**Acceptance Criteria:**
- Export Modal is keyboard-navigable and passes aXe accessibility audit.
- Sync download works in Chrome, Firefox, and Safari.
- My Exports Panel correctly reflects real-time job status transitions.
- All frontend unit tests pass; E2E happy path passes in CI.

---

### 4.7 Milestone 6 — Hardening (Week 7.5)

**Goal:** Production-ready: load tested, security reviewed, monitored, and documented.

**Tasks:**

1. **Load Testing**
   - Simulate 50 concurrent large export jobs using k6 or Locust.
   - Assert: dashboard API response times unaffected (< 200ms p99) during peak export load.
   - Assert: all 50 jobs complete within 30 minutes.
   - Identify and resolve any bottlenecks (DB connection pool, worker concurrency, blob throughput).

2. **Security Review**
   - Review all API endpoints for broken object-level authorization (BOLA).
   - Verify pre-signed URL cannot be accessed by a different authenticated user.
   - Verify rate limiting (max 5 concurrent jobs per user) cannot be bypassed.
   - Scan dependencies for known CVEs.
   - Confirm PII purge logic runs correctly on a test dataset.

3. **Observability Setup**
   - Wire all metrics from §3.7 to Prometheus / Grafana dashboard.
   - Create Grafana dashboard: export throughput, queue depth, worker count, error rate.
   - Configure PagerDuty and Slack alerts from §3.7.
   - Verify structured logs appear in the centralized log aggregation system.

4. **Documentation**
   - API reference (OpenAPI / Swagger spec for `/exports` endpoints).
   - Runbook: how to investigate a stuck job, how to manually retry a failed job, how to drain the queue for a maintenance window.
   - Architecture decision records (ADRs) for: sync/async threshold value, queue technology choice, blob storage provider.

5. **Feature Flag / Rollout**
   - Gate the Export CSV button behind a feature flag.
   - Roll out to 5% of users → monitor for errors → 25% → 100% over 2 weeks.

**Acceptance Criteria:**
- Load test passes all performance assertions.
- Security review findings resolved or formally accepted with mitigation plan.
- Grafana dashboard live in production.
- Feature flag in place; rollout plan approved by PM.

---

## Appendix A — Open Questions

| # | Question | Owner | Target Resolution |
|---|----------|-------|-------------------|
| 1 | Should small sync exports also create a job record for audit trail purposes? | Backend Lead + PM | M1 planning |
| 2 | What is the exact list of exportable metrics, and are any metrics restricted by user role? | PM + Data Team | Before M2 |
| 3 | What email provider is in use, and is there an existing internal email service abstraction? | Platform Team | Before M4 |
| 4 | Is there an existing in-app notification infrastructure to hook into, or does M4 need to build one? | Frontend Lead | Before M4 |
| 5 | Should we support filtering beyond date range (e.g., by segment or campaign) in v1? | PM | Before M2 |
| 6 | What is the preferred job queue technology given current infrastructure (SQS, RabbitMQ, etc.)? | Infrastructure Team | Before M3 |
| 7 | Are there compliance requirements beyond the 7-day purge assumption (e.g., GDPR right to deletion)? | Legal / Compliance | Before M6 |

---

## Appendix B — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Data Warehouse query performance degrades under concurrent export load | Medium | High | Dedicate a read replica for export queries; implement job concurrency limit. |
| Blob storage costs exceed budget for large / frequent exports | Medium | Medium | Set per-user monthly export volume limit; purge files after 7 days. |
| Pre-signed URL is accidentally shared externally | Low | High | Short 48h TTL; log all URL generations; add optional IP binding for high-security tenants. |
| Worker crashes mid-export leaving orphaned blobs | Low | Medium | Nightly cleanup job removes blobs for jobs not in `COMPLETED` state after 24h. |
| Email delivery failures cause users to miss their download | Medium | Medium | In-app notification as fallback; download link also accessible in My Exports Panel. |
| Feature scope creep (Excel, scheduling, sharing) delays launch | High | Medium | Strict v1 scope gate; log all requests to the backlog; communicate roadmap to stakeholders. |

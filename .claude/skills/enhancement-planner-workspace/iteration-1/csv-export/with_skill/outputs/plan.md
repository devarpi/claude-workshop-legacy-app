# Enhancement Plan: Export to CSV for Analytics Dashboard

---

## 1. HLD — High-Level Design

### 1. Overview

This enhancement adds a CSV export capability to the analytics dashboard, allowing users to download their analytics data as a structured CSV file. Users can specify a date range and select which metrics to include in the export. Because exports can span millions of rows, the system processes large exports asynchronously: the export job is queued in the background, and when complete, the user receives an email containing a secure download link. Smaller exports (below a configurable row threshold) may be served synchronously for a snappier experience.

The motivation is clear and long-standing: users have been requesting this feature for months. Analytics data currently lives inside the dashboard with no way to extract it for use in spreadsheets, BI tools, or custom reporting pipelines. Providing CSV export gives users full ownership of their data and dramatically increases the dashboard's utility for power users and data analysts.

---

### 2. Goals & Non-Goals

**Goals:**
- Allow users to initiate a CSV export from the analytics dashboard UI
- Let users specify a date range (start date, end date) for the export
- Let users choose which metrics/columns to include in the export
- Handle exports with millions of rows without timing out or degrading the application
- Process large exports asynchronously in a background job queue
- Send the user an email with a secure, time-limited download link when the export is ready
- Provide a status page or indicator so users can track export progress
- Deliver small exports (below threshold) synchronously with a direct file download

**Non-Goals:**
- Exporting data in formats other than CSV (e.g., Excel .xlsx, JSON, Parquet) — can be added later
- Real-time streaming of partial results during processing
- Scheduled/recurring exports (e.g., "email me this every Monday") — future enhancement
- Export of raw event-level data beyond what the analytics dashboard already surfaces
- Building a general-purpose data pipeline or ETL system
- Self-service schema customization beyond metric column selection

---

### 3. Architecture Overview

The export feature introduces several new components that interact with the existing analytics system:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Analytics Dashboard (Frontend)              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Export Modal                                           │   │
│  │  - Date range picker                                    │   │
│  │  - Metric selector (checkboxes)                         │   │
│  │  - "Request Export" button                              │   │
│  │  - Export status list (polling or websocket)            │   │
│  └─────────────────────┬───────────────────────────────────┘   │
└────────────────────────│────────────────────────────────────────┘
                         │ POST /api/exports
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│                   Export API Service (Backend)                   │
│  - Validates request (auth, params, quota)                       │
│  - Estimates row count                                           │
│  - If small: executes synchronously → streams CSV response       │
│  - If large: enqueues job → returns export_id + status           │
└────────────┬───────────────────────────┬─────────────────────────┘
             │ Enqueue                   │ Read status
             ▼                           ▼
┌────────────────────────┐   ┌───────────────────────────┐
│   Job Queue            │   │   Export Status Store     │
│   (e.g., Redis/SQS/    │   │   (DB table or Redis)     │
│    Celery/BullMQ)      │   │   - export_id             │
└──────────┬─────────────┘   │   - status (queued/       │
           │                 │     processing/done/failed)│
           ▼                 │   - created_at, updated_at │
┌────────────────────────┐   │   - download_url           │
│   Export Worker        │   │   - expires_at             │
│   - Queries analytics  │   └───────────────────────────┘
│     data in batches    │
│   - Writes CSV to      │
│     object storage     │
│   - Updates status     │
│   - Triggers email     │
└────────────┬───────────┘
             │ Upload file
             ▼
┌────────────────────────┐   ┌───────────────────────────┐
│   Object Storage       │   │   Email Service           │
│   (S3/GCS/Azure Blob)  │   │   (SendGrid/SES/etc.)     │
│   - Stores CSV files   │   │   - Sends download link   │
│   - Pre-signed URLs    │   │     email to user         │
│   - Lifecycle policies │   └───────────────────────────┘
└────────────────────────┘
```

**New components:**
- Export API endpoint (`POST /api/exports`, `GET /api/exports/:id`)
- Export Job (background worker)
- Export Status store (new DB table)
- CSV generation logic (batched query + streaming writer)
- Email notification on completion

**Modified components:**
- Analytics dashboard frontend (new Export modal + status list)
- Existing analytics data query layer (must support batched/paginated reads)

---

### 4. Key Design Decisions

**Async processing with a job queue**
Large exports cannot be served synchronously — queries spanning millions of rows may take minutes to complete and would time out HTTP connections. A job queue decouples the export request from execution, allowing the user to close the browser and still receive their data.

*Trade-off:* Adds operational complexity (queue infrastructure, worker deployment). Accepted because reliability and correctness outweigh simplicity here.

**Hybrid sync/async based on row count estimate**
Before enqueueing, the API estimates the expected row count. Below a configurable threshold (e.g., 50,000 rows), the export is served synchronously as a streaming download, giving a better UX for common small exports.

*Trade-off:* Two code paths to maintain. Mitigated by sharing the same CSV generation logic.

**Object storage for file delivery**
CSV files are written to object storage (e.g., S3) and delivered via pre-signed URLs rather than being served from the application tier. This keeps the application stateless, handles arbitrarily large files, and allows native lifecycle policies to expire old exports automatically.

**Batched data reads**
The worker queries analytics data in configurable batch sizes (e.g., 10,000 rows per query) to avoid loading millions of rows into memory at once. Each batch is written directly to the CSV stream.

**Email delivery for large exports**
Rather than requiring users to stay on the page, an email with the download link is sent on completion. A dashboard status page is also provided for users who prefer to poll.

**Pre-signed URL expiry**
Download links expire after a configurable window (e.g., 48 hours) to limit data exposure and reduce storage costs.

---

### 5. Dependencies & Integrations

| Dependency | Purpose | Notes |
|---|---|---|
| Job Queue (Redis + BullMQ, Celery, SQS, etc.) | Async job processing | Must match existing infra; assume Redis-backed queue if not already present |
| Object Storage (S3 / GCS / Azure Blob) | Store completed CSV files | Pre-signed URL generation required |
| Email Service (SendGrid / SES / Postmark) | Deliver completion notifications | Requires transactional email template |
| Existing analytics data store | Source of exported data | Must support paginated / cursor-based reads |
| Auth system | Validate user identity and export ownership | Export jobs must be scoped to requesting user |
| Frontend date range picker component | UI for selecting export range | Reuse existing if available |

---

### 6. Non-Functional Requirements

**Performance:**
- Synchronous exports (< threshold rows) must complete within 10 seconds
- Asynchronous exports processing millions of rows should complete within 15 minutes under normal load
- Worker batching must keep memory usage per worker below 512 MB

**Scalability:**
- Workers must be horizontally scalable to handle concurrent export jobs
- Object storage provides essentially unlimited file size capacity

**Security:**
- Pre-signed URLs must be user-scoped and expire within 48 hours
- Export jobs must be authorized — users may only download their own exports
- CSV content must not include fields the user is not authorized to access

**Observability:**
- Export job lifecycle events (queued, started, completed, failed) must be logged and emitted as metrics
- Alert if job queue depth exceeds threshold or worker error rate spikes

**Reliability:**
- Failed jobs must be retried up to 3 times with backoff before being marked as failed
- Users must receive a failure notification email if all retries are exhausted

---

## 2. LLD — Low-Level Design

### 1. Component Breakdown

#### 1.1 Export API Controller

**Responsibility:** Accept and validate export requests; route to sync or async path; return status.

**Endpoints:**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/exports` | Initiate a new export |
| `GET` | `/api/exports/:exportId` | Poll export status and get download URL |
| `GET` | `/api/exports` | List recent exports for the authenticated user |

**Input validation:**
- `start_date`, `end_date`: ISO 8601 dates, `start_date` <= `end_date`, range <= 2 years
- `metrics`: non-empty array, each value must be a member of the allowed metrics enum
- User must be authenticated

**Routing logic (pseudocode):**
```
POST /api/exports:
  validate(request)
  estimate = estimateRowCount(user_id, start_date, end_date, metrics)
  if estimate <= SYNC_THRESHOLD:
    stream CSV directly as HTTP response
  else:
    export_id = createExportRecord(user_id, params, status=QUEUED)
    enqueueJob(export_id)
    return { export_id, status: "queued" }
```

---

#### 1.2 Export Worker

**Responsibility:** Execute the export job: query data in batches, write CSV, upload to object storage, update status, send email.

**Trigger:** Job dequeued from queue with `{ export_id }` payload.

**Logic (pseudocode):**
```
function processExportJob(export_id):
  job = fetchExportRecord(export_id)
  updateStatus(export_id, PROCESSING)

  tmpFile = createTempCSVStream()
  writeCSVHeaders(tmpFile, job.metrics)

  cursor = null
  do:
    batch, cursor = queryAnalyticsData(
      user_id = job.user_id,
      start_date = job.start_date,
      end_date = job.end_date,
      metrics = job.metrics,
      cursor = cursor,
      batch_size = BATCH_SIZE  // e.g., 10,000
    )
    writeCSVRows(tmpFile, batch)
  while cursor != null

  finalizeCSVStream(tmpFile)
  url = uploadToObjectStorage(tmpFile, key=exportStorageKey(export_id))
  signed_url = generatePresignedUrl(url, expires_in=48h)

  updateExportRecord(export_id, status=DONE, download_url=signed_url, expires_at=now+48h)
  sendCompletionEmail(job.user_email, signed_url)
```

---

#### 1.3 CSV Generator (shared utility)

**Responsibility:** Produce valid RFC 4180 CSV from analytics data rows. Used by both sync path and async worker.

**Interface:**
```typescript
interface CSVWriter {
  writeHeaders(metrics: string[]): void;
  writeRow(row: AnalyticsRow): void;
  finalize(): void;
  getStream(): ReadableStream;
}

function createCSVWriter(outputStream: WritableStream): CSVWriter
```

**Concerns:**
- Escape commas and double-quotes per RFC 4180
- Handle `null` / `undefined` values as empty strings
- Write headers as the first row using human-readable column names (mapped from metric keys)

---

#### 1.4 Export Status Store (DB layer)

**Responsibility:** Persist export job state and metadata.

See Data Model section for schema.

---

#### 1.5 Object Storage Client

**Responsibility:** Upload completed CSV files and generate pre-signed download URLs.

**Interface:**
```typescript
interface ObjectStorageClient {
  upload(key: string, stream: ReadableStream, contentType: string): Promise<void>;
  generatePresignedUrl(key: string, expiresInSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
}
```

---

#### 1.6 Email Notification Service

**Responsibility:** Send transactional emails for export completion and failure.

**Interface:**
```typescript
interface ExportEmailService {
  sendCompletionEmail(to: string, downloadUrl: string, expiresAt: Date): Promise<void>;
  sendFailureEmail(to: string, exportId: string): Promise<void>;
}
```

---

#### 1.7 Frontend Export Modal

**Responsibility:** Collect export parameters from the user and submit the request.

**Inputs:**
- Date range picker: `startDate`, `endDate`
- Metric multi-select: list of `metricKey` values
- Submit button: "Export CSV"

**State machine:**
```
IDLE → SUBMITTING → QUEUED/PROCESSING → DONE | FAILED
```

On `QUEUED` / `PROCESSING`: show spinner and poll `GET /api/exports/:id` every 5 seconds.
On `DONE`: show success banner with download link.
On `FAILED`: show error message.

---

### 2. Data Model Changes

#### New table: `csv_exports`

```sql
CREATE TABLE csv_exports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  status        VARCHAR(20) NOT NULL DEFAULT 'queued',
                -- values: 'queued' | 'processing' | 'done' | 'failed'
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  metrics       JSONB NOT NULL,          -- array of metric key strings
  row_count     BIGINT,                  -- populated after completion
  download_url  TEXT,                    -- pre-signed URL, populated on done
  expires_at    TIMESTAMPTZ,             -- URL expiry time
  error_message TEXT,                    -- populated on failure
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX idx_csv_exports_user_id ON csv_exports(user_id);
CREATE INDEX idx_csv_exports_status ON csv_exports(status);
```

**Example record (in-progress):**
```json
{
  "id": "a1b2c3d4-...",
  "user_id": "u-999",
  "status": "processing",
  "start_date": "2025-01-01",
  "end_date": "2025-12-31",
  "metrics": ["page_views", "sessions", "bounce_rate"],
  "row_count": null,
  "download_url": null,
  "expires_at": null,
  "error_message": null,
  "created_at": "2026-03-26T10:00:00Z",
  "updated_at": "2026-03-26T10:00:05Z",
  "completed_at": null
}
```

**Example record (done):**
```json
{
  "id": "a1b2c3d4-...",
  "status": "done",
  "row_count": 4250000,
  "download_url": "https://storage.example.com/exports/a1b2c3d4-...csv?X-Amz-Expires=172800&...",
  "expires_at": "2026-03-28T10:00:00Z",
  "completed_at": "2026-03-26T10:07:43Z"
}
```

> **Assumption:** The application uses PostgreSQL. Adjust DDL for other databases accordingly.

---

### 3. Logic & Algorithms

#### Row Count Estimation

Before deciding sync vs. async, the API estimates expected rows:

```pseudocode
function estimateRowCount(user_id, start_date, end_date, metrics):
  // Use a COUNT query on the analytics data
  // Use an approximate count (e.g., pg_stats) if exact count is expensive
  days = dateDiff(start_date, end_date)
  // Optionally: use a fast approximate query
  return db.query(
    "SELECT COUNT(*) FROM analytics_events
     WHERE user_id = ? AND event_date BETWEEN ? AND ?",
    [user_id, start_date, end_date]
  )
```

> **Assumption:** `SYNC_THRESHOLD` = 50,000 rows (configurable via environment variable).

#### Cursor-Based Batching

To avoid OFFSET-based pagination (which degrades at large offsets), the worker uses cursor-based pagination:

```pseudocode
function queryAnalyticsData(user_id, start_date, end_date, metrics, cursor, batch_size):
  query = "SELECT {selected_columns}
           FROM analytics_events
           WHERE user_id = ?
             AND event_date BETWEEN ? AND ?
             AND (cursor IS NULL OR (event_date, id) > cursor)
           ORDER BY event_date ASC, id ASC
           LIMIT ?"
  rows = db.execute(query, [user_id, start_date, end_date, batch_size])
  next_cursor = rows.length == batch_size
    ? (last_row.event_date, last_row.id)
    : null
  return (rows, next_cursor)
```

#### Pre-Signed URL Generation

```pseudocode
function generatePresignedUrl(storageKey, expiresInSeconds):
  return storageClient.sign({
    method: "GET",
    bucket: EXPORT_BUCKET,
    key: storageKey,
    expires: expiresInSeconds,
    contentDisposition: "attachment; filename=\"analytics-export.csv\""
  })
```

---

### 4. API / Interface Design

#### POST /api/exports

**Request:**
```json
{
  "start_date": "2025-01-01",
  "end_date": "2025-12-31",
  "metrics": ["page_views", "sessions", "bounce_rate", "avg_session_duration"]
}
```

**Response (async — large export):**
```json
HTTP 202 Accepted
{
  "export_id": "a1b2c3d4-...",
  "status": "queued",
  "estimated_rows": 4250000,
  "message": "Your export is being processed. You will receive an email when it is ready."
}
```

**Response (sync — small export):**
```
HTTP 200 OK
Content-Type: text/csv
Content-Disposition: attachment; filename="analytics-export-2025-01-01-to-2025-12-31.csv"

date,page_views,sessions,bounce_rate,avg_session_duration
2025-01-01,1240,890,0.42,145
...
```

**Validation errors:**
```json
HTTP 422 Unprocessable Entity
{
  "error": "VALIDATION_ERROR",
  "details": [
    { "field": "end_date", "message": "end_date must be on or after start_date" },
    { "field": "metrics", "message": "metrics array must not be empty" }
  ]
}
```

#### GET /api/exports/:exportId

**Response (processing):**
```json
HTTP 200 OK
{
  "export_id": "a1b2c3d4-...",
  "status": "processing",
  "created_at": "2026-03-26T10:00:00Z"
}
```

**Response (done):**
```json
HTTP 200 OK
{
  "export_id": "a1b2c3d4-...",
  "status": "done",
  "download_url": "https://storage.example.com/exports/...?X-Amz-...",
  "expires_at": "2026-03-28T10:00:00Z",
  "row_count": 4250000,
  "completed_at": "2026-03-26T10:07:43Z"
}
```

#### GET /api/exports

**Response:**
```json
HTTP 200 OK
{
  "exports": [
    {
      "export_id": "a1b2c3d4-...",
      "status": "done",
      "start_date": "2025-01-01",
      "end_date": "2025-12-31",
      "metrics": ["page_views", "sessions"],
      "created_at": "2026-03-26T10:00:00Z",
      "expires_at": "2026-03-28T10:00:00Z"
    }
  ]
}
```

---

### 5. Error Handling & Edge Cases

| Scenario | Detection | Handling |
|---|---|---|
| User requests export with no data in range | Row count = 0 | Return 400 with message "No data found for the selected date range and metrics" |
| Analytics DB query timeout during worker execution | DB exception | Retry batch query up to 3 times; if all fail, mark export as `failed`, send failure email |
| Object storage upload failure | Storage client exception | Retry up to 3 times; if all fail, clean up temp file, mark export failed |
| Worker crashes mid-job | Job remains in `processing` after TTL | Stale job detector marks as `failed` after configurable timeout (e.g., 30 minutes with no heartbeat) |
| Pre-signed URL expires before user downloads | User clicks expired link | Return 403 from storage; direct user to request a new export via the status page |
| Unauthorized access to another user's export | Wrong `user_id` on GET | Return 404 (not 403) to avoid confirming existence |
| Export row count exceeds hard limit | Estimated rows > MAX_EXPORT_ROWS | Return 400 with message suggesting narrower date range or fewer metrics |
| Duplicate concurrent export request | Same user, same params, recent status = queued/processing | Optionally deduplicate and return existing `export_id` |

> **Assumption:** `MAX_EXPORT_ROWS` = 10,000,000 rows (configurable). Exports above this limit require the user to narrow their query.

---

### 6. Testing Considerations

**Unit tests:**

| Target | Key assertions |
|---|---|
| `validateExportRequest()` | Rejects invalid dates, empty metrics, future start dates beyond data range |
| `estimateRowCount()` | Returns correct counts; handles zero-row case |
| `CSVWriter` | Correctly escapes commas, quotes, newlines; writes correct headers; handles null values |
| `generatePresignedUrl()` | Correct expiry time, correct content-disposition header |
| `processExportJob()` | Calls query in correct batches; calls upload; updates status correctly |
| `sendCompletionEmail()` | Sends to correct address; includes URL; uses correct template |

**Integration tests:**

- `POST /api/exports` with small dataset → returns CSV directly, correct headers, correct row count
- `POST /api/exports` with large dataset → returns 202 with `export_id`, job is enqueued
- Worker processes enqueued job end-to-end → file in storage, status = done, email sent
- `GET /api/exports/:id` → returns correct status at each lifecycle stage
- Expired download URL → storage returns 403
- Unauthorized access → returns 404

**Load / performance tests:**

- Worker processes a 5,000,000-row export within 15 minutes without OOM
- 10 concurrent export jobs complete correctly with no data mixing

---

## 3. EARS — Requirements Plan

### Functional Requirements

| ID | Requirement |
|---|---|
| FR-1 | The system shall provide a UI control on the analytics dashboard for users to initiate a CSV export. |
| FR-2 | WHEN a user initiates an export, the system shall allow the user to specify a start date and end date for the export. |
| FR-3 | WHEN a user initiates an export, the system shall allow the user to select one or more metrics to include in the exported CSV. |
| FR-4 | WHEN a user submits an export request, the system shall validate that the start date is not after the end date. |
| FR-5 | WHEN a user submits an export request, the system shall validate that at least one metric is selected. |
| FR-6 | IF an export request fails validation THEN the system shall return a descriptive error message identifying which fields are invalid. |
| FR-7 | WHEN an export request is submitted and the estimated row count is below the configured synchronous threshold, the system shall return the CSV file directly as a streaming download. |
| FR-8 | WHEN an export request is submitted and the estimated row count meets or exceeds the synchronous threshold, the system shall enqueue the export job and return an export ID and queued status. |
| FR-9 | WHEN a large export job is enqueued, the system shall process the export asynchronously in a background worker. |
| FR-10 | WHILE an export job is processing, the system shall query the analytics data in configurable batches to avoid loading all rows into memory simultaneously. |
| FR-11 | WHEN an export job completes successfully, the system shall upload the generated CSV file to object storage. |
| FR-12 | WHEN an export job completes successfully, the system shall generate a pre-signed download URL with a configurable expiry time. |
| FR-13 | WHEN an export job completes successfully, the system shall send the user an email containing the pre-signed download URL and the expiry time. |
| FR-14 | WHEN an export job fails after all retries are exhausted, the system shall send the user an email notifying them of the failure. |
| FR-15 | The system shall provide an API endpoint that returns the current status and download URL (if ready) for a given export ID. |
| FR-16 | The system shall provide an API endpoint that returns a list of recent exports for the authenticated user. |
| FR-17 | WHILE an async export is pending or processing, the dashboard shall display the export status to the user with periodic updates. |
| FR-18 | WHEN a user accesses the download URL for a completed export, the system shall deliver the CSV file with a descriptive filename. |
| FR-19 | IF the estimated row count exceeds the configured maximum export limit THEN the system shall reject the request with an error suggesting the user narrow the date range or reduce the number of metrics. |
| FR-20 | IF a requested export has no data in the selected date range THEN the system shall return an error indicating no data was found. |
| FR-21 | The system shall restrict each user to accessing only their own export jobs. |

---

### Performance Requirements

| ID | Requirement |
|---|---|
| PR-1 | WHEN an export is served synchronously, the system shall begin streaming the CSV response within 2 seconds and complete delivery within 10 seconds for exports at or below the synchronous row threshold. |
| PR-2 | WHEN an asynchronous export job is processing, the system shall complete exports of up to 1,000,000 rows within 5 minutes under normal load. |
| PR-3 | WHEN an asynchronous export job is processing, the system shall complete exports of up to 10,000,000 rows within 15 minutes under normal load. |
| PR-4 | WHILE an export worker is executing, the system shall consume no more than 512 MB of memory per worker process. |
| PR-5 | The system shall support at least 10 concurrent export jobs without degradation in processing time beyond 20%. |
| PR-6 | WHEN a user polls the export status endpoint, the system shall respond within 200 ms at the 95th percentile. |

---

### Security Requirements

| ID | Requirement |
|---|---|
| SR-1 | The system shall reject all export API requests that lack a valid authentication token with a 401 response. |
| SR-2 | WHEN a user requests the status of an export they do not own, the system shall return a 404 response. |
| SR-3 | The system shall generate pre-signed download URLs that expire after no more than 48 hours. |
| SR-4 | The system shall scope pre-signed URLs to HTTP GET only and set `Content-Disposition: attachment` to prevent inline rendering. |
| SR-5 | WHERE a user's access permissions restrict certain metrics, the system shall exclude those metrics from the exported data even if requested. |
| SR-6 | The system shall not include any other user's data in a CSV export file. |

---

### Reliability Requirements

| ID | Requirement |
|---|---|
| RR-1 | IF an analytics database query fails during export processing THEN the system shall retry the query up to 3 times with exponential backoff before marking the job as failed. |
| RR-2 | IF an object storage upload fails THEN the system shall retry the upload up to 3 times before marking the job as failed. |
| RR-3 | IF an export worker crashes or becomes unresponsive THEN the system shall detect the stale job after a configurable heartbeat timeout and mark it as failed. |
| RR-4 | WHEN an export job is marked as failed after all retries are exhausted, the system shall send a failure notification email to the requesting user. |
| RR-5 | The system shall preserve export status records for at least 30 days after job completion or failure. |
| RR-6 | The system shall automatically delete expired CSV files from object storage after the download URL expiry period. |

---

### Usability / API Ergonomics Requirements

| ID | Requirement |
|---|---|
| UR-1 | WHEN an export request is rejected due to validation errors, the system shall return machine-readable error codes alongside human-readable messages. |
| UR-2 | WHEN an asynchronous export job is submitted, the system shall return a message informing the user that an email will be sent upon completion. |
| UR-3 | The system shall provide consistent status values (`queued`, `processing`, `done`, `failed`) across the API response and UI. |
| UR-4 | WHEN a completed export's download URL has expired, the system shall surface a clear message directing the user to request a new export. |
| UR-5 | The exported CSV file shall include a header row with human-readable column names corresponding to the selected metrics. |
| UR-6 | The system shall name downloaded CSV files descriptively, including the date range in the filename (e.g., `analytics-export-2025-01-01-to-2025-12-31.csv`). |

---

## 4. Implementation Plan

### 1. Phases & Milestones

| Phase | Description | Milestone |
|---|---|---|
| Phase 1 | Foundation: infra, data model, scaffolding | DB migration merged; job queue wired |
| Phase 2 | Core Logic: CSV generation and async worker | Export worker produces valid CSV files end-to-end |
| Phase 3 | API & Integration: endpoints, email, frontend | Full feature usable end-to-end in staging |
| Phase 4 | Polish & Testing: edge cases, tests, docs, review | All tests passing; feature-flagged and deployed |

---

### 2. Task Breakdown

```
Phase 1 – Foundation
- [ ] Create database migration for csv_exports table (all columns, indexes)
- [ ] Define ExportRecord data model / ORM entity
- [ ] Set up job queue infrastructure (confirm Redis/SQS availability; configure connection)
- [ ] Create skeleton ExportWorker class with placeholder job handler
- [ ] Create skeleton ExportAPIController with placeholder POST/GET endpoints
- [ ] Implement ObjectStorageClient wrapper (upload, presigned URL, delete)
- [ ] Add EXPORT_BUCKET, SYNC_THRESHOLD, MAX_EXPORT_ROWS, URL_EXPIRY_SECONDS to environment config

Phase 2 – Core Logic
- [ ] Implement CSVWriter utility (headers, row writing, RFC 4180 escaping, null handling)
- [ ] Implement cursor-based batched analytics data query function
- [ ] Implement row count estimation query
- [ ] Implement sync/async routing logic (estimate rows → branch)
- [ ] Implement full ExportWorker job handler (batch query → CSV → upload → update status)
- [ ] Implement stale job detector (heartbeat timeout → mark failed)
- [ ] Write unit tests for CSVWriter (escaping, headers, null values)
- [ ] Write unit tests for batched query function (cursor advancement, terminal condition)
- [ ] Write unit tests for ExportWorker (status transitions, retry behavior)

Phase 3 – API & Integration
- [ ] Implement POST /api/exports endpoint (validation, estimate, sync path, async path)
- [ ] Implement GET /api/exports/:id endpoint (auth check, status response)
- [ ] Implement GET /api/exports endpoint (list user's recent exports)
- [ ] Implement ExportEmailService (completion email, failure email with templates)
- [ ] Wire email sending into ExportWorker on completion and failure
- [ ] Build frontend Export Modal component (date range picker, metric selector, submit)
- [ ] Implement export status polling in frontend (poll GET /api/exports/:id every 5s)
- [ ] Add export status list / history section to dashboard

Phase 4 – Polish & Testing
- [ ] Write integration test: small export → sync CSV download
- [ ] Write integration test: large export → async job → file in storage → status = done
- [ ] Write integration test: unauthorized access → 404
- [ ] Write integration test: expired URL → correct error handling in UI
- [ ] Add observability: log job lifecycle events; emit metrics for queue depth and worker errors
- [ ] Load test: verify 5M row export completes within time and memory bounds
- [ ] Add feature flag to gate the export UI and API endpoints
- [ ] Update API documentation
- [ ] Conduct code review and address feedback
- [ ] Deploy to staging and perform end-to-end QA walkthrough
- [ ] Enable feature flag in production for initial rollout (consider % rollout)
```

---

### 3. Dependencies & Sequencing

```
Phase 1 must complete before Phase 2 or Phase 3 can begin:
  - DB migration required before ExportRecord can be used
  - Job queue infrastructure required before ExportWorker can be tested end-to-end
  - ObjectStorageClient required before worker upload logic can be implemented

Phase 2 core tasks must complete before Phase 3 integration:
  - CSVWriter must be complete before sync path (Phase 3) or worker (Phase 2) uses it
  - Batched query function must be complete before ExportWorker can be implemented
  - ExportWorker must be complete before email integration (Phase 3) is wired in

Phase 3 backend must complete before Phase 3 frontend can be connected:
  - API endpoints must be deployed to a dev/staging environment before frontend polling can be tested

Phase 4 can begin independently of all Phase 3 tasks except:
  - Integration tests require the full Phase 3 stack to be available

External blockers to resolve early:
  - Confirm object storage bucket name, credentials, and IAM permissions
  - Confirm email service API key and transactional email sending limits
  - Confirm job queue technology choice aligns with existing infrastructure
  - Confirm analytics data query layer supports cursor-based pagination (may need schema changes)
```

---

### 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Analytics data query layer does not support efficient cursor-based pagination | Medium | High | Investigate early in Phase 1; if cursor pagination requires schema changes, create a separate spike task and adjust timeline |
| Object storage costs exceed expectations for large/frequent exports | Low | Medium | Enforce row limits; implement aggressive URL expiry and lifecycle deletion; add per-user export quotas if needed |
| Worker memory exhaustion on very large exports | Medium | High | Enforce batch size limits; monitor memory per worker in load tests; add circuit-breaker to abort jobs approaching memory limit |
| Email delivery failures causing users to miss completion notifications | Low | Medium | Log all email send attempts and failures; provide dashboard status page as fallback; implement retry for transient email API errors |

---

### 5. Definition of Done

- [ ] All unit tests pass with >= 80% code coverage on new modules
- [ ] All integration tests pass in CI
- [ ] Load test: 5,000,000-row export completes within 15 minutes, worker memory stays below 512 MB
- [ ] Security review completed: auth checks verified, pre-signed URL expiry confirmed, cross-user access blocked
- [ ] Feature is gated behind a feature flag
- [ ] Feature flag enabled in staging; end-to-end QA walkthrough completed by at least one team member
- [ ] Observability: job lifecycle logs and queue depth metrics are visible in monitoring dashboards
- [ ] API documentation updated
- [ ] Code reviewed and approved by at least one senior engineer
- [ ] Product/design sign-off on UI flow and email templates
- [ ] Deployed to production with feature flag at 0% or limited rollout; ready to ramp

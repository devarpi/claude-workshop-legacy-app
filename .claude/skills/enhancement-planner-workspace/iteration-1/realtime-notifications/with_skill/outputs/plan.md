# Enhancement Plan: Real-Time Notifications

---

## 1. HLD — High-Level Design

### 1. Overview

This enhancement adds a real-time notification system to the web application, enabling users to receive instant alerts when someone comments on their post, likes their content, or sends them a direct message. Notifications are surfaced via a bell icon in the navigation bar with a badge count indicating unread notifications. The system is built on top of an existing Python/Django backend and React frontend, using WebSockets (via Django Channels) to push events from the server to the client without polling.

The core problem this solves is user engagement lag: without real-time notifications, users must manually refresh to discover new interactions. This directly increases session depth and content interaction frequency.

### 2. Goals & Non-Goals

**Goals:**
- Deliver in-app real-time notifications for: new comment on a post, new like on content, and new direct message received
- Show a bell icon in the React navigation bar with an unread badge count
- Allow users to view a notification list and mark notifications as read
- Persist notifications in the database so they survive page reloads and re-logins
- Support graceful degradation (fall back to polling if WebSocket connection fails)

**Non-Goals:**
- Email or SMS notifications (out of scope for this iteration)
- Push notifications to mobile browsers (PWA/service workers) — future iteration
- Notification preferences or per-type mute settings — future iteration
- Cross-device real-time sync (e.g., marking read on mobile reflects on desktop instantly) — future iteration
- Admin or system-generated notifications beyond the three specified types

### 3. Architecture Overview

The system introduces three new layers on top of the existing Django/React stack:

1. **Django Channels** — Adds WebSocket support to the Django backend via ASGI. Each authenticated user connects to a personal WebSocket channel group (identified by user ID).
2. **Notification Service (Django)** — A new Django app (`notifications`) that handles creation, persistence, and dispatch of notification events. When a comment, like, or DM is created anywhere in the backend, the notification service is called to create a `Notification` record and publish the event to the user's channel group via the channel layer (backed by Redis).
3. **Notification UI (React)** — A new `NotificationBell` component subscribes to a WebSocket connection and updates a local/global state store (e.g., Redux or React Context) with incoming notification events. The bell icon displays the unread count and a dropdown lists recent notifications.

```
Browser (React)
  |
  |--[HTTP REST]--> Django REST API (existing)
  |--[WebSocket]---> Django Channels (ASGI) --> Channel Layer (Redis)
                                                        ^
                                                        |
                       Django App Logic ----------------+
                       (Comment/Like/DM created)
                         --> notifications.service.notify(user_id, payload)
                               --> Notification model (PostgreSQL)
                               --> channel_layer.group_send(f"user_{user_id}", event)
```

**New components:**
- `notifications` Django app (models, serializers, views, consumers, service layer)
- Redis channel layer (new infrastructure dependency)
- Django ASGI entrypoint (`asgi.py`)
- React `NotificationBell` component
- React `useNotifications` hook (WebSocket management + state)
- React `NotificationDropdown` component

**Modified components:**
- Django comment, like, and DM creation logic (call notify service after save)
- Django URL configuration (add WebSocket routing)
- React navigation bar (embed `NotificationBell`)

### 4. Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| WebSocket transport | Django Channels + Redis channel layer | Native Django ecosystem; scales horizontally; well-documented |
| Fallback strategy | Long-polling every 30s if WS fails | Maintains functionality without real-time; avoids silent failures |
| Notification storage | PostgreSQL `Notification` table | Durable, queryable, consistent with existing stack |
| Per-user channel group naming | `user_<user_id>` | Simple, secure — server controls group membership |
| Frontend state management | React Context + useReducer | Lightweight; avoids Redux overhead for notification-scoped state |
| Read/unread tracking | `is_read` boolean + `read_at` timestamp | Supports both badge count and historical audit |
| Fan-out model | Server-side at event creation time | Simpler than client-side fan-out; acceptable for initial load |

**Trade-off: WebSockets vs. Server-Sent Events (SSE)**
SSE would be simpler (HTTP-based, no upgrade) but only supports server-to-client communication. WebSockets are bidirectional and better suit future use cases (e.g., typing indicators in DMs). Django Channels supports both; WebSockets were chosen for extensibility.

**Trade-off: Redis channel layer vs. in-memory layer**
In-memory layer works for single-process dev but fails in multi-worker production. Redis is chosen from the start to avoid painful migration later.

### 5. Dependencies & Integrations

| Dependency | Purpose | Notes |
|---|---|---|
| `channels` (Django Channels 4.x) | WebSocket support | Requires ASGI server (Daphne or Uvicorn) |
| `channels-redis` | Redis-backed channel layer | Requires Redis 6+ instance |
| Redis | Channel layer broker | New infrastructure; can reuse existing Redis if present |
| `djangorestframework` | REST endpoints for notification list/mark-read | Already in use (assumed) |
| React 18+ | Frontend framework | Already in use |
| `reconnecting-websocket` (npm) | Auto-reconnect WS client | Lightweight; handles transient disconnects |

**Integrations with existing systems:**
- Comment creation signal/post-save hook in the posts/comments Django app
- Like creation signal in the likes Django app
- DM creation signal in the messaging Django app
- Existing Django authentication (session/JWT) — used to authenticate WS connections

### 6. Non-Functional Requirements

**Performance:**
- Notification delivery latency: < 500ms from event creation to browser receipt at p95
- REST endpoint for notification list: < 200ms at p95
- WebSocket connection establishment: < 1s

**Scalability:**
- Redis channel layer supports horizontal scaling of Django workers
- Notification table should be indexed on `recipient_id` + `is_read` + `created_at`
- Pagination on the notification list endpoint (cursor-based, 20 per page)

**Security:**
- WebSocket connections authenticated via session cookie or JWT; unauthenticated connections rejected at handshake
- Users can only receive notifications addressed to their own user ID; server enforces group isolation
- Notification content must not leak post/message body data to unauthorized users

**Observability:**
- Log WebSocket connection open/close events with user ID and reason
- Emit metrics: notifications created per minute, WS active connections, delivery latency histogram
- Alert on Redis channel layer errors

---

## 2. LLD — Low-Level Design

### 1. Component Breakdown

#### 1.1 `notifications` Django App

**`models.py` — Notification model**
- Responsibility: Persist notification records; source of truth for badge counts and history
- Inputs: Created by service layer
- Outputs: Serialized via REST and WebSocket payloads

**`service.py` — NotificationService**
- Responsibility: Centralized entry point for creating notifications and dispatching channel events
- Inputs: `recipient_id`, `notification_type`, `actor_id`, `target_object_type`, `target_object_id`
- Outputs: Creates DB record; publishes to Redis channel layer

**`consumers.py` — NotificationConsumer (WebSocket)**
- Responsibility: Handle WS connections; authenticate users; route channel group messages to connected clients
- Inputs: WebSocket connect/disconnect events; channel layer messages
- Outputs: JSON messages sent to connected WebSocket client

**`views.py` — REST Views**
- `NotificationListView`: paginated list of notifications for authenticated user
- `NotificationMarkReadView`: mark one or all notifications as read

**`serializers.py`**
- `NotificationSerializer`: serializes `Notification` to JSON for both REST and WS payloads

#### 1.2 React Components

**`NotificationBell` component**
- Responsibility: Render bell icon + badge count; manage WebSocket connection lifecycle
- Props: none (reads from `NotificationContext`)

**`NotificationDropdown` component**
- Responsibility: Render list of recent notifications; trigger mark-as-read

**`useNotifications` hook**
- Responsibility: Establish and maintain WS connection; dispatch to `NotificationContext`; handle fallback polling

**`NotificationContext` + `notificationReducer`**
- Responsibility: Global state for notifications list and unread count

### 2. Data Model Changes

#### New Table: `notifications_notification`

```sql
CREATE TABLE notifications_notification (
    id            BIGSERIAL PRIMARY KEY,
    recipient_id  INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    actor_id      INTEGER REFERENCES auth_user(id) ON DELETE SET NULL,
    notification_type VARCHAR(50) NOT NULL,  -- 'comment', 'like', 'direct_message'
    target_ct_id  INTEGER REFERENCES django_content_type(id),  -- GenericForeignKey content type
    target_object_id BIGINT,                -- GenericForeignKey object id
    data          JSONB NOT NULL DEFAULT '{}',  -- extra payload (e.g., preview text)
    is_read       BOOLEAN NOT NULL DEFAULT FALSE,
    read_at       TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_recipient_unread ON notifications_notification (recipient_id, is_read, created_at DESC);
CREATE INDEX idx_notif_recipient_all   ON notifications_notification (recipient_id, created_at DESC);
```

**Django model (Python):**

```python
class Notification(models.Model):
    COMMENT = 'comment'
    LIKE = 'like'
    DIRECT_MESSAGE = 'direct_message'
    TYPE_CHOICES = [(COMMENT, 'Comment'), (LIKE, 'Like'), (DIRECT_MESSAGE, 'Direct Message')]

    recipient    = models.ForeignKey(settings.AUTH_USER_MODEL, related_name='notifications', on_delete=models.CASCADE)
    actor        = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL, related_name='+')
    notification_type = models.CharField(max_length=50, choices=TYPE_CHOICES)
    content_type = models.ForeignKey(ContentType, null=True, on_delete=models.SET_NULL)
    object_id    = models.PositiveIntegerField(null=True)
    target       = GenericForeignKey('content_type', 'object_id')
    data         = models.JSONField(default=dict)
    is_read      = models.BooleanField(default=False)
    read_at      = models.DateTimeField(null=True, blank=True)
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['recipient', 'is_read', '-created_at']),
        ]
```

**Migration:** `notifications/migrations/0001_initial.py` — auto-generated via `makemigrations`.

#### No changes to existing tables.

### 3. Logic & Algorithms

#### 3.1 Notification Creation Flow

```
# Triggered by Django post_save signal or explicit service call
def notify(recipient_id, actor_id, notification_type, target_obj, extra_data={}):
    1. Create Notification record in DB
       notification = Notification.objects.create(
           recipient_id=recipient_id,
           actor_id=actor_id,
           notification_type=notification_type,
           content_type=ContentType.objects.get_for_model(target_obj),
           object_id=target_obj.pk,
           data=extra_data,
       )
    2. Serialize notification to dict
       payload = NotificationSerializer(notification).data
    3. Send to Redis channel layer (async-safe via async_to_sync)
       channel_layer.group_send(
           f"user_{recipient_id}",
           {"type": "send_notification", "payload": payload}
       )
    4. Return notification
```

#### 3.2 WebSocket Consumer

```
class NotificationConsumer(AsyncWebsocketConsumer):

    async def connect():
        user = self.scope["user"]
        if not user.is_authenticated:
            await self.close(code=4001)
            return
        self.group_name = f"user_{user.id}"
        await channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()
        # Send initial unread count on connect
        unread_count = await get_unread_count(user.id)
        await self.send(json.dumps({"type": "init", "unread_count": unread_count}))

    async def disconnect(code):
        await channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(text_data):
        data = json.loads(text_data)
        if data.get("action") == "mark_read":
            await mark_notifications_read(self.scope["user"].id, data.get("ids"))

    async def send_notification(event):
        # Called by channel layer when group_send fires
        await self.send(json.dumps({
            "type": "notification",
            "payload": event["payload"]
        }))
```

#### 3.3 React WebSocket State Machine

```
States: DISCONNECTED -> CONNECTING -> CONNECTED -> RECONNECTING -> DISCONNECTED

useNotifications hook:
  - On mount: instantiate ReconnectingWebSocket(WS_URL)
  - onopen: dispatch {type: CONNECTED}
  - onmessage: parse JSON
    - if type == 'init': dispatch {type: SET_UNREAD_COUNT, count}
    - if type == 'notification': dispatch {type: ADD_NOTIFICATION, notification}
                                 dispatch {type: INCREMENT_UNREAD}
  - onclose: dispatch {type: DISCONNECTED}; start fallback polling if retries exhausted
  - On unmount: close WS

Fallback polling:
  - After 3 failed WS reconnects, switch to polling /api/notifications/?unread=true every 30s
  - Resume WS on next page load
```

### 4. API / Interface Design

#### 4.1 REST Endpoints

**GET /api/notifications/**
- Auth: Required
- Query params: `?page=<cursor>&unread=<bool>`
- Response 200:
```json
{
  "count": 42,
  "unread_count": 5,
  "next": "https://app.example.com/api/notifications/?page=abc123",
  "results": [
    {
      "id": 101,
      "type": "comment",
      "actor": {"id": 7, "username": "alice", "avatar_url": "..."},
      "target": {"type": "post", "id": 55, "url": "/posts/55"},
      "data": {"preview": "Great post! I especially liked..."},
      "is_read": false,
      "created_at": "2026-03-26T10:00:00Z"
    }
  ]
}
```

**POST /api/notifications/mark-read/**
- Auth: Required
- Body: `{"ids": [101, 102]}` or `{"all": true}`
- Response 200: `{"marked_read": 2}`

#### 4.2 WebSocket

**URL:** `wss://app.example.com/ws/notifications/`

**Server → Client messages:**

```json
// On connect: initial state
{"type": "init", "unread_count": 5}

// On new notification
{
  "type": "notification",
  "payload": {
    "id": 102,
    "type": "like",
    "actor": {"id": 9, "username": "bob", "avatar_url": "..."},
    "target": {"type": "post", "id": 55, "url": "/posts/55"},
    "data": {},
    "is_read": false,
    "created_at": "2026-03-26T10:01:00Z"
  }
}
```

**Client → Server messages:**

```json
// Mark specific notifications read
{"action": "mark_read", "ids": [101, 102]}

// Mark all read
{"action": "mark_read", "all": true}
```

#### 4.3 Django URL/Routing Config

```python
# asgi.py
application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter([
            path("ws/notifications/", NotificationConsumer.as_asgi()),
        ])
    ),
})
```

### 5. Error Handling & Edge Cases

| Scenario | Detection | Handling |
|---|---|---|
| Unauthenticated WS connection | `scope["user"].is_authenticated == False` | Close with code 4001; log warning |
| Redis channel layer unreachable | `ChannelFull` or connection error in `group_send` | Log error + metric; skip WS dispatch; notification still saved to DB |
| WS client disconnects mid-session | `disconnect()` called | Gracefully remove from group; no action needed |
| Duplicate notifications (e.g., double-save signal) | Duplicate DB record | Add `unique_together` constraint on `(recipient, notification_type, object_id)` with a short dedup window via `get_or_create` + `created_at > now()-5s` guard |
| Mark-read for IDs not owned by user | Queried with `recipient=request.user` filter | Returns 200 with 0 marked; no error leakage |
| Notification target deleted | `GenericForeignKey` returns `None` | Serializer handles `null` target gracefully; notification still displayed with fallback text |
| React WS fails repeatedly | ReconnectingWebSocket exhausts retries | Switch to REST polling fallback; show subtle "live updates paused" UI indicator |
| Large notification backlog on reconnect | Client reconnects after offline period | On WS `init`, client fetches REST endpoint to sync; WS only delivers new events after connect time |

### 6. Testing Considerations

**Unit Tests (Django):**
- `NotificationService.notify()` creates DB record with correct fields
- `NotificationService.notify()` calls `channel_layer.group_send` with correct group and payload
- `NotificationSerializer` produces expected JSON shape
- `NotificationListView` returns paginated results filtered to request user
- `NotificationMarkReadView` marks only the requesting user's notifications
- Signal handlers for comment/like/DM creation call `notify()` with correct args

**Integration Tests (Django):**
- WebSocket consumer accepts authenticated connections and sends `init` message
- WebSocket consumer rejects unauthenticated connections with code 4001
- End-to-end: create a comment → verify `Notification` row created → verify WS message received by consumer test client
- `mark_read` action via WebSocket updates DB `is_read` and `read_at`

**Frontend Tests (React Testing Library + Jest):**
- `NotificationBell` renders correct badge count from context
- `useNotifications` hook dispatches `ADD_NOTIFICATION` on incoming WS message
- `NotificationDropdown` renders notification list items with correct text
- Clicking a notification marks it read and decrements badge count
- Fallback polling activates when WS connection fails after max retries

**Key Assertions:**
- Badge count matches `unread_count` returned by REST endpoint
- Notification delivered within 500ms of creation (integration test with timing)
- Zero notifications leaked between users (cross-user isolation test)

---

## 3. EARS — Requirements Plan

### Functional Requirements

**FR-1:** The system shall persist a `Notification` record in the database whenever a user's post receives a comment, their content receives a like, or they receive a direct message.

**FR-2:** WHEN a new `Notification` record is created, the system shall publish a real-time notification event to the recipient's active WebSocket connection(s) within 500ms.

**FR-3:** WHEN a user loads the application, the system shall establish a WebSocket connection to `/ws/notifications/` and send an `init` message containing the current unread notification count.

**FR-4:** WHILE a WebSocket connection is active, the system shall deliver all new notifications addressed to the connected user in real time without requiring a page refresh.

**FR-5:** The system shall display a bell icon in the navigation bar that shows a numeric badge indicating the count of unread notifications.

**FR-6:** WHEN the unread notification count is zero, the system shall display the bell icon without a badge.

**FR-7:** WHEN a user clicks the bell icon, the system shall display a dropdown listing the most recent notifications (up to 20), including actor name, notification type, target reference, and timestamp.

**FR-8:** WHEN a user clicks on a notification in the dropdown, the system shall mark that notification as read and navigate the user to the relevant content.

**FR-9:** The system shall provide a REST endpoint `GET /api/notifications/` that returns a paginated list of the authenticated user's notifications, ordered by `created_at` descending.

**FR-10:** The system shall provide a REST endpoint `POST /api/notifications/mark-read/` that marks one or more specified notifications as read for the authenticated user.

**FR-11:** WHERE a "mark all as read" action is included, the system shall mark all of the authenticated user's unread notifications as read in a single operation.

**FR-12:** IF the WebSocket connection cannot be established or is lost after 3 reconnect attempts, the system shall fall back to polling `GET /api/notifications/?unread=true` every 30 seconds to maintain notification delivery.

**FR-13:** WHEN a user re-opens or refreshes the application after being offline, the system shall fetch the current notification list via REST to synchronize any missed notifications.

**FR-14:** The system shall support the following notification types: `comment`, `like`, and `direct_message`.

### Performance Requirements

**PR-1:** The system shall deliver WebSocket notification events to the recipient within 500ms of the source event creation at the 95th percentile under normal load.

**PR-2:** The system shall return results from `GET /api/notifications/` within 200ms at the 95th percentile.

**PR-3:** The system shall support at least 10,000 concurrent authenticated WebSocket connections without degradation.

**PR-4:** The system shall paginate the notification list endpoint at a maximum of 20 notifications per page using cursor-based pagination.

### Security Requirements

**SR-1:** The system shall reject WebSocket connection attempts from unauthenticated clients with close code 4001.

**SR-2:** WHEN a WebSocket connection is established, the system shall authenticate the connecting user using the existing session cookie or JWT token before adding them to a channel group.

**SR-3:** The system shall ensure that each user's WebSocket channel group is isolated by user ID, such that a user can only receive notifications addressed to their own account.

**SR-4:** The system shall filter all REST notification responses by `recipient=request.user`, preventing any user from reading another user's notifications.

**SR-5:** IF a mark-read request includes notification IDs that do not belong to the requesting user, the system shall silently ignore those IDs and return a successful response with a count of zero for the ignored IDs.

**SR-6:** The system shall not include the full body text of comments, messages, or posts in notification payloads; only a short configurable preview (≤ 140 characters) is permitted.

### Reliability Requirements

**RR-1:** IF the Redis channel layer is unavailable when dispatching a notification event, the system shall log the error and continue processing without throwing an unhandled exception, ensuring the notification record is still persisted to the database.

**RR-2:** The system shall retain all notification records in the database regardless of WebSocket delivery success or failure.

**RR-3:** WHILE the WebSocket connection is in a reconnecting state, the system shall not display stale or incorrect unread counts; it shall re-fetch counts from the REST endpoint upon reconnection.

**RR-4:** The system shall handle deletion of notification target objects (posts, messages) gracefully, rendering the notification with a fallback label (e.g., "[deleted]") rather than raising an error.

**RR-5:** IF a duplicate notification creation is attempted for the same recipient, type, and target object within a 5-second window, the system shall return the existing notification record rather than creating a duplicate.

### Usability / API Ergonomics Requirements

**UX-1:** The system shall render the bell icon and badge in the navigation bar on all authenticated pages without requiring additional user action.

**UX-2:** WHEN the notification dropdown is open and a new real-time notification arrives, the system shall prepend the new notification to the top of the dropdown list without closing the dropdown.

**UX-3:** The system shall display a human-readable relative timestamp (e.g., "2 minutes ago") for each notification in the dropdown.

**UX-4:** WHEN the WebSocket fallback polling mode is active, the system shall display a subtle, non-intrusive indicator (e.g., a tooltip on the bell icon) informing the user that live updates are paused.

**UX-5:** The REST API shall return descriptive error messages in the format `{"error": "<message>"}` for all 4xx responses.

---

## 4. Implementation Plan

### 1. Phases & Milestones

| Phase | Focus | Estimated Duration |
|---|---|---|
| Phase 1 | Foundation: infrastructure, data models, Django Channels setup | 2–3 days |
| Phase 2 | Core Backend Logic: service layer, signals, REST API | 2–3 days |
| Phase 3 | WebSocket Consumer + React Integration | 3–4 days |
| Phase 4 | Polish, Testing, Edge Cases, Deployment | 2–3 days |

**Total estimated effort:** 9–13 developer-days

### 2. Task Breakdown

```
Phase 1 – Foundation
- [ ] Add `channels`, `channels-redis`, and `daphne` (or `uvicorn`) to requirements.txt / pyproject.toml
- [ ] Configure Redis channel layer in Django settings (CHANNEL_LAYERS)
- [ ] Create `asgi.py` with ProtocolTypeRouter for HTTP + WebSocket routing
- [ ] Create `notifications` Django app (`python manage.py startapp notifications`)
- [ ] Define `Notification` model with all fields (recipient, actor, type, GenericFK, data, is_read, read_at, created_at)
- [ ] Write and run database migration for `notifications_notification` table
- [ ] Add indexes: (recipient_id, is_read, created_at DESC) and (recipient_id, created_at DESC)
- [ ] Register `notifications` app in INSTALLED_APPS

Phase 2 – Core Backend Logic
- [ ] Implement `NotificationService.notify()` in `notifications/service.py`
- [ ] Implement `NotificationSerializer` in `notifications/serializers.py`
- [ ] Implement `NotificationListView` (paginated, cursor-based, filtered by request.user)
- [ ] Implement `NotificationMarkReadView` (single IDs or all=true)
- [ ] Add URL routes for REST endpoints in `notifications/urls.py` and include in main `urls.py`
- [ ] Add `post_save` signal handlers in comments, likes, and DM apps to call `NotificationService.notify()`
- [ ] Implement deduplication guard in `notify()` (get_or_create within 5s window)
- [ ] Write unit tests for service, serializer, and REST views

Phase 3 – WebSocket Consumer + React Integration
- [ ] Implement `NotificationConsumer` (AsyncWebsocketConsumer) with connect, disconnect, receive, send_notification handlers
- [ ] Add authentication check in `connect()` using `AuthMiddlewareStack`
- [ ] Add WebSocket URL route to `asgi.py`
- [ ] Write integration tests for NotificationConsumer (auth, init message, notification delivery, mark-read)
- [ ] Create `NotificationContext` and `notificationReducer` in React (ADD_NOTIFICATION, SET_UNREAD_COUNT, MARK_READ, etc.)
- [ ] Implement `useNotifications` hook with ReconnectingWebSocket, fallback polling logic, and state dispatch
- [ ] Create `NotificationBell` component (bell icon + badge, click to toggle dropdown)
- [ ] Create `NotificationDropdown` component (list of notifications, relative timestamps, mark-read on click)
- [ ] Integrate `NotificationBell` into the existing React navigation bar
- [ ] Add `reconnecting-websocket` npm package
- [ ] Write React component tests (bell renders count, dropdown renders list, mark-read interaction)

Phase 4 – Polish, Testing & Deployment
- [ ] Implement fallback polling UI indicator ("live updates paused") in NotificationBell
- [ ] Handle null/deleted notification targets gracefully in serializer and React render
- [ ] Add logging for WS connect/disconnect with user ID
- [ ] Add metrics instrumentation (notifications created/min, active WS connections, delivery latency)
- [ ] Write cross-user isolation test (verify user A cannot receive user B's notifications)
- [ ] Write end-to-end test: create comment → verify WS delivery → verify badge count update
- [ ] Update deployment configuration to run Daphne (ASGI) instead of Gunicorn (WSGI), or run both in parallel
- [ ] Provision Redis instance in staging and production environments
- [ ] Deploy to staging and perform manual smoke testing
- [ ] Update internal developer documentation for the notifications app
```

### 3. Dependencies & Sequencing

```
Phase 1 must complete before Phase 2 (model must exist before service layer)
Phase 2 must complete before Phase 3 backend work (service must exist before consumer calls it)
Phase 3 backend (consumer) can proceed in parallel with Phase 3 frontend (React) once the WS contract is defined
Phase 4 depends on all of Phase 3 being complete
```

**External blockers:**
- Redis instance must be provisioned before end-to-end testing (Phase 3+)
- ASGI server (Daphne/Uvicorn) must be available in the deployment environment before Phase 4 deployment
- DevOps/infrastructure approval may be needed to open WebSocket port in load balancer/reverse proxy config

**Critical path:**
`Django app + migration → Service layer → WebSocket consumer → React hook + components → Integration tests → Deploy`

### 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ASGI migration breaks existing WSGI-based functionality | Medium | High | Run Daphne alongside existing Gunicorn initially; route WS to Daphne and HTTP to Gunicorn via nginx; migrate fully only after validation |
| Redis introduces new infrastructure dependency and potential outage | Low | Medium | Add Redis health check to monitoring; `notify()` handles Redis failure gracefully (saves to DB, skips WS dispatch); fallback polling covers the gap |
| Signal handlers on comment/like/DM creation add latency to those flows | Low | Medium | Use `async_to_sync` carefully or dispatch via Celery task to decouple notification creation from request cycle |
| High concurrent WS connections overwhelm single Redis instance | Low (initially) | High | Start with a single Redis instance; plan for Redis Cluster or Sentinel before >5k concurrent users; monitor connection count metric |

### 5. Definition of Done

- [ ] All three notification types (comment, like, DM) create `Notification` DB records
- [ ] Authenticated users receive real-time notifications via WebSocket within 500ms
- [ ] Bell icon displays correct unread count on all authenticated pages
- [ ] Notification dropdown renders the 20 most recent notifications with correct actor, type, and timestamp
- [ ] Clicking a notification marks it read and navigates to the correct target
- [ ] "Mark all as read" clears the badge count
- [ ] Unauthenticated WebSocket connections are rejected with code 4001
- [ ] Cross-user notification isolation is verified by automated test
- [ ] Fallback polling activates when WebSocket fails and delivers notifications
- [ ] All unit and integration tests pass in CI
- [ ] Redis and ASGI server are provisioned and stable in staging
- [ ] Feature deployed to staging with successful smoke test sign-off
- [ ] Delivery latency p95 < 500ms verified under load in staging
- [ ] Internal developer documentation updated for the `notifications` app

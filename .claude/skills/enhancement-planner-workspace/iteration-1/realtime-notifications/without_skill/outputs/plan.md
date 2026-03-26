# Real-Time Notifications: End-to-End Planning Document

**Feature:** Real-Time Notifications (comments, likes, direct messages)
**Stack:** Django (Python) backend, React frontend
**Date:** 2026-03-26

---

## Table of Contents

1. [Requirements](#requirements)
2. [High-Level Design](#high-level-design)
3. [Low-Level Design](#low-level-design)
4. [Implementation Plan](#implementation-plan)

---

## Requirements

### Functional Requirements

#### FR-1: Notification Triggers
- **FR-1.1** — A notification is created when another user comments on the authenticated user's post.
- **FR-1.2** — A notification is created when another user likes the authenticated user's content (post or comment).
- **FR-1.3** — A notification is created when another user sends the authenticated user a direct message.

#### FR-2: Real-Time Delivery
- **FR-2.1** — Notifications must be delivered to the recipient's browser in real time (within ~1 second of the triggering event) without requiring a page refresh.
- **FR-2.2** — If the user is not currently connected (offline), unread notifications must be persisted and delivered when they reconnect.

#### FR-3: Bell Icon & Badge Count
- **FR-3.1** — A bell icon is displayed in the top navigation bar.
- **FR-3.2** — A numeric badge on the bell icon shows the count of unread notifications.
- **FR-3.3** — The badge disappears (or shows 0) when all notifications are marked as read.
- **FR-3.4** — Clicking the bell opens a notification drawer/dropdown showing the latest notifications.

#### FR-4: Notification Management
- **FR-4.1** — Each notification can be individually marked as read.
- **FR-4.2** — A "Mark all as read" action is available.
- **FR-4.3** — Clicking a notification navigates the user to the relevant content (the post, the message thread, etc.).
- **FR-4.4** — Notifications are paginated (default: 20 per page) within the drawer.

#### FR-5: Notification Content
- **FR-5.1** — Each notification displays: actor avatar, actor name, action description, target content snippet, and relative timestamp (e.g., "2 minutes ago").

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-1 | Latency | Notification delivery p95 < 1 second |
| NFR-2 | Scalability | Support 10,000 concurrent WebSocket connections |
| NFR-3 | Reliability | Notifications must not be lost; at-least-once delivery |
| NFR-4 | Security | Users must only receive their own notifications; WebSocket connections must be authenticated |
| NFR-5 | Persistence | Notifications stored for minimum 90 days |
| NFR-6 | Performance | Badge count API response < 100ms |
| NFR-7 | Browser Support | Chrome, Firefox, Safari, Edge (latest 2 versions) |

### Out of Scope

- Email / push notification delivery (separate feature)
- Notification preference settings (future iteration)
- Admin-broadcast notifications (future iteration)

---

## High-Level Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         React Frontend                          │
│                                                                 │
│  ┌───────────────┐   ┌─────────────────┐   ┌───────────────┐  │
│  │  Bell Icon +  │   │  Notification   │   │  WebSocket    │  │
│  │  Badge Count  │◄──│  Context/Store  │◄──│  Client       │  │
│  └───────────────┘   └─────────────────┘   └───────┬───────┘  │
│                                                     │          │
└─────────────────────────────────────────────────────┼──────────┘
                                                      │ WSS
┌─────────────────────────────────────────────────────┼──────────┐
│                      Django Backend                 │          │
│                                                     │          │
│  ┌──────────────┐   ┌──────────────────┐   ┌───────┴───────┐  │
│  │  REST API    │   │  Signal Handlers │   │  Django       │  │
│  │  (DRF)       │   │  (post_save,     │   │  Channels     │  │
│  │              │   │   custom signals)│   │  (ASGI)       │  │
│  └──────┬───────┘   └────────┬─────────┘   └───────┬───────┘  │
│         │                    │                     │           │
│         └────────────────────┴──────────────┐      │           │
│                                             ▼      ▼           │
│                                     ┌───────────────────┐      │
│                                     │  Notification     │      │
│                                     │  Service Layer    │      │
│                                     └────────┬──────────┘      │
│                                              │                  │
│         ┌────────────────────────────────────┼─────────┐       │
│         │                                    │         │       │
│         ▼                                    ▼         ▼       │
│  ┌─────────────┐                    ┌──────────────┐ ┌──────┐  │
│  │  PostgreSQL │                    │  Redis       │ │      │  │
│  │  (Notif.    │                    │  (Channel    │ │      │  │
│  │   storage)  │                    │   Layer +    │ │      │  │
│  └─────────────┘                    │   Cache)     │ │      │  │
│                                     └──────────────┘ └──────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Real-time transport | **Django Channels + WebSockets** | Native Django integration; bidirectional; widely supported |
| Channel layer / message broker | **Redis** (via `channels-redis`) | Low latency pub/sub; also used for caching badge counts |
| REST API | **Django REST Framework (DRF)** | Existing pattern in Django ecosystem |
| Frontend state | **React Context + `useReducer`** (or Zustand) | Lightweight; avoids Redux overhead for this feature |
| WebSocket client | **Native browser WebSocket API** wrapped in a custom hook | No additional dependency needed |

### Data Flow — New Notification (Happy Path)

```
1. User B comments on User A's post
        │
        ▼
2. Django post_save signal fires on Comment model
        │
        ▼
3. NotificationService.create() is called
   ├── Persists Notification record in PostgreSQL
   └── Publishes message to Redis channel group: "notifications_user_{A_id}"
        │
        ▼
4. Django Channels Consumer (connected to Redis channel layer)
   receives the message and sends it over WebSocket to User A's browser
        │
        ▼
5. React WebSocket client receives JSON notification event
        │
        ▼
6. NotificationContext dispatches ADD_NOTIFICATION + INCREMENT_BADGE
        │
        ▼
7. Bell icon badge count increments; notification appears in drawer
```

---

## Low-Level Design

### 1. Database Schema

#### `notifications_notification` Table

```sql
CREATE TABLE notifications_notification (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id    INTEGER NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
    actor_id        INTEGER REFERENCES auth_user(id) ON DELETE SET NULL,
    verb            VARCHAR(64) NOT NULL,          -- e.g. "commented_on", "liked", "sent_message"
    target_type     VARCHAR(32),                   -- e.g. "post", "comment", "message"
    target_id       INTEGER,                       -- FK to the relevant object (generic)
    target_url      VARCHAR(512),                  -- Pre-computed navigation URL
    description     TEXT,                          -- Human-readable snippet
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at         TIMESTAMPTZ
);

CREATE INDEX idx_notif_recipient_unread
    ON notifications_notification (recipient_id, is_read, created_at DESC);

CREATE INDEX idx_notif_recipient_created
    ON notifications_notification (recipient_id, created_at DESC);
```

**Design notes:**
- `verb` is a string enum kept in application code (avoids migration for new verbs).
- `target_type` + `target_id` forms a soft generic relation (avoids Django `GenericForeignKey` complexity but achieves the same result).
- `target_url` is eagerly computed at creation time so the frontend doesn't need to reconstruct it.

### 2. Django Models

```python
# notifications/models.py

import uuid
from django.db import models
from django.conf import settings


class NotificationVerb(models.TextChoices):
    COMMENTED = "commented_on", "commented on"
    LIKED     = "liked",        "liked"
    DM        = "sent_message", "sent you a message"


class Notification(models.Model):
    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    recipient    = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="notifications",
        on_delete=models.CASCADE
    )
    actor        = models.ForeignKey(
        settings.AUTH_USER_MODEL, related_name="sent_notifications",
        null=True, on_delete=models.SET_NULL
    )
    verb         = models.CharField(max_length=64, choices=NotificationVerb.choices)
    target_type  = models.CharField(max_length=32, blank=True, default="")
    target_id    = models.PositiveIntegerField(null=True, blank=True)
    target_url   = models.CharField(max_length=512, blank=True, default="")
    description  = models.TextField(blank=True, default="")
    is_read      = models.BooleanField(default=False, db_index=True)
    created_at   = models.DateTimeField(auto_now_add=True)
    read_at      = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["recipient", "is_read", "-created_at"]),
        ]

    def __str__(self):
        return f"{self.actor} {self.verb} → {self.recipient} [{self.id}]"
```

### 3. Notification Service Layer

```python
# notifications/services.py

from django.utils import timezone
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from .models import Notification, NotificationVerb
from .serializers import NotificationSerializer


CHANNEL_LAYER = get_channel_layer()


def _user_group_name(user_id: int) -> str:
    return f"notifications_user_{user_id}"


def create_notification(
    *,
    recipient,
    actor,
    verb: str,
    target_type: str = "",
    target_id: int | None = None,
    target_url: str = "",
    description: str = "",
) -> Notification:
    """
    Persist a notification and push it to the recipient's WebSocket group.
    """
    notif = Notification.objects.create(
        recipient=recipient,
        actor=actor,
        verb=verb,
        target_type=target_type,
        target_id=target_id,
        target_url=target_url,
        description=description,
    )
    _push_to_websocket(notif)
    return notif


def _push_to_websocket(notif: Notification) -> None:
    group_name = _user_group_name(notif.recipient_id)
    payload = {
        "type": "notification.new",
        "notification": NotificationSerializer(notif).data,
    }
    async_to_sync(CHANNEL_LAYER.group_send)(group_name, payload)


def mark_read(*, user, notification_id) -> Notification:
    notif = Notification.objects.get(id=notification_id, recipient=user)
    if not notif.is_read:
        notif.is_read = True
        notif.read_at = timezone.now()
        notif.save(update_fields=["is_read", "read_at"])
    return notif


def mark_all_read(*, user) -> int:
    now = timezone.now()
    count = Notification.objects.filter(
        recipient=user, is_read=False
    ).update(is_read=True, read_at=now)
    return count


def get_unread_count(*, user) -> int:
    return Notification.objects.filter(recipient=user, is_read=False).count()
```

### 4. Django Channels Consumer

```python
# notifications/consumers.py

import json
from channels.generic.websocket import AsyncWebsocketConsumer
from channels.db import database_sync_to_async
from django.contrib.auth.models import AnonymousUser


class NotificationConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for real-time notifications.
    Clients connect to: ws://<host>/ws/notifications/
    """

    async def connect(self):
        user = self.scope.get("user")
        if not user or isinstance(user, AnonymousUser):
            await self.close(code=4001)  # Unauthorized
            return

        self.group_name = f"notifications_user_{user.id}"
        await self.channel_layer.group_add(self.group_name, self.channel_name)
        await self.accept()

        # Send initial unread count on connect
        unread_count = await self._get_unread_count(user)
        await self.send(text_data=json.dumps({
            "type": "init",
            "unread_count": unread_count,
        }))

    async def disconnect(self, close_code):
        if hasattr(self, "group_name"):
            await self.channel_layer.group_discard(self.group_name, self.channel_name)

    async def receive(self, text_data):
        """
        Handle client-to-server messages (e.g., mark-read requests).
        """
        data = json.loads(text_data)
        msg_type = data.get("type")

        if msg_type == "mark_read":
            notif_id = data.get("notification_id")
            user = self.scope["user"]
            await self._mark_read(user, notif_id)
            await self.send(text_data=json.dumps({
                "type": "mark_read_ack",
                "notification_id": notif_id,
            }))

    # --- Channel layer message handlers ---

    async def notification_new(self, event):
        """Called when group_send dispatches a 'notification.new' message."""
        await self.send(text_data=json.dumps(event))

    # --- Database helpers ---

    @database_sync_to_async
    def _get_unread_count(self, user):
        from .services import get_unread_count
        return get_unread_count(user=user)

    @database_sync_to_async
    def _mark_read(self, user, notification_id):
        from .services import mark_read
        try:
            mark_read(user=user, notification_id=notification_id)
        except Exception:
            pass
```

### 5. ASGI Routing

```python
# project/routing.py

from django.urls import re_path
from notifications.consumers import NotificationConsumer

websocket_urlpatterns = [
    re_path(r"^ws/notifications/$", NotificationConsumer.as_asgi()),
]
```

```python
# project/asgi.py

import os
import django
from django.core.asgi import get_asgi_application
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.auth import AuthMiddlewareStack
from .routing import websocket_urlpatterns

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")
django.setup()

application = ProtocolTypeRouter({
    "http": get_asgi_application(),
    "websocket": AuthMiddlewareStack(
        URLRouter(websocket_urlpatterns)
    ),
})
```

### 6. Signal Handlers (Trigger Notifications)

```python
# notifications/signals.py

from django.db.models.signals import post_save
from django.dispatch import receiver, Signal
from posts.models import Comment, Like
from messages.models import DirectMessage
from .services import create_notification
from .models import NotificationVerb

# Custom signal for DMs
dm_sent = Signal()  # Provides: sender_instance, recipient


@receiver(post_save, sender=Comment)
def on_comment_created(sender, instance, created, **kwargs):
    if not created:
        return
    post_author = instance.post.author
    if instance.author == post_author:
        return  # Don't notify self
    create_notification(
        recipient=post_author,
        actor=instance.author,
        verb=NotificationVerb.COMMENTED,
        target_type="post",
        target_id=instance.post.id,
        target_url=f"/posts/{instance.post.id}#comment-{instance.id}",
        description=instance.body[:120],
    )


@receiver(post_save, sender=Like)
def on_like_created(sender, instance, created, **kwargs):
    if not created:
        return
    content_author = instance.content_object.author
    if instance.user == content_author:
        return
    create_notification(
        recipient=content_author,
        actor=instance.user,
        verb=NotificationVerb.LIKED,
        target_type=instance.content_type.model,
        target_id=instance.object_id,
        target_url=f"/{instance.content_type.model}s/{instance.object_id}",
        description="",
    )


@receiver(dm_sent)
def on_dm_sent(sender, sender_instance, recipient, **kwargs):
    if sender_instance == recipient:
        return
    create_notification(
        recipient=recipient,
        actor=sender_instance,
        verb=NotificationVerb.DM,
        target_type="conversation",
        target_id=kwargs.get("conversation_id"),
        target_url=f"/messages/{kwargs.get('conversation_id')}",
        description=kwargs.get("preview", ""),
    )
```

### 7. REST API Endpoints (DRF)

```
GET    /api/notifications/             — List notifications (paginated)
PATCH  /api/notifications/<id>/read/  — Mark single notification as read
POST   /api/notifications/read-all/   — Mark all as read
GET    /api/notifications/unread-count/ — Return { "count": N } (cached)
```

```python
# notifications/views.py (DRF)

from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from django.core.cache import cache
from .models import Notification
from .serializers import NotificationSerializer
from . import services


class NotificationListView(generics.ListAPIView):
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Notification.objects.filter(
            recipient=self.request.user
        ).select_related("actor")


@api_view(["PATCH"])
@permission_classes([IsAuthenticated])
def mark_read_view(request, pk):
    try:
        notif = services.mark_read(user=request.user, notification_id=pk)
    except Notification.DoesNotExist:
        return Response(status=status.HTTP_404_NOT_FOUND)
    return Response(NotificationSerializer(notif).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def mark_all_read_view(request):
    count = services.mark_all_read(user=request.user)
    cache.delete(f"unread_count_{request.user.id}")
    return Response({"marked_read": count})


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def unread_count_view(request):
    cache_key = f"unread_count_{request.user.id}"
    count = cache.get(cache_key)
    if count is None:
        count = services.get_unread_count(user=request.user)
        cache.set(cache_key, count, timeout=30)  # 30-second cache
    return Response({"count": count})
```

### 8. Serializer

```python
# notifications/serializers.py

from rest_framework import serializers
from django.contrib.auth import get_user_model
from .models import Notification

User = get_user_model()


class ActorSerializer(serializers.ModelSerializer):
    avatar_url = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ["id", "username", "avatar_url"]

    def get_avatar_url(self, obj):
        return getattr(obj, "avatar_url", None)


class NotificationSerializer(serializers.ModelSerializer):
    actor = ActorSerializer(read_only=True)
    time_ago = serializers.SerializerMethodField()

    class Meta:
        model = Notification
        fields = [
            "id", "actor", "verb", "target_type", "target_id",
            "target_url", "description", "is_read", "created_at", "time_ago"
        ]

    def get_time_ago(self, obj):
        from django.utils.timesince import timesince
        return timesince(obj.created_at)
```

### 9. React Frontend

#### Directory Structure

```
src/
  features/
    notifications/
      NotificationBell.tsx        ← Bell icon + badge
      NotificationDrawer.tsx      ← Dropdown/drawer list
      NotificationItem.tsx        ← Individual item row
      useNotifications.ts         ← Custom hook (WebSocket + REST)
      notificationContext.tsx     ← Context + reducer
      notificationApi.ts          ← REST API calls
      types.ts                    ← TypeScript types
```

#### Types

```typescript
// features/notifications/types.ts

export interface Actor {
  id: number;
  username: string;
  avatar_url: string | null;
}

export interface Notification {
  id: string;
  actor: Actor;
  verb: string;
  target_type: string;
  target_id: number | null;
  target_url: string;
  description: string;
  is_read: boolean;
  created_at: string;
  time_ago: string;
}

export interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  isOpen: boolean;
  isLoading: boolean;
}

export type NotificationAction =
  | { type: "ADD_NOTIFICATION"; payload: Notification }
  | { type: "SET_NOTIFICATIONS"; payload: Notification[] }
  | { type: "SET_UNREAD_COUNT"; payload: number }
  | { type: "MARK_READ"; payload: string }
  | { type: "MARK_ALL_READ" }
  | { type: "TOGGLE_DRAWER" }
  | { type: "SET_LOADING"; payload: boolean };
```

#### Context + Reducer

```typescript
// features/notifications/notificationContext.tsx

import React, { createContext, useContext, useReducer } from "react";
import { NotificationState, NotificationAction, Notification } from "./types";

const initialState: NotificationState = {
  notifications: [],
  unreadCount: 0,
  isOpen: false,
  isLoading: false,
};

function reducer(state: NotificationState, action: NotificationAction): NotificationState {
  switch (action.type) {
    case "ADD_NOTIFICATION":
      return {
        ...state,
        notifications: [action.payload, ...state.notifications],
        unreadCount: state.unreadCount + 1,
      };
    case "SET_NOTIFICATIONS":
      return { ...state, notifications: action.payload };
    case "SET_UNREAD_COUNT":
      return { ...state, unreadCount: action.payload };
    case "MARK_READ":
      return {
        ...state,
        notifications: state.notifications.map((n) =>
          n.id === action.payload ? { ...n, is_read: true } : n
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
      };
    case "MARK_ALL_READ":
      return {
        ...state,
        notifications: state.notifications.map((n) => ({ ...n, is_read: true })),
        unreadCount: 0,
      };
    case "TOGGLE_DRAWER":
      return { ...state, isOpen: !state.isOpen };
    case "SET_LOADING":
      return { ...state, isLoading: action.payload };
    default:
      return state;
  }
}

const NotificationContext = createContext<{
  state: NotificationState;
  dispatch: React.Dispatch<NotificationAction>;
} | null>(null);

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  return (
    <NotificationContext.Provider value={{ state, dispatch }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotificationContext() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotificationContext must be inside NotificationProvider");
  return ctx;
}
```

#### Custom Hook (WebSocket + REST)

```typescript
// features/notifications/useNotifications.ts

import { useEffect, useRef, useCallback } from "react";
import { useNotificationContext } from "./notificationContext";
import { fetchNotifications, fetchUnreadCount, apiMarkRead, apiMarkAllRead } from "./notificationApi";

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws/notifications/`;

export function useNotifications() {
  const { state, dispatch } = useNotificationContext();
  const wsRef = useRef<WebSocket | null>(null);

  // Establish WebSocket connection
  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // Connection open — initial unread count sent by server via 'init' message
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "init") {
        dispatch({ type: "SET_UNREAD_COUNT", payload: data.unread_count });
      } else if (data.type === "notification.new") {
        dispatch({ type: "ADD_NOTIFICATION", payload: data.notification });
      } else if (data.type === "mark_read_ack") {
        dispatch({ type: "MARK_READ", payload: data.notification_id });
      }
    };

    ws.onerror = () => {
      console.error("Notification WebSocket error");
    };

    ws.onclose = () => {
      // Implement exponential back-off reconnect here if needed
    };

    return () => {
      ws.close();
    };
  }, [dispatch]);

  // Load initial notifications via REST
  useEffect(() => {
    dispatch({ type: "SET_LOADING", payload: true });
    fetchNotifications()
      .then((data) => dispatch({ type: "SET_NOTIFICATIONS", payload: data }))
      .finally(() => dispatch({ type: "SET_LOADING", payload: false }));
  }, [dispatch]);

  const markRead = useCallback(
    (id: string) => {
      // Optimistic update
      dispatch({ type: "MARK_READ", payload: id });
      // Tell server via WebSocket (or REST fallback)
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "mark_read", notification_id: id }));
      } else {
        apiMarkRead(id);
      }
    },
    [dispatch]
  );

  const markAllRead = useCallback(() => {
    dispatch({ type: "MARK_ALL_READ" });
    apiMarkAllRead();
  }, [dispatch]);

  const toggleDrawer = useCallback(() => {
    dispatch({ type: "TOGGLE_DRAWER" });
  }, [dispatch]);

  return { state, markRead, markAllRead, toggleDrawer };
}
```

#### Bell Icon Component

```typescript
// features/notifications/NotificationBell.tsx

import React from "react";
import { BellIcon } from "@heroicons/react/24/outline";
import { useNotifications } from "./useNotifications";
import { NotificationDrawer } from "./NotificationDrawer";

export function NotificationBell() {
  const { state, markRead, markAllRead, toggleDrawer } = useNotifications();

  return (
    <div className="relative">
      <button
        onClick={toggleDrawer}
        aria-label={`Notifications${state.unreadCount > 0 ? `, ${state.unreadCount} unread` : ""}`}
        className="relative p-2 text-gray-600 hover:text-gray-900"
      >
        <BellIcon className="h-6 w-6" />
        {state.unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center
                           rounded-full bg-red-500 text-[10px] font-bold text-white">
            {state.unreadCount > 99 ? "99+" : state.unreadCount}
          </span>
        )}
      </button>

      {state.isOpen && (
        <NotificationDrawer
          notifications={state.notifications}
          isLoading={state.isLoading}
          onMarkRead={markRead}
          onMarkAllRead={markAllRead}
          onClose={toggleDrawer}
        />
      )}
    </div>
  );
}
```

### 10. Settings & Dependencies

```python
# settings.py additions

INSTALLED_APPS = [
    ...
    "channels",
    "notifications",
]

ASGI_APPLICATION = "project.asgi.application"

CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [("redis", 6379)],
            "capacity": 1500,
            "expiry": 10,
        },
    }
}

CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": "redis://redis:6379/1",
        "OPTIONS": {"CLIENT_CLASS": "django_redis.client.DefaultClient"},
    }
}
```

```
# requirements additions
channels>=4.0
channels-redis>=4.0
daphne>=4.0          # ASGI server
django-redis>=5.0
djangorestframework>=3.14
```

```json
// package.json additions (React)
{
  "@heroicons/react": "^2.0"
}
```

---

## Implementation Plan

### Phases Overview

```
Phase 1: Backend Foundation     (Days 1–4)
Phase 2: WebSocket Layer        (Days 5–7)
Phase 3: Frontend Core          (Days 8–11)
Phase 4: Integration & Polish   (Days 12–14)
Phase 5: Testing & Hardening    (Days 15–17)
Phase 6: Deployment Prep        (Day 18)
```

---

### Phase 1: Backend Foundation (Days 1–4)

**Goal:** Notification model, service layer, and REST API working.

| Day | Task | Owner | Done? |
|-----|------|-------|-------|
| 1 | Create `notifications` Django app; write `Notification` model + migration | Backend | [ ] |
| 1 | Write `NotificationSerializer` | Backend | [ ] |
| 2 | Implement `NotificationService` (`create`, `mark_read`, `mark_all_read`, `get_unread_count`) | Backend | [ ] |
| 2 | Write unit tests for service layer (pytest + factory_boy) | Backend | [ ] |
| 3 | Implement REST API views + URL routing | Backend | [ ] |
| 3 | Write signal handlers for Comment, Like, DirectMessage | Backend | [ ] |
| 4 | API integration tests (DRF test client) | Backend | [ ] |
| 4 | Register signals in `notifications/apps.py` `ready()` | Backend | [ ] |

**Acceptance Criteria — Phase 1:**
- `GET /api/notifications/` returns paginated notification list for authenticated user.
- Creating a Comment via the API results in a Notification record in the database.
- All service unit tests pass.

---

### Phase 2: WebSocket Layer (Days 5–7)

**Goal:** Real-time delivery of notifications via Django Channels + Redis.

| Day | Task | Owner | Done? |
|-----|------|-------|-------|
| 5 | Install and configure `channels`, `channels-redis`, `daphne` | Backend | [ ] |
| 5 | Write `NotificationConsumer` (connect, disconnect, receive, `notification_new` handler) | Backend | [ ] |
| 5 | Configure ASGI application with `ProtocolTypeRouter` | Backend | [ ] |
| 6 | Set up Redis in Docker Compose (if local) and staging | DevOps | [ ] |
| 6 | Add `AuthMiddlewareStack` + JWT/session auth for WebSocket handshake | Backend | [ ] |
| 7 | Manual smoke test: open two browser tabs, trigger comment → verify WS push | Backend | [ ] |
| 7 | Write async consumer tests using `channels.testing.WebsocketCommunicator` | Backend | [ ] |

**Acceptance Criteria — Phase 2:**
- Connected authenticated client receives a WebSocket message within 1 second of a comment being created.
- Unauthenticated WebSocket connection is rejected with code 4001.
- Consumer tests pass in CI.

---

### Phase 3: Frontend Core (Days 8–11)

**Goal:** Bell icon, badge, drawer, and live updates in React.

| Day | Task | Owner | Done? |
|-----|------|-------|-------|
| 8 | Create `features/notifications/` directory; define TypeScript types | Frontend | [ ] |
| 8 | Implement `NotificationContext` + reducer | Frontend | [ ] |
| 8 | Wrap app root with `NotificationProvider` | Frontend | [ ] |
| 9 | Implement `notificationApi.ts` (REST calls) | Frontend | [ ] |
| 9 | Implement `useNotifications` hook (WebSocket + initial REST load) | Frontend | [ ] |
| 10 | Build `NotificationBell` component (bell icon + badge) | Frontend | [ ] |
| 10 | Build `NotificationDrawer` component (list + "mark all read" button) | Frontend | [ ] |
| 10 | Build `NotificationItem` component (avatar, text, timestamp, read state) | Frontend | [ ] |
| 11 | Add bell to `Navbar` / `TopBar` component | Frontend | [ ] |
| 11 | Unit tests: reducer logic; component render tests with React Testing Library | Frontend | [ ] |

**Acceptance Criteria — Phase 3:**
- Bell icon renders in navbar with correct badge count from REST API on page load.
- Drawer opens/closes on bell click and shows notification list.
- Clicking "mark all read" clears the badge.

---

### Phase 4: Integration & Polish (Days 12–14)

**Goal:** End-to-end flow working; UX refinements.

| Day | Task | Owner | Done? |
|-----|------|-------|-------|
| 12 | End-to-end test: trigger comment → see live notification in React UI | Full stack | [ ] |
| 12 | Implement WebSocket reconnect logic (exponential back-off) in `useNotifications` | Frontend | [ ] |
| 13 | Clicking notification item navigates to `target_url` and marks it read | Frontend | [ ] |
| 13 | Notification item UX: unread vs. read visual distinction (background color) | Frontend | [ ] |
| 13 | Drawer: scroll-to-load more (pagination) using Intersection Observer | Frontend | [ ] |
| 14 | Accessibility audit: ARIA labels, keyboard navigation for drawer | Frontend | [ ] |
| 14 | Animate badge count change (subtle pulse/fade) | Frontend | [ ] |

**Acceptance Criteria — Phase 4:**
- Full user journey works: User B comments → User A (logged in) sees badge increment and notification in drawer in real time.
- Clicking notification opens the correct page.
- Page reload preserves unread state.

---

### Phase 5: Testing & Hardening (Days 15–17)

**Goal:** Confidence the feature is correct, secure, and performant.

| Day | Task | Notes |
|-----|------|-------|
| 15 | **Security:** Verify users can only read/modify their own notifications (authorization tests) | |
| 15 | **Security:** Ensure WebSocket auth middleware rejects tokens from logged-out sessions | |
| 16 | **Load test:** Use `locust` to simulate 500 concurrent WS connections; measure Redis channel layer throughput | Target: p95 < 1s delivery |
| 16 | **DB:** Add index, run `EXPLAIN ANALYZE` on unread_count query | |
| 17 | **Self-notification guard:** Confirm users never receive notifications about their own actions | |
| 17 | **Idempotency:** Ensure duplicate signal fires (e.g., double-save) do not create duplicate notifications | Add DB-level unique constraint or service-level dedup |
| 17 | Regression test suite run in CI; fix any failures | |

---

### Phase 6: Deployment Prep (Day 18)

| Task | Notes |
|------|-------|
| Switch web server from Gunicorn (WSGI) to Daphne or Uvicorn (ASGI) | Required for WebSocket support |
| Update Nginx config: proxy WebSocket upgrade headers (`Upgrade`, `Connection`) | |
| Provision Redis instance in production (ElastiCache, Redis Cloud, etc.) | |
| Set `CHANNEL_LAYERS` to point at production Redis | |
| Database migration: `python manage.py migrate notifications` | |
| Feature flag rollout (optional): enable for 10% of users first | |
| Monitor: Datadog / Sentry alerts on WebSocket error rate and WS connection count | |

---

### Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Redis unavailability causes silent notification loss | Low | High | Add dead-letter queue or fallback to REST polling |
| ASGI migration breaks existing HTTP functionality | Medium | High | Thoroughly test all existing endpoints after migration; run in parallel initially |
| Spam notifications (flood of likes) | Medium | Medium | Rate-limit notification creation per actor-recipient-verb (e.g., max 1 "like" notification per object) |
| WebSocket connections not cleaned up (memory leak) | Low | Medium | Monitor channel layer group membership; set `expiry` in channel layer config |
| Browser doesn't support WebSocket | Very Low | Low | REST polling fallback (`/api/notifications/unread-count/`) on WS error |

---

### Dependencies & Prerequisites

- Redis must be provisioned before Phase 2 begins.
- `Comment`, `Like`, and `DirectMessage` models must be stable (schema won't change) before signal handlers are written.
- The frontend must have an authenticated HTTP session or JWT token accessible to the WebSocket handshake (verify `AuthMiddlewareStack` works with the existing auth strategy).
- DevOps must update the deployment pipeline to use an ASGI server (Daphne / Uvicorn + Gunicorn ASGI worker) before Phase 6.

---

### Definition of Done

- [ ] All Phase 1–5 acceptance criteria are met.
- [ ] Unit test coverage >= 80% for `notifications` app.
- [ ] No P0/P1 security findings from authorization tests.
- [ ] Load test shows p95 delivery latency < 1 second at 500 concurrent connections.
- [ ] Feature deployed to staging and validated end-to-end by QA.
- [ ] Deployment runbook updated.
- [ ] Monitoring dashboards created for WebSocket connection count and error rate.

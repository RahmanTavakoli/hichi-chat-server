# 📡 Secure Real-Time Messaging Server — Client Integration Guide

> **Stack:** Node.js · Express · SQLite (Prisma) · WebSockets (`ws`)
> **Architecture:** Offline-First · Server as Router & Queue · MVC · JWT Auth

---

## 🌐 Language / زبان

- [English Documentation](#english-documentation)
- [مستندات فارسی](#مستندات-فارسی)

---

<br />

# English Documentation

---

## Table of Contents

1. [Introduction & Setup](#1-introduction--setup)
2. [Authentication / The Handshake](#2-authentication--the-handshake)
3. [Event Catalog](#3-event-catalog)
4. [Offline-First Architecture (Important)](#4-offline-first-architecture-important)

---

## 1. Introduction & Setup

### What Is This Server?

This is a **real-time, offline-first messaging server**. It handles user authentication through a REST API backed by **SQLite (Prisma)**, and delivers all chat functionality over a secure, authenticated WebSocket connection.

> ⚠️ **Critical — Architecture:**
> The server acts strictly as a **Router and Pending Queue**. There is **NO database persistence for chat history** on the server. History must be stored locally on the client (e.g., using `IndexedDB / Dexie.js`). If a recipient is offline, the server holds the message in RAM temporarily until they reconnect.

### Architectural Overview

````text
┌─────────────────────────────────────────────────────────────────┐
│                        React Client                             │
│  (History Stored Locally via Dexie.js / IndexedDB)              │
│                                                                 │
│  [REST /api/v1/auth]  ──────────►  Login / Register / Refresh   │
│  [WebSocket wss://…]  ◄─────────►  Real-time Message Routing    │
└─────────────────────────────────────────────────────────────────┘
                                 │
                 [JWT Handshake & Message Payload]
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Node.js Backend                           │
│                                                                 │
│  1. SQLite (Prisma) ────────► User Auth & Profiles Only         │
│  2. RAM (Pending Queue) ────► Holds un-delivered messages       │
└─────────────────────────────────────────────────────────────────┘

### Installation

The server uses the native browser `WebSocket` API. **No additional library is required** for
basic use. However, for a more ergonomic developer experience with automatic reconnection and
event management, you may optionally use `socket.io-client` **only if the server is configured
with Socket.IO** (confirm with your backend team). The examples below use the **native
`WebSocket` API**, which is universally supported.

```bash
# No additional packages required for native WebSocket.
# If your project uses socket.io-client (confirm with backend team first):
npm install socket.io-client
````

### Environment Configuration

Create a `.env.local` file in your React project root:

```env
NODE_ENV=development
PORT=

# Generate with: openssl rand -hex 64
JWT_SECRET=your jwt accessToken secret
JWT_EXPIRES_IN=jwt accessToken expire duration (m)

# Generate with: openssl rand -hex 64
JWT_REFRESH_SECRET=jwt refreshToken secret
JWT_REFRESH_EXPIRES_IN=jwt refreshToken expire duration (d)

# Generate with: openssl rand -hex 32
COOKIE_SECRET=your cookie secret

# Comma-separated, no trailing slash
ALLOWED_ORIGINS=domains you must allowed to access server

# In-memory store limits
MSG_STORE_MAX_ROOMS= nuber
MSG_STORE_MAX_PER_ROOM=number
MSG_STORE_TTL_MS=number (ms)
# 1year store pending msg
MSG_PENDING_TTL_MS=31536000000
```

> 📌 **Note:** Use `ws://` for local development and `wss://` (WebSocket Secure) in all
> production, staging, and preview environments. Never use an unencrypted `ws://` connection
> against a production server.

### Connection URL Structure

```
wss://api.yourdomain.com?token=<YOUR_JWT_ACCESS_TOKEN>
│      │                  │
│      │                  └── Short-lived access token from /auth/login
│      └──────────────────── Your API domain
└─────────────────────────── Secure WebSocket protocol
```

---

## 2. Authentication / The Handshake

### How It Works

Authentication happens **at the WebSocket handshake phase** — before the connection is
established — not after. The server uses a `verifyClient` hook to inspect every incoming
upgrade request. If a valid JWT is not present, the **TCP connection is rejected immediately**
with an HTTP `401 Unauthorized` status. The socket is never opened.

```
Client                              Server
  │                                   │
  │  ── HTTP Upgrade Request ────────►│
  │     + ?token=<JWT>                │
  │                                   │  verifyClient():
  │                                   │  ├─ Token missing?  → 401, DROP
  │                                   │  ├─ Token expired?  → 401, DROP
  │                                   │  └─ Token valid?    → 101, UPGRADE ✓
  │  ◄── 101 Switching Protocols ─────│
  │                                   │
  │  ═══ WebSocket Connection Open ═══│
```

> 🔴 **Hard Rule:** Your React client **must** obtain a valid JWT from the REST login endpoint
> before attempting a WebSocket connection. Attempting to connect without a token will result in
> an immediate connection failure. The client is expected to handle this gracefully (e.g., redirect
> to the login page).

### Step 1 — Obtain a JWT via REST Login

```typescript
// src/api/auth.ts

const API_URL = import.meta.env.VITE_API_URL;

interface LoginResponse {
  status: 'success';
  data: {
    userId: string;
    username: string;
  };
}

/**
 * Authenticates the user against the REST API.
 * The server sets the JWT as a signed HttpOnly cookie automatically.
 * For clients that read the token from cookies, no further action is needed.
 * If the token is returned in the body, store it in memory (never localStorage).
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Required to send/receive HttpOnly cookies
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message ?? 'Login failed');
  }

  return response.json();
}
```

### Step 2 — Pass the Token During WebSocket Connection

The server accepts the JWT in two ways (listed in priority order):

| Method                    | Mechanism                                       | Recommended For             |
| ------------------------- | ----------------------------------------------- | --------------------------- |
| **1. Cookie** (preferred) | `ws_token` cookie set by the server after login | Browser clients (automatic) |
| **2. Query Parameter**    | `?token=<jwt>` appended to the WebSocket URL    | Native/mobile clients       |

> ⚠️ **Security Note on Query Parameters:** The token in a query string may appear in server
> access logs and browser history. It is acceptable for short-lived access tokens (15-minute
> expiry), but ensure your token lifetime is kept minimal.

```typescript
// src/lib/websocket.ts

/**
 * Creates an authenticated WebSocket connection.
 * Pass the JWT token obtained from the login endpoint.
 */
export function createAuthenticatedSocket(token: string): WebSocket {
  const WS_URL = import.meta.env.VITE_WS_URL;

  // The token is appended as a query parameter for non-cookie clients
  const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  socket.onopen = () => console.log('[WS] Connection established.');
  socket.onerror = (err) => console.error('[WS] Connection error:', err);
  socket.onclose = (event) => {
    if (event.code === 1006) {
      // 1006 = Abnormal closure. Likely caused by a failed handshake (invalid token).
      console.error(
        '[WS] Connection rejected. Token may be invalid or expired.',
      );
    }
  };

  return socket;
}
```

---

## 3. Event Catalog

All communication after the handshake uses **JSON-serialized string messages** over the
WebSocket channel. There are two directions: events you **emit** (Client → Server) and events
you **listen** to (Server → Client).

### 3.1 — Events to Emit (Client → Server)

Always serialize your payload with `JSON.stringify()` before calling `socket.send()`.

Event Type,Payload,Description
send_message,"{ to: string, content: string, localId: string }",Sends a message. localId is a client-generated UUID for UI tracking.
typing_start,{ to: string },Notifies the peer that the user started typing.
typing_stop,{ to: string },Notifies the peer that typing stopped.
ack_pending,{ ids: string[] },Acknowledges receipt of offline messages so the server deletes them from RAM.
ping,{ },Keep-alive heartbeat (send every 25 seconds).

Event Type,Payload,Description
send_message,"{ to: string, content: string, localId: string }",Sends a message. localId is a client-generated UUID for UI tracking.
typing_start,{ to: string },Notifies the peer that the user started typing.
typing_stop,{ to: string },Notifies the peer that typing stopped.
ack_pending,{ ids: string[] },Acknowledges receipt of offline messages so the server deletes them from RAM.
ping,{ },Keep-alive heartbeat (send every 25 seconds).

---

#### `send_message`

Sends a new chat message to a specific recipient.

| Field     | Type     | Required | Description                                 |
| --------- | -------- | -------- | ------------------------------------------- |
| `type`    | `string` | ✅       | Must be exactly `"send_message"`            |
| `roomId`  | `string` | ✅       | Target room ID (alphanumeric, max 64 chars) |
| `content` | `string` | ✅       | The message text (max 2,000 characters)     |

```typescript
// Emit: send a message
const payload = {
  type: 'send_message',
  roomId: 'room_general',
  content: 'Hello, world!',
};

socket.send(JSON.stringify(payload));
```

---

#### `join_room`

Subscribes the client to a room and fetches the last 50 messages from in-memory history.

| Field    | Type     | Required | Description                   |
| -------- | -------- | -------- | ----------------------------- |
| `type`   | `string` | ✅       | Must be exactly `"join_room"` |
| `roomId` | `string` | ✅       | The room to join              |

```typescript
// Emit: join a room
socket.send(JSON.stringify({ type: 'join_room', roomId: 'room_general' }));
```

---

#### `leave_room`

Unsubscribes the client from a room. The client will no longer receive broadcasts for this room.

| Field    | Type     | Required | Description                    |
| -------- | -------- | -------- | ------------------------------ |
| `type`   | `string` | ✅       | Must be exactly `"leave_room"` |
| `roomId` | `string` | ✅       | The room to leave              |

```typescript
// Emit: leave a room
socket.send(JSON.stringify({ type: 'leave_room', roomId: 'room_general' }));
```

---

#### `get_history`

Requests the last 50 messages for a room (from in-memory store).

| Field    | Type     | Required | Description                     |
| -------- | -------- | -------- | ------------------------------- |
| `type`   | `string` | ✅       | Must be exactly `"get_history"` |
| `roomId` | `string` | ✅       | The room whose history to fetch |

```typescript
// Emit: request history
socket.send(JSON.stringify({ type: 'get_history', roomId: 'room_general' }));
```

---

### 3.2 — Events to Listen (Server → Client)

Always parse incoming messages with `JSON.parse()` inside the `onmessage` handler.

---

#### `room_joined`

Fired after a successful `join_room` emit. Includes recent in-memory history.

```typescript
// Incoming payload structure
interface RoomJoinedEvent {
  type: 'room_joined';
  roomId: string;
  history: ChatMessage[]; // Last 50 messages, oldest first
}

interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  content: string; // Already XSS-sanitized by the server
  timestamp: number; // Unix timestamp in milliseconds
}
```

---

#### `new_message`

Broadcast to all clients currently in the same room when any member sends a message.

```typescript
// Incoming payload structure
interface NewMessageEvent {
  type: 'new_message';
  message: ChatMessage;
}
```

---

#### `history`

Response to a `get_history` emit.

```typescript
// Incoming payload structure
interface HistoryEvent {
  type: 'history';
  roomId: string;
  messages: ChatMessage[];
}
```

---

#### `room_left`

Confirmation that the client has successfully left a room.

```typescript
// Incoming payload structure
interface RoomLeftEvent {
  type: 'room_left';
  roomId: string;
}
```

---

#### `error`

Sent when the server encounters a problem processing a client's message.

| `code` | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| `4001` | Validation error (malformed payload, invalid roomId, etc.) |
| `4002` | Not in room (tried to send a message without joining)      |
| `4003` | Rate limit exceeded                                        |
| `5000` | Internal server error                                      |

```typescript
// Incoming payload structure
interface ErrorEvent {
  type: 'error';
  message: string; // Human-readable description
  code: number; // Machine-readable error code
}
```

---

### Complete Event Reference Table

| Direction          | Event Type     | Trigger                          | Key Payload Fields     |
| ------------------ | -------------- | -------------------------------- | ---------------------- |
| ➡️ Client → Server | `join_room`    | Enter a chat room                | `roomId`               |
| ➡️ Client → Server | `leave_room`   | Exit a chat room                 | `roomId`               |
| ➡️ Client → Server | `send_message` | Send a chat message              | `roomId`, `content`    |
| ➡️ Client → Server | `get_history`  | Fetch room history               | `roomId`               |
| ⬅️ Server → Client | `room_joined`  | After joining a room             | `roomId`, `history[]`  |
| ⬅️ Server → Client | `room_left`    | After leaving a room             | `roomId`               |
| ⬅️ Server → Client | `new_message`  | When any room member sends a msg | `message`              |
| ⬅️ Server → Client | `history`      | Response to `get_history`        | `roomId`, `messages[]` |
| ⬅️ Server → Client | `error`        | On any server-side error         | `message`, `code`      |

---

## 4. React Integration Example

The following example provides a production-ready `useWebSocket` custom hook and a companion
`ChatRoom` component. The hook encapsulates the entire WebSocket lifecycle: connection,
authentication, event routing, reconnection, and cleanup.

### `useWebSocket.ts` — Custom Hook

```typescript
// src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useReducer } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  timestamp: number;
}

type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

interface WsState {
  messages: ChatMessage[];
  status: ConnectionStatus;
  error: string | null;
}

type WsAction =
  | { type: 'CONNECTING' }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'ERROR'; payload: string }
  | { type: 'HISTORY_LOADED'; payload: ChatMessage[] }
  | { type: 'MESSAGE_RECEIVED'; payload: ChatMessage }
  | { type: 'CLEAR_MESSAGES' }
  | {
      type: 'MESSAGES_READ_BY_PEER';
      payload: { chatId: string; messageIds: string[] };
    };

function wsReducer(state: WsState, action: WsAction): WsState {
  switch (action.type) {
    case 'CONNECTING':
      return { ...state, status: 'connecting', error: null };
    case 'CONNECTED':
      return { ...state, status: 'connected' };
    case 'DISCONNECTED':
      return { ...state, status: 'disconnected' };
    case 'ERROR':
      return { ...state, status: 'error', error: action.payload };
    case 'HISTORY_LOADED':
      return { ...state, messages: action.payload };
    case 'MESSAGE_RECEIVED':
      return { ...state, messages: [...state.messages, action.payload] };
    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };
    default:
      return state;
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseWebSocketOptions {
  /** JWT access token obtained from the login endpoint */
  token: string | null;
  /** The room ID to join on connection */
  roomId: string;
  /** Reconnect on unexpected disconnection (default: true) */
  autoReconnect?: boolean;
  /** Base delay in ms before reconnect attempts (default: 2000) */
  reconnectDelay?: number;
  /** Maximum number of reconnect attempts (default: 5) */
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  messages: ChatMessage[];
  status: ConnectionStatus;
  error: string | null;
  sendMessage: (content: string) => void;
  reconnect: () => void;
}

const WS_URL = import.meta.env.VITE_WS_URL as string;

export function useWebSocket({
  token,
  roomId,
  autoReconnect = true,
  reconnectDelay = 2000,
  maxReconnectAttempts = 5,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [state, dispatch] = useReducer(wsReducer, {
    messages: [],
    status: 'idle',
    error: null,
  });

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const connect = useCallback(() => {
    // Guard: do not connect without a valid token
    if (!token) {
      dispatch({ type: 'ERROR', payload: 'No authentication token provided.' });
      return;
    }

    // Guard: close any existing open socket before creating a new one
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close(1000, 'Reinitializing connection');
    }

    dispatch({ type: 'CONNECTING' });

    const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    // ── Open ────────────────────────────────────────────────────────────────
    socket.onopen = () => {
      if (!isMountedRef.current) return;
      dispatch({ type: 'CONNECTED' });
      reconnectAttemptsRef.current = 0;

      // Immediately join the desired room after connection is established
      socket.send(JSON.stringify({ type: 'join_room', roomId }));
    };

    // ── Message ─────────────────────────────────────────────────────────────
    socket.onmessage = (event: MessageEvent<string>) => {
      if (!isMountedRef.current) return;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        console.error('[WS] Failed to parse server message:', event.data);
        return;
      }

      const messageType = parsed['type'] as string;

      switch (messageType) {
        case 'room_joined': {
          const history = (parsed['history'] as ChatMessage[]) ?? [];
          dispatch({ type: 'HISTORY_LOADED', payload: history });
          break;
        }
        case 'new_message': {
          const message = parsed['message'] as ChatMessage;
          dispatch({ type: 'MESSAGE_RECEIVED', payload: message });
          break;
        }
        case 'history': {
          const messages = (parsed['messages'] as ChatMessage[]) ?? [];
          dispatch({ type: 'HISTORY_LOADED', payload: messages });
          break;
        }
        case 'error': {
          const msg = parsed['message'] as string;
          const code = parsed['code'] as number;
          console.error(`[WS] Server error (${code}):`, msg);
          dispatch({ type: 'ERROR', payload: `[${code}] ${msg}` });
          break;
        }
        default:
          break;
      }
    };

    // ── Error ────────────────────────────────────────────────────────────────
    socket.onerror = () => {
      if (!isMountedRef.current) return;
      dispatch({ type: 'ERROR', payload: 'WebSocket connection error.' });
    };

    // ── Close ────────────────────────────────────────────────────────────────
    socket.onclose = (event: CloseEvent) => {
      if (!isMountedRef.current) return;
      dispatch({ type: 'DISCONNECTED' });

      // Code 1000 = clean/intentional close. Do not reconnect.
      // Code 1006 = abnormal close, likely a failed handshake (bad token).
      const isCleanClose = event.code === 1000;
      const isAuthFailure = event.code === 1006 || event.code === 4001;

      if (isAuthFailure) {
        dispatch({
          type: 'ERROR',
          payload: 'Authentication failed. Please log in again.',
        });
        return;
      }

      if (!isCleanClose && autoReconnect) {
        const attempts = reconnectAttemptsRef.current;

        if (attempts < maxReconnectAttempts) {
          // Exponential backoff: 2s, 4s, 8s, 16s, 32s
          const delay = reconnectDelay * Math.pow(2, attempts);
          console.warn(
            `[WS] Disconnected. Reconnecting in ${delay}ms... (attempt ${attempts + 1})`,
          );
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else {
          dispatch({
            type: 'ERROR',
            payload: `Failed to reconnect after ${maxReconnectAttempts} attempts.`,
          });
        }
      }
    };
  }, [token, roomId, autoReconnect, reconnectDelay, maxReconnectAttempts]);

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    connect();

    return () => {
      isMountedRef.current = false;
      // Clear any pending reconnect timer on unmount
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      // Clean close on unmount — code 1000 prevents reconnect attempts
      socketRef.current?.close(1000, 'Component unmounted');
    };
  }, [connect]);

  // ── sendMessage ────────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    (content: string) => {
      const socket = socketRef.current;
      const trimmed = content.trim();

      if (!trimmed) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error('[WS] Cannot send: socket is not open.');
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'send_message',
          roomId,
          content: trimmed,
        }),
      );
    },
    [roomId],
  );

  // ── Manual reconnect trigger ───────────────────────────────────────────────
  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  return {
    messages: state.messages,
    status: state.status,
    error: state.error,
    sendMessage,
    reconnect,
  };
}
```

---

### `ChatRoom.tsx` — Component

```tsx
// src/components/ChatRoom.tsx
import React, { useState, useRef, useEffect, FormEvent } from 'react';
import { useWebSocket, ChatMessage } from '../hooks/useWebSocket';

interface ChatRoomProps {
  /** JWT token from your auth state/context */
  token: string;
  /** The room to connect to */
  roomId: string;
  /** The current user's ID (to differentiate sent vs received messages) */
  currentUserId: string;
}

export function ChatRoom({ token, roomId, currentUserId }: ChatRoomProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { messages, status, error, sendMessage, reconnect } = useWebSocket({
    token,
    roomId,
  });

  // Auto-scroll to the latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || status !== 'connected') return;
    sendMessage(inputValue);
    setInputValue('');
  };

  // ── Status Indicator ───────────────────────────────────────────────────────
  const statusConfig = {
    idle: { label: 'Idle', color: '#6b7280' },
    connecting: { label: 'Connecting…', color: '#f59e0b' },
    connected: { label: 'Connected', color: '#10b981' },
    disconnected: { label: 'Disconnected', color: '#ef4444' },
    error: { label: 'Error', color: '#ef4444' },
  } as const;

  const { label, color } = statusConfig[status];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        maxWidth: 720,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>#{roomId}</h2>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: color,
              display: 'inline-block',
            }}
          />
          {label}
        </span>
        {(status === 'disconnected' || status === 'error') && (
          <button
            onClick={reconnect}
            style={{ fontSize: 12, padding: '4px 8px', cursor: 'pointer' }}
          >
            Reconnect
          </button>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div
          style={{
            background: '#fef2f2',
            color: '#b91c1c',
            padding: '8px 16px',
            fontSize: 13,
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {status === 'connecting' && (
          <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 32 }}>
            Connecting to room…
          </p>
        )}
        {messages.length === 0 && status === 'connected' && (
          <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 32 }}>
            No messages yet. Be the first to say hello!
          </p>
        )}
        {messages.map((msg: ChatMessage) => {
          const isOwn = msg.senderId === currentUserId;
          return (
            <div
              key={msg.id}
              style={{
                alignSelf: isOwn ? 'flex-end' : 'flex-start',
                maxWidth: '70%',
              }}
            >
              {!isOwn && (
                <p
                  style={{
                    margin: '0 0 2px 4px',
                    fontSize: 11,
                    color: '#6b7280',
                    fontWeight: 600,
                  }}
                >
                  {msg.senderUsername}
                </p>
              )}
              <div
                style={{
                  background: isOwn ? '#3b82f6' : '#f3f4f6',
                  color: isOwn ? '#fff' : '#111827',
                  borderRadius: isOwn
                    ? '16px 16px 4px 16px'
                    : '16px 16px 16px 4px',
                  padding: '10px 14px',
                  fontSize: 14,
                  lineHeight: 1.5,
                  // Content is already XSS-sanitized by the server
                  wordBreak: 'break-word',
                }}
              >
                {msg.content}
              </div>
              <p
                style={{
                  margin: '2px 4px 0',
                  fontSize: 10,
                  color: '#9ca3af',
                  textAlign: isOwn ? 'right' : 'left',
                }}
              >
                {new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          gap: 8,
          padding: 16,
          borderTop: '1px solid #e5e7eb',
        }}
      >
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={
            status === 'connected' ? 'Type a message…' : 'Not connected'
          }
          disabled={status !== 'connected'}
          maxLength={2000}
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 24,
            border: '1px solid #d1d5db',
            outline: 'none',
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={!inputValue.trim() || status !== 'connected'}
          style={{
            padding: '10px 20px',
            borderRadius: 24,
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            opacity: !inputValue.trim() || status !== 'connected' ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
```

---

### Usage in Your App

```tsx
// src/App.tsx
import React from 'react';
import { ChatRoom } from './components/ChatRoom';

// In a real app, token and userId come from your auth context/state
const token = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9...';
const currentUserId = '6579c6f0a3e4d12b8c9f1234';

function App() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 720,
          height: '80vh',
          border: '1px solid #e5e7eb',
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        <ChatRoom
          token={token}
          roomId="room_general"
          currentUserId={currentUserId}
        />
      </div>
    </div>
  );
}

export default App;
```

---

<br />
<br />
<br />

---

# مستندات فارسی

---

## فهرست مطالب

1. [معرفی و راه‌اندازی](#۱-معرفی-و-راه‌اندازی)
2. [احراز هویت / مرحله‌ی هندشیک](#۲-احراز-هویت--مرحله‌ی-هندشیک)
3. [لیست رویدادها](#۳-لیست-رویدادها)
4. [نمونه کد ری‌اکت](#۴-نمونه-کد-ری‌اکت)

---

## ۱. معرفی و راه‌اندازی

### این سرور چیست؟

این سرور چیست؟
این یک سرور پیام‌رسان بلادرنگ با معماری آفلاین-فرست (Offline-First) است. احراز هویت از طریق REST API و پایگاه داده SQLite (Prisma) انجام می‌شود و تمام جریان چت‌ها در یک بستر امن WebSocket انتقال می‌یابد.

⚠️ نکته بسیار مهم — معماری:
سرور در این سیستم فقط به عنوان یک مسیریاب (Router) و صف انتظار (Pending Queue) عمل می‌کند. هیچ تاریخچه‌ای از پیام‌ها روی سرور ذخیره نمی‌شود. وظیفه نگهداری پیام‌ها بر عهده کلاینت (توسط دیتابیس‌های مرورگر مثل Dexie.js / IndexedDB) است. اگر گیرنده آفلاین باشد، سرور پیام را به طور موقت در RAM خود نگه می‌دارد تا کاربر متصل شود.

### نمای کلی معماری

```
┌─────────────────────────────────────────────────────────────────┐
│                       کلاینت ری‌اکت                               │
│                                                                 │
│  [REST /api/v1/auth]  ──────────►  ورود / ثبت‌نام / تمدید توکن      │
│  [WebSocket wss://…]  ◄────────►  تمام پیام‌رسانی آنی               │
└─────────────────────────────────────────────────────────────────┘
         │                                      │
         ▼                                      ▼
  MongoDB (فقط کاربران)             Map در حافظه (پیام‌ها)
  ─ پایدار ─                       ─ ناپایدار / فقط RAM ─
```

### نصب و راه‌اندازی

این سرور از **WebSocket API بومی مرورگر** استفاده می‌کند. برای استفاده‌ی پایه، **نیازی به نصب کتابخانه‌ی اضافی نیست.**

```bash
# برای WebSocket بومی، نیازی به نصب پکیج نیست.
# اگر پروژه‌تان از socket.io-client استفاده می‌کند (ابتدا با تیم بک‌اند تأیید کنید):
npm install socket.io-client
```

### پیکربندی متغیرهای محیطی

یک فایل `.env.local` در ریشه‌ی پروژه‌ی ری‌اکت خود بسازید:

```env
NODE_ENV=development
PORT=

# Generate with: openssl rand -hex 64
JWT_SECRET=your jwt accessToken secret
JWT_EXPIRES_IN=jwt accessToken expire duration (m)

# Generate with: openssl rand -hex 64
JWT_REFRESH_SECRET=jwt refreshToken secret
JWT_REFRESH_EXPIRES_IN=jwt refreshToken expire duration (d)

# Generate with: openssl rand -hex 32
COOKIE_SECRET=your cookie secret

# Comma-separated, no trailing slash
ALLOWED_ORIGINS=domains you must allowed to access server

# In-memory store limits
MSG_STORE_MAX_ROOMS= nuber
MSG_STORE_MAX_PER_ROOM=number
MSG_STORE_TTL_MS=number (ms)
# 1year store pending msg
MSG_PENDING_TTL_MS=31536000000
```

> 📌 **توجه:** برای توسعه‌ی محلی از `ws://` و در تمام محیط‌های پروداکشن، استیجینگ و پیش‌نمایش از `wss://` (WebSocket امن) استفاده کنید. هرگز از یک اتصال رمزنگاری‌نشده `ws://` در برابر سرور پروداکشن استفاده نکنید.

### ساختار URL اتصال

```
wss://api.yourdomain.com?token=<توکن_دسترسی_JWT_شما>
│      │                  │
│      │                  └── توکن کوتاه‌عمر از /auth/login
│      └──────────────────── دامنه‌ی API شما
└─────────────────────────── پروتکل WebSocket امن
```

---

## ۲. احراز هویت / مرحله‌ی هندشیک

### نحوه‌ی عملکرد

احراز هویت در **مرحله‌ی هندشیک WebSocket** اتفاق می‌افتد — یعنی قبل از برقراری اتصال. سرور از یک هوک `verifyClient` برای بررسی هر درخواست ارتقاء (Upgrade) ورودی استفاده می‌کند. اگر یک JWT معتبر موجود نباشد، **اتصال TCP بلافاصله رد می‌شود** با یک وضعیت `401 Unauthorized`. سوکت هرگز باز نمی‌شود.

```
کلاینت                              سرور
  │                                   │
  │  ── درخواست HTTP Upgrade ────────►│
  │     + ?token=<JWT>                │
  │                                   │  verifyClient():
  │                                   │  ├─ توکن وجود ندارد؟   → 401, رد
  │                                   │  ├─ توکن منقضی شده؟   → 401, رد
  │                                   │  └─ توکن معتبر است؟   → 101, ارتقاء ✓
  │  ◄── 101 Switching Protocols ─────│
  │                                   │
  │  ═══ اتصال WebSocket برقرار ═══   │
```

> 🔴 **قانون سخت:** کلاینت ری‌اکت شما **باید** قبل از هر اقدامی برای اتصال WebSocket، یک JWT معتبر از اندپوینت REST ورود دریافت کند. تلاش برای اتصال بدون توکن منجر به شکست فوری اتصال می‌شود. کلاینت باید این را به‌صورت مناسب مدیریت کند (مثلاً هدایت به صفحه‌ی ورود).

### مرحله ۱ — دریافت JWT از طریق REST Login

```typescript
// src/api/auth.ts

const API_URL = import.meta.env.VITE_API_URL;

/**
 * کاربر را در برابر REST API احراز هویت می‌کند.
 * سرور JWT را به‌صورت خودکار به‌عنوان کوکی HttpOnly امضاشده تنظیم می‌کند.
 * اگر توکن در body برگردانده شد، آن را در حافظه نگه دارید (هرگز در localStorage نه).
 */
export async function login(email: string, password: string) {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // برای ارسال/دریافت کوکی‌های HttpOnly لازم است
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message ?? 'ورود ناموفق بود');
  }

  return response.json();
}
```

### مرحله ۲ — ارسال توکن هنگام اتصال WebSocket

سرور JWT را از دو روش می‌پذیرد (به ترتیب اولویت):

| روش                    | مکانیزم                                              | پیشنهاد برای               |
| ---------------------- | ---------------------------------------------------- | -------------------------- |
| **۱. کوکی** (ترجیحی)   | کوکی `ws_token` که پس از ورود توسط سرور تنظیم می‌شود | کلاینت‌های مرورگر (خودکار) |
| **۲. Query Parameter** | `?token=<jwt>` به آخر URL WebSocket اضافه می‌شود     | کلاینت‌های native/موبایل   |

> ⚠️ **نکته امنیتی:** توکن در query string ممکن است در لاگ‌های دسترسی سرور و تاریخچه‌ی مرورگر ظاهر شود. برای توکن‌های کوتاه‌عمر (انقضاء ۱۵ دقیقه‌ای) قابل قبول است، اما مطمئن شوید که طول عمر توکن به حداقل رسیده باشد.

```typescript
// src/lib/websocket.ts

/**
 * یک اتصال WebSocket احراز هویت‌شده ایجاد می‌کند.
 * توکن JWT دریافت‌شده از اندپوینت ورود را پاس دهید.
 */
export function createAuthenticatedSocket(token: string): WebSocket {
  const WS_URL = import.meta.env.VITE_WS_URL;

  const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);

  socket.onopen = () => console.log('[WS] اتصال برقرار شد.');
  socket.onerror = (err) => console.error('[WS] خطای اتصال:', err);
  socket.onclose = (event) => {
    if (event.code === 1006) {
      // کد 1006 = بسته شدن غیرعادی. احتمالاً ناشی از شکست هندشیک (توکن نامعتبر) است.
      console.error(
        '[WS] اتصال رد شد. توکن ممکن است نامعتبر یا منقضی شده باشد.',
      );
    }
  };

  return socket;
}
```

---

## ۳. لیست رویدادها

(Event Catalog)ارتباطات از طریق ارسال و دریافت رشته‌های JSON دارای کلید type انجام می‌شود.
📤 ارسال از کلاینت به سرور (Emit)

نام رویداد,ساختار داده (Payload),توضیحات
send_message,"{ to: string, content: string, localId: string }",ارسال پیام. localId یک شناسه یکتا تولید شده در کلاینت برای رهگیری وضعیت پیام است.
typing_start,{ to: string },اعلام شروع تایپ به مخاطب.
typing_stop,{ to: string },اعلام توقف تایپ به مخاطب.
ack_pending,{ ids: string[] },تایید دریافت پیام‌های آفلاین (تا سرور آن‌ها را از RAM پاک کند).
ping,{ },برای زنده نگه داشتن کانکشن (هر ۲۵ ثانیه ارسال شود).

---

#### `send_message` — ارسال پیام

یک پیام چت جدید به یک اتاق خاص ارسال می‌کند.

| فیلد      | نوع      | اجباری | توضیح                                            |
| --------- | -------- | ------ | ------------------------------------------------ |
| `type`    | `string` | ✅     | باید دقیقاً `"send_message"` باشد                |
| `roomId`  | `string` | ✅     | شناسه‌ی اتاق مقصد (حروف عددی، حداکثر ۶۴ کاراکتر) |
| `content` | `string` | ✅     | متن پیام (حداکثر ۲۰۰۰ کاراکتر)                   |

```typescript
// ارسال: فرستادن یک پیام
const payload = {
  type: 'send_message',
  roomId: 'room_general',
  content: 'سلام دنیا!',
};

socket.send(JSON.stringify(payload));
```

---

#### `join_room` — ورود به اتاق

کلاینت را در یک اتاق مشترک می‌کند و ۵۰ پیام آخر را از تاریخچه‌ی in-memory واکشی می‌کند.

| فیلد     | نوع      | اجباری | توضیح                          |
| -------- | -------- | ------ | ------------------------------ |
| `type`   | `string` | ✅     | باید دقیقاً `"join_room"` باشد |
| `roomId` | `string` | ✅     | اتاقی که می‌خواهید وارد شوید   |

```typescript
// ارسال: ورود به اتاق
socket.send(JSON.stringify({ type: 'join_room', roomId: 'room_general' }));
```

---

#### `leave_room` — خروج از اتاق

اشتراک کلاینت را از یک اتاق لغو می‌کند.

| فیلد     | نوع      | اجباری | توضیح                              |
| -------- | -------- | ------ | ---------------------------------- |
| `type`   | `string` | ✅     | باید دقیقاً `"leave_room"` باشد    |
| `roomId` | `string` | ✅     | اتاقی که می‌خواهید از آن خارج شوید |

```typescript
// ارسال: خروج از اتاق
socket.send(JSON.stringify({ type: 'leave_room', roomId: 'room_general' }));
```

---

#### `get_history` — دریافت تاریخچه

۵۰ پیام آخر یک اتاق را از store in-memory درخواست می‌کند.

| فیلد     | نوع      | اجباری | توضیح                            |
| -------- | -------- | ------ | -------------------------------- |
| `type`   | `string` | ✅     | باید دقیقاً `"get_history"` باشد |
| `roomId` | `string` | ✅     | اتاقی که تاریخچه‌اش را می‌خواهید |

```typescript
// ارسال: درخواست تاریخچه
socket.send(JSON.stringify({ type: 'get_history', roomId: 'room_general' }));
```

---

### ۳.۲ — رویدادهای دریافتی (سرور → کلاینت)

همیشه پیام‌های ورودی را با `JSON.parse()` داخل هندلر `onmessage` پارس کنید.

---

#### `room_joined` — ورود به اتاق تأیید شد

پس از یک emit موفق `join_room` ارسال می‌شود. شامل تاریخچه‌ی اخیر in-memory است.

```typescript
// ساختار payload ورودی
interface RoomJoinedEvent {
  type: 'room_joined';
  roomId: string;
  history: ChatMessage[]; // ۵۰ پیام آخر، از قدیمی‌ترین به جدیدترین
}

interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  content: string; // قبلاً توسط سرور XSS-sanitize شده
  timestamp: number; // Unix timestamp به میلی‌ثانیه
}
```

---

#### `new_message` — پیام جدید

به تمام کلاینت‌های حاضر در یک اتاق broadcast می‌شود، هنگامی که هر عضوی پیامی ارسال کند.

```typescript
// ساختار payload ورودی
interface NewMessageEvent {
  type: 'new_message';
  message: ChatMessage;
}
```

---

#### `history` — تاریخچه‌ی پیام‌ها

پاسخ به یک emit از نوع `get_history`.

```typescript
// ساختار payload ورودی
interface HistoryEvent {
  type: 'history';
  roomId: string;
  messages: ChatMessage[];
}
```

---

#### `room_left` — خروج از اتاق تأیید شد

تأیید می‌کند که کلاینت با موفقیت از اتاق خارج شده است.

```typescript
// ساختار payload ورودی
interface RoomLeftEvent {
  type: 'room_left';
  roomId: string;
}
```

---

#### `error` — خطا

هنگامی که سرور در پردازش پیام کلاینت با مشکل مواجه می‌شود ارسال می‌گردد.

| کد (`code`) | معنی                                                  |
| ----------- | ----------------------------------------------------- |
| `4001`      | خطای اعتبارسنجی (payload ناقص، roomId نامعتبر و غیره) |
| `4002`      | در اتاق نیستید (سعی در ارسال پیام بدون join کردن)     |
| `4003`      | محدودیت نرخ فراتر رفته (Rate limit)                   |
| `5000`      | خطای داخلی سرور                                       |

```typescript
// ساختار payload ورودی
interface ErrorEvent {
  type: 'error';
  message: string; // توضیح قابل خواندن توسط انسان
  code: number; // کد خطای قابل پردازش توسط ماشین
}
```

---

### جدول مرجع کامل رویدادها

| جهت              | نوع رویداد     | زمان فعال‌سازی                | فیلدهای کلیدی Payload  |
| ---------------- | -------------- | ----------------------------- | ---------------------- |
| ➡️ کلاینت → سرور | `join_room`    | ورود به اتاق چت               | `roomId`               |
| ➡️ کلاینت → سرور | `leave_room`   | خروج از اتاق چت               | `roomId`               |
| ➡️ کلاینت → سرور | `send_message` | ارسال پیام چت                 | `roomId`، `content`    |
| ➡️ کلاینت → سرور | `get_history`  | واکشی تاریخچه‌ی اتاق          | `roomId`               |
| ⬅️ سرور → کلاینت | `room_joined`  | پس از join موفق               | `roomId`، `history[]`  |
| ⬅️ سرور → کلاینت | `room_left`    | پس از leave موفق              | `roomId`               |
| ⬅️ سرور → کلاینت | `new_message`  | هنگامی که عضوی پیام ارسال کند | `message`              |
| ⬅️ سرور → کلاینت | `history`      | در پاسخ به `get_history`      | `roomId`، `messages[]` |
| ⬅️ سرور → کلاینت | `error`        | در صورت هر خطای سرور          | `message`، `code`      |

---

## ۴. نمونه کد ری‌اکت

مثال زیر یک هوک سفارشی `useWebSocket` آماده‌ی پروداکشن و یک کامپوننت همراه `ChatRoom` ارائه می‌دهد. هوک کل چرخه‌ی حیات WebSocket را کپسوله می‌کند: اتصال، احراز هویت، مسیریابی رویداد، اتصال مجدد، و پاکسازی.

### `useWebSocket.ts` — هوک سفارشی

## ۴. معماری آفلاین-فرست (بسیار مهم)

نحوه مدیریت پیام‌ها در کلاینت (فرانت‌اند):

ارسال: یک localId (UUID) بسازید، پیام را با وضعیت sending در دیتابیس IndexedDB مرورگر ذخیره کنید و رویداد send_message را بفرستید.

تاییدیه: منتظر دریافت رویداد message_sent بمانید. با دریافت آن، پیام را از طریق localId در دیتابیس پیدا کرده و وضعیتش را به sent تغییر دهید.

دریافت: با دریافت رویدادهای new_message یا pending_messages، پیام‌ها را مستقیماً در دیتابیس ذخیره کرده و UI را آپدیت کنید.

تایید (ACK): به محض ذخیره موفق پیام‌های آفلاین، حتماً رویداد ack_pending را به همراه آیدی پیام‌ها (messageIds) به سرور بفرستید تا از حافظه سرور حذف شوند.

```typescript
// src/hooks/useWebSocket.ts
import { useEffect, useRef, useCallback, useReducer } from 'react';

// ─── انواع داده ──────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  timestamp: number;
}

type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

interface WsState {
  messages: ChatMessage[];
  status: ConnectionStatus;
  error: string | null;
}

type WsAction =
  | { type: 'CONNECTING' }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'ERROR'; payload: string }
  | { type: 'HISTORY_LOADED'; payload: ChatMessage[] }
  | { type: 'MESSAGE_RECEIVED'; payload: ChatMessage }
  | { type: 'CLEAR_MESSAGES' };

function wsReducer(state: WsState, action: WsAction): WsState {
  switch (action.type) {
    case 'CONNECTING':
      return { ...state, status: 'connecting', error: null };
    case 'CONNECTED':
      return { ...state, status: 'connected' };
    case 'DISCONNECTED':
      return { ...state, status: 'disconnected' };
    case 'ERROR':
      return { ...state, status: 'error', error: action.payload };
    case 'HISTORY_LOADED':
      return { ...state, messages: action.payload };
    case 'MESSAGE_RECEIVED':
      return { ...state, messages: [...state.messages, action.payload] };
    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] };
    default:
      return state;
  }
}

// ─── هوک ────────────────────────────────────────────────────────────────────

interface UseWebSocketOptions {
  /** توکن JWT دریافت‌شده از اندپوینت ورود */
  token: string | null;
  /** شناسه‌ی اتاقی که باید پس از اتصال وارد شویم */
  roomId: string;
  /** اتصال مجدد در صورت قطع غیرمنتظره (پیش‌فرض: true) */
  autoReconnect?: boolean;
  /** تأخیر پایه بر حسب میلی‌ثانیه قبل از تلاش برای اتصال مجدد (پیش‌فرض: ۲۰۰۰) */
  reconnectDelay?: number;
  /** حداکثر تعداد تلاش‌های اتصال مجدد (پیش‌فرض: ۵) */
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  messages: ChatMessage[];
  status: ConnectionStatus;
  error: string | null;
  sendMessage: (content: string) => void;
  reconnect: () => void;
}

const WS_URL = import.meta.env.VITE_WS_URL as string;

export function useWebSocket({
  token,
  roomId,
  autoReconnect = true,
  reconnectDelay = 2000,
  maxReconnectAttempts = 5,
}: UseWebSocketOptions): UseWebSocketReturn {
  const [state, dispatch] = useReducer(wsReducer, {
    messages: [],
    status: 'idle',
    error: null,
  });

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const connect = useCallback(() => {
    // محافظت: بدون توکن معتبر اتصال برقرار نکن
    if (!token) {
      dispatch({ type: 'ERROR', payload: 'توکن احراز هویت ارائه نشده است.' });
      return;
    }

    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close(1000, 'شروع مجدد اتصال');
    }

    dispatch({ type: 'CONNECTING' });

    const url = `${WS_URL}?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    socketRef.current = socket;

    // ── باز شدن ────────────────────────────────────────────────────────────
    socket.onopen = () => {
      if (!isMountedRef.current) return;
      dispatch({ type: 'CONNECTED' });
      reconnectAttemptsRef.current = 0;

      // بلافاصله پس از برقراری اتصال، وارد اتاق مورد نظر می‌شویم
      socket.send(JSON.stringify({ type: 'join_room', roomId }));
    };

    // ── دریافت پیام ─────────────────────────────────────────────────────────
    socket.onmessage = (event: MessageEvent<string>) => {
      if (!isMountedRef.current) return;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        console.error('[WS] پارس پیام سرور ناموفق بود:', event.data);
        return;
      }

      const messageType = parsed['type'] as string;

      switch (messageType) {
        case 'room_joined': {
          const history = (parsed['history'] as ChatMessage[]) ?? [];
          dispatch({ type: 'HISTORY_LOADED', payload: history });
          break;
        }
        case 'new_message': {
          const message = parsed['message'] as ChatMessage;
          dispatch({ type: 'MESSAGE_RECEIVED', payload: message });
          break;
        }
        case 'history': {
          const messages = (parsed['messages'] as ChatMessage[]) ?? [];
          dispatch({ type: 'HISTORY_LOADED', payload: messages });
          break;
        }
        case 'error': {
          const msg = parsed['message'] as string;
          const code = parsed['code'] as number;
          console.error(`[WS] خطای سرور (${code}):`, msg);
          dispatch({ type: 'ERROR', payload: `[${code}] ${msg}` });
          break;
        }
        default:
          break;
      }
    };

    // ── خطا ─────────────────────────────────────────────────────────────────
    socket.onerror = () => {
      if (!isMountedRef.current) return;
      dispatch({ type: 'ERROR', payload: 'خطا در اتصال WebSocket.' });
    };

    // ── بسته شدن ────────────────────────────────────────────────────────────
    socket.onclose = (event: CloseEvent) => {
      if (!isMountedRef.current) return;
      dispatch({ type: 'DISCONNECTED' });

      const isCleanClose = event.code === 1000;
      const isAuthFailure = event.code === 1006 || event.code === 4001;

      if (isAuthFailure) {
        dispatch({
          type: 'ERROR',
          payload: 'احراز هویت ناموفق بود. لطفاً دوباره وارد شوید.',
        });
        return;
      }

      if (!isCleanClose && autoReconnect) {
        const attempts = reconnectAttemptsRef.current;

        if (attempts < maxReconnectAttempts) {
          // Exponential backoff: ۲ثانیه، ۴ثانیه، ۸ثانیه، ...
          const delay = reconnectDelay * Math.pow(2, attempts);
          console.warn(
            `[WS] قطع اتصال. اتصال مجدد در ${delay}ms... (تلاش ${attempts + 1})`,
          );
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(connect, delay);
        } else {
          dispatch({
            type: 'ERROR',
            payload: `اتصال مجدد پس از ${maxReconnectAttempts} تلاش ناموفق بود.`,
          });
        }
      }
    };
  }, [token, roomId, autoReconnect, reconnectDelay, maxReconnectAttempts]);

  useEffect(() => {
    isMountedRef.current = true;
    connect();

    return () => {
      isMountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close(1000, 'کامپوننت unmount شد');
    };
  }, [connect]);

  const sendMessage = useCallback(
    (content: string) => {
      const socket = socketRef.current;
      const trimmed = content.trim();

      if (!trimmed) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.error('[WS] ارسال ناممکن: سوکت باز نیست.');
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'send_message',
          roomId,
          content: trimmed,
        }),
      );
    },
    [roomId],
  );

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    connect();
  }, [connect]);

  return {
    messages: state.messages,
    status: state.status,
    error: state.error,
    sendMessage,
    reconnect,
  };
}
```

---

### `ChatRoom.tsx` — کامپوننت

```tsx
// src/components/ChatRoom.tsx
import React, { useState, useRef, useEffect, FormEvent } from 'react';
import { useWebSocket, ChatMessage } from '../hooks/useWebSocket';

interface ChatRoomProps {
  token: string; // توکن JWT از state/context احراز هویت شما
  roomId: string; // اتاقی که باید به آن وصل شوید
  currentUserId: string; // شناسه‌ی کاربر فعلی (برای تمایز پیام‌های ارسالی از دریافتی)
}

export function ChatRoom({ token, roomId, currentUserId }: ChatRoomProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { messages, status, error, sendMessage, reconnect } = useWebSocket({
    token,
    roomId,
  });

  // اسکرول خودکار به آخرین پیام
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || status !== 'connected') return;
    sendMessage(inputValue);
    setInputValue('');
  };

  const statusConfig = {
    idle: { label: 'آماده', color: '#6b7280' },
    connecting: { label: 'در حال اتصال…', color: '#f59e0b' },
    connected: { label: 'متصل', color: '#10b981' },
    disconnected: { label: 'قطع اتصال', color: '#ef4444' },
    error: { label: 'خطا', color: '#ef4444' },
  } as const;

  const { label, color } = statusConfig[status];

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        direction: 'rtl',
      }}
    >
      {/* هدر */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>#{roomId}</h2>
        <span
          style={{
            marginRight: 'auto',
            fontSize: 12,
            color,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: color,
              display: 'inline-block',
            }}
          />
          {label}
        </span>
        {(status === 'disconnected' || status === 'error') && (
          <button
            onClick={reconnect}
            style={{ fontSize: 12, padding: '4px 8px', cursor: 'pointer' }}
          >
            اتصال مجدد
          </button>
        )}
      </div>

      {/* بنر خطا */}
      {error && (
        <div
          style={{
            background: '#fef2f2',
            color: '#b91c1c',
            padding: '8px 16px',
            fontSize: 13,
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* پیام‌ها */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {status === 'connecting' && (
          <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 32 }}>
            در حال اتصال به اتاق…
          </p>
        )}
        {messages.length === 0 && status === 'connected' && (
          <p style={{ color: '#9ca3af', textAlign: 'center', marginTop: 32 }}>
            هنوز پیامی وجود ندارد. اولین نفر باشید!
          </p>
        )}
        {messages.map((msg: ChatMessage) => {
          const isOwn = msg.senderId === currentUserId;
          return (
            <div
              key={msg.id}
              style={{
                alignSelf: isOwn ? 'flex-start' : 'flex-end',
                maxWidth: '70%',
              }}
            >
              {!isOwn && (
                <p
                  style={{
                    margin: '0 4px 2px',
                    fontSize: 11,
                    color: '#6b7280',
                    fontWeight: 600,
                  }}
                >
                  {msg.senderUsername}
                </p>
              )}
              <div
                style={{
                  background: isOwn ? '#3b82f6' : '#f3f4f6',
                  color: isOwn ? '#fff' : '#111827',
                  borderRadius: isOwn
                    ? '16px 16px 16px 4px'
                    : '16px 16px 4px 16px',
                  padding: '10px 14px',
                  fontSize: 14,
                  lineHeight: 1.7,
                  wordBreak: 'break-word',
                  fontFamily: 'inherit',
                }}
              >
                {msg.content}
              </div>
              <p
                style={{
                  margin: '2px 4px 0',
                  fontSize: 10,
                  color: '#9ca3af',
                  textAlign: isOwn ? 'left' : 'right',
                }}
              >
                {new Date(msg.timestamp).toLocaleTimeString('fa-IR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* ورودی */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          gap: 8,
          padding: 16,
          borderTop: '1px solid #e5e7eb',
        }}
      >
        <button
          type="submit"
          disabled={!inputValue.trim() || status !== 'connected'}
          style={{
            padding: '10px 20px',
            borderRadius: 24,
            background: '#3b82f6',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
            fontWeight: 600,
            opacity: !inputValue.trim() || status !== 'connected' ? 0.5 : 1,
          }}
        >
          ارسال
        </button>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={
            status === 'connected'
              ? 'پیام خود را بنویسید…'
              : 'اتصال برقرار نیست'
          }
          disabled={status !== 'connected'}
          maxLength={2000}
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 24,
            border: '1px solid #d1d5db',
            outline: 'none',
            fontSize: 14,
            textAlign: 'right',
            fontFamily: 'inherit',
          }}
        />
      </form>
    </div>
  );
}
```

---

### استفاده در اپلیکیشن

```tsx
// src/App.tsx
import React from 'react';
import { ChatRoom } from './components/ChatRoom';

// در یک اپ واقعی، token و userId از context یا state احراز هویت شما می‌آیند
const token = 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9...';
const currentUserId = '6579c6f0a3e4d12b8c9f1234';

function App() {
  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 720,
          height: '80vh',
          border: '1px solid #e5e7eb',
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        <ChatRoom
          token={token}
          roomId="room_general"
          currentUserId={currentUserId}
        />
      </div>
    </div>
  );
}

export default App;
```

---

<br/>

## سؤالات متداول (FAQ)

**س: آیا می‌توانم پیام‌ها را در localStorage ذخیره کنم تا تاریخچه حفظ شود؟**

خیر. پیام‌ها ذاتاً ناپایدار هستند. ذخیره‌سازی آن‌ها در localStorage یک تضاد با معماری سیستم ایجاد می‌کند و می‌تواند اطلاعات حساس کاربران دیگر را در مرورگر یک کلاینت خاص به خطر بیاندازد.

**س: چه اتفاقی می‌افتد اگر توکن من در حین اتصال WebSocket منقضی شود؟**

سرور اتصال‌های موجود را اجباراً قطع نمی‌کند. اما توکن‌ها ۱۵ دقیقه‌ای هستند. برای جلوگیری از اختلال، یک تایمر در برنامه‌ی خود تنظیم کنید تا توکن را با استفاده از اندپوینت `/auth/refresh` قبل از انقضاء تمدید کند، سپس اتصال WebSocket را با توکن جدید مجدداً برقرار کنید.

**س: اگر در همان لحظه‌ای که سرور ریستارت می‌شود آنلاین باشم چه؟**

هوک `useWebSocket` یک قطع اتصال تشخیص می‌دهد و با exponential backoff تلاش برای اتصال مجدد می‌کند. پس از اتصال مجدد، تاریخچه‌ی چت از آن نقطه خالی خواهد بود زیرا سرور حافظه‌اش را پاک کرده است.

---

_این مستند توسط تیم مهندسی بک‌اند تهیه شده است. برای سؤالات بیشتر با تیم مربوطه تماس بگیرید._

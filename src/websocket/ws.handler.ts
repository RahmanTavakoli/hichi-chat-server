import { WsMessageSchema } from '@/schemas/message.schema';
import { messageStore, type ChatMessage as StoredMessage } from '@/services/message.store';
import { type AuthenticatedWebSocket, userRegistry } from './ws.server';
import { wsLogger } from './ws.logger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical DM room key — `dm:alice:bob` always the same regardless of sender */
function dmRoomKey(a: string, b: string): string {
  return `dm:${[a.toLowerCase(), b.toLowerCase()].sort().join(':')}`;
}

/** Wire format sent to clients — maps backend `content` to frontend `text` */
export interface WireMessage {
  id: string;
  localId: string | undefined;
  chatId: string;
  from: string;
  to: string;
  text: string;
  timestamp: number;
}

function toWire(stored: StoredMessage, toUsername: string, localId?: string): WireMessage {
  return {
    id: stored.id,
    localId: localId,
    chatId: stored.roomId,
    from: stored.senderUsername,
    to: toUsername,
    text: stored.content, // content → text (BUG FIX #4)
    timestamp: stored.timestamp,
  };
}

/** Safe send — never throws, logs if socket is not ready */
function safeSend(ws: AuthenticatedWebSocket, payload: unknown): void {
  if (ws.readyState === 1 /* WebSocket.OPEN */) {
    ws.send(JSON.stringify(payload));
  } else {
    wsLogger.warn('safeSend skipped — socket not open', {
      username: ws.username,
      readyState: ws.readyState,
    });
  }
}

/**
 * broadcastPresence
 * Sends a `user_status_change` event to EVERY currently connected user.
 * This is intentionally simple — a contact-list-aware broadcast could be
 * added later for efficiency, but for now broadcasting to all is reliable
 * and correct for small/medium deployments.
 */
export function broadcastPresence(username: string, status: 'online' | 'offline'): void {
  const payload = JSON.stringify({ type: 'user_status_change', username, status });
  for (const [connectedUsername, ws] of userRegistry.entries()) {
    if (connectedUsername !== username.toLowerCase() && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

/**
 * deliverPendingMessages
 * ──────────────────────────────────────────────────────────────────────────────
 * Called immediately after a user connects and is registered in userRegistry.
 * Flushes all pending (offline-queued) messages from the server's RAM to the
 * client in a single `pending_messages` frame.
 *
 * The messages are optimistically removed from the pending store at flush time.
 * If the client does NOT send a `messages_ack` (e.g. socket drops before ACK),
 * the pending store's `requeue()` is called in the close handler.
 *
 * Returns the flushed messages (so the close handler can requeue them on failure).
 */
export function deliverPendingMessages(ws: AuthenticatedWebSocket): void {
  const pending = messageStore.pending.flush(ws.username);
  if (pending.length === 0) return;

  wsLogger.info('Delivering pending messages', {
    username: ws.username,
    count: pending.length,
  });

  // Convert stored pending messages to wire format
  const wireMessages: WireMessage[] = pending.map((m) => toWire(m, ws.username, undefined));

  safeSend(ws, {
    type: 'pending_messages',
    messages: wireMessages,
    messageIds: pending.map((m) => m.id), // IDs for ACK
  });

  // Track flushed messages on the ws object so we can requeue if socket drops
  // before ACK arrives (attach to ws object to avoid closure leaks)
  (ws as AuthenticatedWebSocket & { _pendingFlushed?: typeof pending })._pendingFlushed = pending;
}

// ─── Schema extension — add messages_ack ──────────────────────────────────────
// Note: messages_ack is not in the Zod schema so we handle it as a raw check
// here to avoid modifying the Zod discriminated union for a simple ACK.

interface MessagesAckFrame {
  type: 'messages_ack';
  messageIds: string[];
}

function isMessagesAck(raw: unknown): raw is MessagesAckFrame {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    r['type'] === 'messages_ack' &&
    Array.isArray(r['messageIds']) &&
    (r['messageIds'] as unknown[]).every((id) => typeof id === 'string')
  );
}

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

export function handleWsEvent(ws: AuthenticatedWebSocket, raw: unknown): void {
  // ── messages_ack (not in main schema — handle first) ─────────────────────
  if (isMessagesAck(raw)) {
    const { messageIds } = raw;
    messageStore.pending.clear(ws.username, messageIds);

    // Clear the tracked flushed buffer — delivery confirmed
    delete (ws as AuthenticatedWebSocket & { _pendingFlushed?: unknown })._pendingFlushed;

    wsLogger.info('Pending messages acknowledged', {
      username: ws.username,
      count: messageIds.length,
    });
    return;
  }

  // ── All other events — validate via Zod ──────────────────────────────────
  const result = WsMessageSchema.safeParse(raw);
  if (!result.success) {
    wsLogger.warn('Invalid message schema', {
      username: ws.username,
      errors: result.error.flatten().fieldErrors,
    });
    safeSend(ws, {
      type: 'error',
      message: 'Invalid message format',
      code: 4001,
      errors: result.error.flatten().fieldErrors,
    });
    return;
  }

  const msg = result.data;

  switch (msg.type) {
    // ── send_message ──────────────────────────────────────────────────────────
    case 'send_message': {
      const { to, content, localId } = msg;
      const from = ws.username;

      if (to.toLowerCase() === from.toLowerCase()) {
        safeSend(ws, { type: 'error', message: 'Cannot message yourself.', code: 4002 });
        return;
      }

      const roomId = dmRoomKey(from, to);

      // 1. فقط پیام را تولید و پاکسازی کن (هیچ ذخیره‌سازی در اینجا رخ نمی‌دهد)
      const stored = messageStore.createMessage(roomId, ws.userId, from, content);
      const wire = toWire(stored, to, localId);

      // 2. تاییدیه برای فرستنده (تا تیک ارسال در کلاینت بخورد)
      safeSend(ws, { type: 'message_sent', localId, message: wire });

      // 3. مسیر یابی و تحویل
      const recipientWs = userRegistry.get(to.toLowerCase());

      if (recipientWs && recipientWs.readyState === 1) {
        // ── گیرنده آنلاین است: تحویل مستقیم (RAM سرور درگیر نمی‌شود) ──
        safeSend(recipientWs, { type: 'new_message', message: wire });
        wsLogger.info('Message routed directly (online)', { from, to, msgId: stored.id });
      } else {
        // ── گیرنده آفلاین است: ذخیره موقت در صف انتظار ──
        messageStore.pending.add(to.toLowerCase(), stored);
        wsLogger.info('Message queued (recipient offline)', {
          from,
          to,
          msgId: stored.id,
        });
      }
      break;
    }

    // ── typing_start ──────────────────────────────────────────────────────────
    case 'typing_start': {
      const recipientWs = userRegistry.get(msg.to.toLowerCase());
      if (recipientWs) safeSend(recipientWs, { type: 'typing_start', from: ws.username });
      wsLogger.debug('Typing start', { from: ws.username, to: msg.to });
      break;
    }

    // ── typing_stop ───────────────────────────────────────────────────────────
    case 'typing_stop': {
      const recipientWs = userRegistry.get(msg.to.toLowerCase());
      if (recipientWs) safeSend(recipientWs, { type: 'typing_stop', from: ws.username });
      wsLogger.debug('Typing stop', { from: ws.username, to: msg.to });
      break;
    }

    // ── ping ──────────────────────────────────────────────────────────────────
    case 'ping': {
      safeSend(ws, { type: 'pong', ts: Date.now() });
      wsLogger.debug('Ping', { username: ws.username });
      break;
    }
  }
}

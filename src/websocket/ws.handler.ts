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
  if (ws.readyState === 1) {
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

  wsLogger.info('Delivering pending messages', { username: ws.username, count: pending.length });

  const wireMessages: WireMessage[] = pending.map((m) => toWire(m, ws.username, undefined));

  safeSend(ws, {
    type: 'pending_messages',
    messages: wireMessages,
    messageIds: pending.map((m) => m.id),
  });

  (ws as AuthenticatedWebSocket & { _pendingFlushed?: typeof pending })._pendingFlushed = pending;
}

// ─── Schema extension — add messages_ack ──────────────────────────────────────
// Note: messages_ack is not in the Zod schema so we handle it as a raw check
// here to avoid modifying the Zod discriminated union for a simple ACK.

// ─── Raw frame guards (bypass Zod for simple ACK-style frames) ────────────────

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

// mark_read: sent by RECIPIENT when they open a chat and see messages
// Server relays it to the original SENDER as `messages_read`
interface MarkReadFrame {
  type: 'mark_read';
  chatId: string; // "dm:alice:bob"
  messageIds: string[]; // server-assigned UUIDs of messages now seen
}
function isMarkRead(raw: unknown): raw is MarkReadFrame {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    r['type'] === 'mark_read' &&
    typeof r['chatId'] === 'string' &&
    Array.isArray(r['messageIds']) &&
    (r['messageIds'] as unknown[]).every((id) => typeof id === 'string')
  );
}

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

// ─── Main Dispatcher ──────────────────────────────────────────────────────────

export function handleWsEvent(ws: AuthenticatedWebSocket, raw: unknown): void {
  // ── Offline delivery ACK ──────────────────────────────────────────────────
  if (isMessagesAck(raw)) {
    messageStore.pending.clear(ws.username, raw.messageIds);
    delete (ws as AuthenticatedWebSocket & { _pendingFlushed?: unknown })._pendingFlushed;
    wsLogger.info('Pending messages acknowledged', {
      username: ws.username,
      count: raw.messageIds.length,
    });
    return;
  }

  // ── Read receipt (recipient → server → sender) ────────────────────────────
  //
  // When Bob opens a chat with Alice:
  //   Bob's client  → { type: 'mark_read', chatId: 'dm:alice:bob', messageIds: [...] }
  //   Server        → looks up Alice in userRegistry
  //   Alice online  → { type: 'messages_read', chatId, messageIds, by: 'bob' }
  //   Alice's UI    → upgrades those messages: 'sent'/'delivered' → 'read' (✓✓ blue)
  //
  if (isMarkRead(raw)) {
    const { chatId, messageIds } = raw;
    const readerUsername = ws.username;

    if (messageIds.length === 0) return;

    wsLogger.info('mark_read received', {
      from: readerUsername,
      chatId,
      count: messageIds.length,
    });

    // Parse sender username from chatId: "dm:alice:bob" → whichever is not the reader
    const chatParts = chatId.replace(/^dm:/, '').split(':');
    const senderUsername = chatParts.find((p) => p.toLowerCase() !== readerUsername.toLowerCase());

    if (!senderUsername) {
      wsLogger.warn('mark_read: cannot parse sender from chatId', {
        chatId,
        reader: readerUsername,
      });
      return;
    }

    const senderWs = userRegistry.get(senderUsername.toLowerCase());
    if (senderWs && senderWs.readyState === 1) {
      safeSend(senderWs, {
        type: 'messages_read',
        chatId,
        messageIds,
        by: readerUsername,
      });
      wsLogger.info('Read receipt forwarded to sender', {
        sender: senderUsername,
        reader: readerUsername,
        count: messageIds.length,
      });
    } else {
      // Sender offline — read receipt is best-effort (informational only)
      wsLogger.debug('Read receipt dropped — sender offline', { sender: senderUsername });
    }
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

    // ── mark_read ─────────────────────────────────────────────────────────────
    case 'mark_read': {
      wsLogger.info(
        `[MARK_READ] User '${ws.username}' read ${msg.messageIds.length} messages from '${msg.to}'`,
      );

      const senderWs = userRegistry.get(msg.to.toLowerCase());
      if (senderWs) {
        safeSend(senderWs, {
          type: 'messages_read',
          chatId: dmRoomKey(ws.username, msg.to),
          messageIds: msg.messageIds,
        });
        wsLogger.info(`[MARK_READ] 🚀 Forwarded read receipt (blue ticks) to '${msg.to}'`);
      } else {
        // نکته: اگر فرستنده آفلاین باشد، در حال حاضر تیک آبی موقتاً گم می‌شود
        wsLogger.warn(`[MARK_READ] ⚠️ Cannot forward receipt, sender '${msg.to}' is offline.`);
      }
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

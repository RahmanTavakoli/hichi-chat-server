// src/services/message.store.ts
import { env } from '@/config/env';
import { filterXSS } from 'xss';

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  timestamp: number;
}

// ─── Pending Message ──────────────────────────────────────────────────────────

export interface PendingMessage {
  id: string; // Same as ChatMessage.id
  roomId: string;
  senderId: string;
  senderUsername: string;
  content: string;
  timestamp: number;
  toUsername: string; // Recipient (for lookup)
  createdAt: number; // When it entered the pending queue (for TTL)
}

/**
 * PendingMessageStore
 * ─────────────────────────────────────────────────────────────────────────────
 * Stores messages that could not be delivered because the recipient was offline.
 *
 * Lifecycle:
 *   1. `add(toUsername, message)`  — called when recipient is not in userRegistry
 *   2. `getAll(username)`           — called on connect to flush pending to client
 *   3. `clear(username, ids)`       — called after client confirms receipt (ACK)
 *   4. `gcOld(maxAgeMs)`            — TTL sweep, called from InMemoryMessageStore.runGC
 *
 * Memory:  Map<username → PendingMessage[]>
 * TTL:     Default 7 days — message is permanently lost after this window.
 *          Operators should set MSG_PENDING_TTL_MS env var to tune retention.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export class PendingMessageStore {
  private readonly store = new Map<string, PendingMessage[]>();
  private readonly maxPerUser: number;
  private readonly ttlMs: number;

  constructor() {
    // تبدیل ایمن رشته‌های env به عدد و اعمال پیش‌فرض‌های اصولی برای جلوگیری از Type Coercion
    const envMax = Number(env.MSG_STORE_MAX_PER_ROOM);
    const envTtl = Number(env.MSG_PENDING_TTL_MS);

    this.maxPerUser = envMax > 0 ? envMax : 200;
    this.ttlMs = envTtl > 0 ? envTtl : 120 * 24 * 60 * 60 * 1000; // پیش‌فرض قطعی: 120 روز
  }

  /**
   * Enqueue a pending message for an offline user.
   * Ring-buffer: oldest entry is dropped when per-user cap is exceeded.
   */
  add(toUsername: string, msg: ChatMessage): void {
    const key = toUsername.toLowerCase();
    if (!this.store.has(key)) {
      this.store.set(key, []);
    }
    const queue = this.store.get(key)!;
    queue.push({ ...msg, toUsername: key, createdAt: Date.now() });

    // Ring-buffer cap
    if (queue.length > this.maxPerUser) {
      queue.shift();
    }
  }

  /**
   * Return all pending messages for a user and remove them from the queue.
   * Called immediately when the user connects, before any other events.
   */
  flush(username: string): PendingMessage[] {
    const key = username.toLowerCase();
    const pending = this.store.get(key) ?? [];
    if (pending.length > 0) {
      this.store.delete(key); // optimistic delete — re-add on NACK if needed
    }
    return pending;
  }

  /**
   * Re-enqueue messages after a flush if the client did not ACK them.
   * Call this if the socket closes before receiving `messages_ack`.
   */
  requeue(username: string, messages: PendingMessage[]): void {
    if (messages.length === 0) return;
    const key = username.toLowerCase();
    const existing = this.store.get(key) ?? [];
    // Prepend so chronological order is preserved
    this.store.set(key, [...messages, ...existing]);
  }

  /**
   * Permanently remove specific message IDs after the client confirms receipt.
   * If `ids` is undefined, clears ALL pending for the user.
   */
  clear(username: string, ids?: string[]): void {
    const key = username.toLowerCase();
    if (!ids) {
      this.store.delete(key);
      return;
    }
    const idSet = new Set(ids);
    const remaining = (this.store.get(key) ?? []).filter((m) => !idSet.has(m.id));
    if (remaining.length === 0) {
      this.store.delete(key);
    } else {
      this.store.set(key, remaining);
    }
  }

  /** TTL sweep — removes expired pending messages. Called by the main GC. */
  gcOld(): void {
    const cutoff = Date.now() - this.ttlMs;
    let totalEvicted = 0;
    for (const [key, queue] of this.store.entries()) {
      const before = queue.length;
      const fresh = queue.filter((m) => m.createdAt > cutoff);
      if (fresh.length < before) {
        totalEvicted += before - fresh.length;
        if (fresh.length === 0) {
          this.store.delete(key);
        } else {
          this.store.set(key, fresh);
        }
      }
    }
    if (totalEvicted > 0) {
      console.log(`[PendingStore GC] Evicted ${totalEvicted} expired pending messages`);
    }
  }

  hasPending(username: string): boolean {
    const key = username.toLowerCase();
    return (this.store.get(key)?.length ?? 0) > 0;
  }

  stats(): { users: number; totalPending: number } {
    let total = 0;
    for (const q of this.store.values()) total += q.length;
    return { users: this.store.size, totalPending: total };
  }
}

// ─── Ephemeral Message Factory ────────────────────────────────────────────────
// هیچ پیامی در اینجا ذخیره نمی‌شود. فقط پیام‌ها ساخته می‌شوند.

class EphemeralMessageService {
  private gcTimer: NodeJS.Timeout | null = null;
  readonly pending: PendingMessageStore;
  private readonly gcIntervalMs: number;

  constructor(gcIntervalMs = 5 * 60 * 1000) {
    this.gcIntervalMs = gcIntervalMs;
    this.pending = new PendingMessageStore();
  }

  /** فقط شیء پیام را می‌سازد و XSS را پاکسازی می‌کند. هیچ چیزی در RAM ذخیره نمی‌شود. */
  createMessage(
    roomId: string,
    senderId: string,
    senderUsername: string,
    rawContent: string,
  ): ChatMessage {
    const sanitizedContent = filterXSS(rawContent, {
      whiteList: {},
      stripIgnoreTag: true,
      stripIgnoreTagBody: ['script', 'style'],
    });

    return {
      id: crypto.randomUUID(),
      roomId,
      senderId,
      senderUsername,
      content: sanitizedContent,
      timestamp: Date.now(),
    };
  }

  private runGarbageCollection(): void {
    // فقط پیام‌های آفلاین قدیمی (Pending) که اکسپایر شده‌اند را پاک می‌کند
    this.pending.gcOld();
    const ps = this.pending.stats();
    if (ps.totalPending > 0) {
      console.log(
        `[PendingStore GC] Active: ${ps.users} users, ${ps.totalPending} pending messages`,
      );
    }
  }

  startGC(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.runGarbageCollection(), this.gcIntervalMs);
    this.gcTimer.unref();
    console.log('[MessageStore GC] Pending messages garbage collector started');
  }

  stopGC(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
}

export const messageStore = new EphemeralMessageService();

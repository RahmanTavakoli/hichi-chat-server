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

interface RoomData {
  messages: ChatMessage[];
  lastActivity: number;
}

/**
 * InMemoryMessageStore
 *
 * Memory Management Strategy:
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. ROOM CAP       — Maximum `maxRooms` rooms tracked simultaneously.
 *                     When exceeded, the LRU (least recently used) room is evicted.
 * 2. PER-ROOM CAP   — Each room holds at most `maxPerRoom` messages.
 *                     A ring-buffer approach shifts out the oldest message first.
 * 3. TTL SWEEP      — A `setInterval` GC loop runs every `gcIntervalMs` and
 *                     removes rooms whose `lastActivity` is older than `ttlMs`.
 *                     This prevents ghost rooms from accumulating over time.
 * 4. XSS SANITIZATION — All message content is sanitized through `xss` before
 *                     storage so no script tags are ever persisted in memory.
 * 5. CONTENT SIZE   — Content is validated upstream via Zod (max 2000 chars).
 * ─────────────────────────────────────────────────────────────────────────────
 */
class InMemoryMessageStore {
  private readonly store = new Map<string, RoomData>();
  private gcTimer: NodeJS.Timeout | null = null;

  private readonly maxRooms: number;
  private readonly maxPerRoom: number;
  private readonly ttlMs: number;
  private readonly gcIntervalMs: number;

  constructor(
    maxRooms = env.MSG_STORE_MAX_ROOMS,
    maxPerRoom = env.MSG_STORE_MAX_PER_ROOM,
    ttlMs = env.MSG_STORE_TTL_MS,
    gcIntervalMs = 5 * 60 * 1000, // run GC every 5 minutes
  ) {
    this.maxRooms = maxRooms;
    this.maxPerRoom = maxPerRoom;
    this.ttlMs = ttlMs;
    this.gcIntervalMs = gcIntervalMs;
  }

  /** Add a message to a room with all safety constraints applied. */
  addMessage(
    roomId: string,
    senderId: string,
    senderUsername: string,
    rawContent: string,
  ): ChatMessage {
    const sanitizedContent = filterXSS(rawContent, {
      whiteList: {}, // strip ALL HTML tags
      stripIgnoreTag: true,
      stripIgnoreTagBody: ['script', 'style'],
    });

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      roomId,
      senderId,
      senderUsername,
      content: sanitizedContent,
      timestamp: Date.now(),
    };

    if (!this.store.has(roomId)) {
      // Enforce room cap via LRU eviction before inserting a new room
      if (this.store.size >= this.maxRooms) {
        this.evictLRURoom();
      }
      this.store.set(roomId, { messages: [], lastActivity: Date.now() });
    }

    const room = this.store.get(roomId)!;
    room.messages.push(message);
    room.lastActivity = Date.now();

    // Ring-buffer eviction: drop oldest when per-room cap exceeded
    if (room.messages.length > this.maxPerRoom) {
      room.messages.shift();
    }

    return message;
  }

  getHistory(roomId: string, limit = 50): ChatMessage[] {
    const room = this.store.get(roomId);
    if (!room) return [];

    room.lastActivity = Date.now();
    return room.messages.slice(-Math.min(limit, this.maxPerRoom));
  }

  /** Evict the room with the oldest lastActivity timestamp (LRU). */
  private evictLRURoom(): void {
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, data] of this.store.entries()) {
      if (data.lastActivity < lruTime) {
        lruTime = data.lastActivity;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.store.delete(lruKey);
      console.log(`[MessageStore] LRU eviction: room '${lruKey}' removed`);
    }
  }

  /** TTL-based GC: removes rooms inactive for longer than ttlMs. */
  private runGarbageCollection(): void {
    const now = Date.now();
    let evicted = 0;

    for (const [roomId, data] of this.store.entries()) {
      if (now - data.lastActivity > this.ttlMs) {
        this.store.delete(roomId);
        evicted++;
      }
    }

    if (evicted > 0) {
      console.log(
        `[MessageStore GC] Evicted ${evicted} stale rooms. Active rooms: ${this.store.size}`,
      );
    }
  }

  startGC(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.runGarbageCollection(), this.gcIntervalMs);
    // Prevent the timer from keeping the Node.js process alive
    this.gcTimer.unref();
    console.log('[MessageStore GC] Garbage collector started');
  }

  stopGC(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /** Diagnostic snapshot — never expose in production API responses. */
  getStats(): { totalRooms: number; totalMessages: number } {
    let totalMessages = 0;
    for (const data of this.store.values()) {
      totalMessages += data.messages.length;
    }
    return { totalRooms: this.store.size, totalMessages };
  }
}

// Singleton — one store per server process
export const messageStore = new InMemoryMessageStore();

import { z } from 'zod';

// ─── Username validation sub-schema (reused) ──────────────────────────────────
const usernameField = z
  .string()
  .min(1)
  .max(30)
  .regex(/^[a-zA-Z0-9_]+$/, 'Invalid username format');

// ─── Wire Message Schema ───────────────────────────────────────────────────────
// This is the Zod schema that validates every raw JSON frame arriving from
// a WebSocket client. Validated BEFORE any business logic runs.
//
// Event catalogue (Client → Server):
//  send_message  — send a DM to another user
//  get_history   — fetch recent in-memory history with a specific user
//  typing_start  — notify peer that we are typing
//  typing_stop   — notify peer that we stopped typing
//  ping          — application-level keep-alive (separate from ws protocol ping)
export const WsMessageSchema = z.discriminatedUnion('type', [
  // ── send_message ───────────────────────────────────────────────────────────
  z.object({
    type: z.literal('send_message'),
    /** Recipient's username */
    to: usernameField,
    /** Message text — max 2000 chars matches Zod + DB constraints */
    content: z.string().min(1, 'Message cannot be empty').max(2000, 'Message too long'),
    /** Client-generated UUID for optimistic UI deduplication */
    localId: z.string().uuid().optional(),
  }),

  // ── ack_pending ────────────────────────────────────────────────────────────
  // Client sends this after successfully persisting pending messages to Dexie.
  // Server uses IDs to remove them from pendingStore — preventing re-delivery.
  //
  // Partial ACK is intentional and supported:
  //   If the client saved 4 of 6 pending messages before a crash, it ACKs only
  //   those 4. The remaining 2 are re-delivered on the next connection.
  //
  // Max 200 IDs per ACK matches the per-user cap in pending.store.ts.
  z.object({
    type: z.literal('ack_pending'),
    ids: z
      .array(z.string().uuid())
      .min(1, 'ACK must include at least one message ID')
      .max(200, 'ACK batch too large'),
  }),

  // ── typing_start ───────────────────────────────────────────────────────────
  z.object({
    type: z.literal('typing_start'),
    to: usernameField,
  }),

  // ── typing_stop ────────────────────────────────────────────────────────────
  z.object({
    type: z.literal('typing_stop'),
    to: usernameField,
  }),

  // ── ping ───────────────────────────────────────────────────────────────────
  // Application-level keep-alive. Proxies (Render, nginx) kill idle WebSocket
  // connections after 55–90s. Sending a ping every ~25s prevents this.
  z.object({
    type: z.literal('ping'),
  }),
]);

export type WsMessage = z.infer<typeof WsMessageSchema>;

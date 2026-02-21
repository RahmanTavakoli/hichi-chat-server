import { z } from 'zod';

export const WsMessageSchema = z.object({
  type: z.enum(['join_room', 'leave_room', 'send_message', 'get_history']),
  roomId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid room ID'),
  content: z.string().min(1).max(2000).optional(),
});

export type WsMessage = z.infer<typeof WsMessageSchema>;

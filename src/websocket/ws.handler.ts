import { WebSocket } from 'ws';
import { WsMessageSchema } from '@/schemas/message.schema';
import { messageStore } from '@/services/message.store';
import { AuthenticatedWebSocket, wss } from './ws.server';

export function handleWsEvent(ws: AuthenticatedWebSocket, raw: unknown): void {
  // Validate payload shape and content via Zod
  const result = WsMessageSchema.safeParse(raw);

  if (!result.success) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
        errors: result.error.flatten().fieldErrors,
      }),
    );
    return;
  }

  const { type, roomId, content } = result.data;

  switch (type) {
    case 'join_room': {
      ws.currentRoom = roomId;
      const history = messageStore.getHistory(roomId, 50);
      ws.send(
        JSON.stringify({
          type: 'room_joined',
          roomId,
          history,
        }),
      );
      break;
    }

    case 'leave_room': {
      ws.currentRoom = null;
      ws.send(JSON.stringify({ type: 'room_left', roomId }));
      break;
    }

    case 'send_message': {
      if (!content) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message content is required' }));
        return;
      }

      if (ws.currentRoom !== roomId) {
        ws.send(JSON.stringify({ type: 'error', message: 'You are not in this room' }));
        return;
      }

      const message = messageStore.addMessage(
        roomId,
        ws.userId,
        ws.username,
        content,
      );

      // Broadcast to all clients in the same room
      broadcastToRoom(roomId, {
        type: 'new_message',
        message,
      });
      break;
    }

    case 'get_history': {
      const history = messageStore.getHistory(roomId, 50);
      ws.send(JSON.stringify({ type: 'history', roomId, messages: history }));
      break;
    }
  }
}

function broadcastToRoom(roomId: string, payload: unknown): void {
  const serialized = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    const authedClient = client as AuthenticatedWebSocket;
    if (authedClient.readyState === WebSocket.OPEN && authedClient.currentRoom === roomId) {
      authedClient.send(serialized);
    }
  });
}
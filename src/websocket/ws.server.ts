import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';

import { verifyAccessToken, type JwtPayload } from '@/services/auth.service';
import { broadcastPresence, deliverPendingMessages, handleWsEvent } from './ws.handler';
import { WsRateLimiter } from './ws.rateLimit';
import { wsLogger } from './ws.logger';
import { messageStore } from '@/services/message.store';

export interface AuthenticatedWebSocket extends WebSocket {
  userId: string;
  username: string;
  rateLimiter: WsRateLimiter;
  isAlive: boolean;
}

// ─── User Registry ────────────────────────────────────────────────────────────
// Maps username → active WebSocket for O(1) DM routing.
// Cleaned up on every disconnect to prevent stale references and memory leaks.
export const userRegistry = new Map<string, AuthenticatedWebSocket>();

let wss: WebSocketServer;

export function initWebSocketServer(server: http.Server): void {
  wss = new WebSocketServer({
    server,
    verifyClient: (
      info: { req: IncomingMessage; origin: string; secure: boolean },
      callback: (res: boolean, code?: number, message?: string) => void,
    ) => {
      verifyWsHandshake(info.req, callback);
    },
    maxPayload: 8 * 1024,
    clientTracking: true,
  });

  // ─── BUG FIX #1 ───────────────────────────────────────────────────────────
  // The native `ws` library passes the original IncomingMessage as the SECOND
  // argument to the 'connection' event. The previous code omitted `req`,
  // causing `ws.username` and `ws.userId` to be `undefined` for every connection.
  wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
    // ── Transfer auth data from handshake to the WS object ─────────────────
    const wsUser = (req as IncomingMessage & { _wsUser?: JwtPayload })._wsUser;

    // Safety net: verifyClient already validated the token, but guard anyway
    if (!wsUser?.sub || !wsUser?.username) {
      wsLogger.error('Connection without valid wsUser payload — terminating immediately', {});
      ws.terminate();
      return;
    }

    ws.userId = wsUser.sub;
    ws.username = wsUser.username;
    ws.isAlive = true;
    ws.rateLimiter = new WsRateLimiter(100, 10_000); // 100 events / 10 s

    // ── Register in the routing table ─────────────────────────────────────
    // If the same user reconnects (e.g. refresh), evict the old socket first
    const existingSocket = userRegistry.get(ws.username);
    if (existingSocket && existingSocket !== ws) {
      wsLogger.warn('Duplicate connection — evicting old socket', { username: ws.username });
      existingSocket.terminate();
    }
    userRegistry.set(ws.username, ws);

    wsLogger.info('Client connected', {
      username: ws.username,
      userId: ws.userId,
      clientCount: userRegistry.size,
    });

    // ── NEW: Broadcast online presence to all connected peers ────────────
    broadcastPresence(ws.username, 'online');

    // ── NEW: Deliver any queued offline messages immediately ──────────────
    // This runs AFTER userRegistry.set so the client can receive the frame.
    // The frame arrives before any UI interaction, ensuring inbox is full
    // as soon as the connection is established.
    deliverPendingMessages(ws);

    // ── Message handler ───────────────────────────────────────────────────
    ws.on('message', (rawData) => {
      if (!ws.rateLimiter.isAllowed()) {
        wsLogger.warn('Rate limit hit — message dropped', { username: ws.username });
        ws.send(
          JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Slow down.', code: 4003 }),
        );
        return;
      }

      let parsed: unknown;
      try {
        const text = rawData.toString('utf-8').slice(0, 8192);
        parsed = JSON.parse(text);
      } catch {
        wsLogger.warn('Unparseable message received', { username: ws.username });
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload', code: 4001 }));
        return;
      }

      wsLogger.debug('Message received', {
        username: ws.username,
        event: (parsed as Record<string, unknown>)?.type as string,
      });

      handleWsEvent(ws, parsed);
    });

    // ── Heartbeat pong ─────────────────────────────────────────────────────
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // ── Cleanup on disconnect ──────────────────────────────────────────────
    ws.on('close', (code, reason) => {
      // ── NEW: Requeue un-ACKed pending messages ──
      // اگر پیام‌هایی برای کلاینت ارسال شده اما تاییدیه‌ای دریافت نشد، آن‌ها را به صف بازگردان
      const flushed = (ws as any)._pendingFlushed;
      if (flushed && flushed.length > 0) {
        wsLogger.warn('Socket closed before ACK. Requeueing pending messages.', {
          username: ws.username,
          count: flushed.length,
        });
        messageStore.pending.requeue(ws.username, flushed);
      }

      // Only remove from registry if this is the current socket for that user
      if (userRegistry.get(ws.username) === ws) {
        userRegistry.delete(ws.username);
      }

      broadcastPresence(ws.username, 'offline');

      wsLogger.info('Client disconnected', {
        username: ws.username,
        code,
        reason: reason.toString(),
        clientCount: userRegistry.size,
      });
    });

    ws.on('error', (err) => {
      wsLogger.error('Socket error', { username: ws.username, error: err.message });
    });
  });

  // ─── Heartbeat Loop ────────────────────────────────────────────────────────
  // Terminates ghost connections (e.g. browser tab closed without TCP FIN)
  const heartbeatInterval = setInterval(() => {
    let terminated = 0;
    wss.clients.forEach((rawWs) => {
      const ws = rawWs as AuthenticatedWebSocket;
      if (!ws.isAlive) {
        wsLogger.warn('Terminating stale connection', { username: ws.username });
        ws.terminate();
        terminated++;
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
    if (terminated > 0) {
      wsLogger.info('Heartbeat sweep complete', { terminated, active: userRegistry.size });
    }
  }, 30_000);

  // timer.unref() ensures the heartbeat does NOT keep the process alive
  // after all other async work is done — critical for graceful shutdown
  heartbeatInterval.unref();

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    wsLogger.info('WebSocket server closed', {});
  });

  wsLogger.info('WebSocket server initialized', {});
}

// ─── Handshake Verification ────────────────────────────────────────────────────
// Runs BEFORE the HTTP → WebSocket upgrade is accepted at the TCP level.
// Rejecting here means the socket is never opened — no resource is allocated.
function verifyWsHandshake(
  req: IncomingMessage,
  callback: (res: boolean, code?: number, message?: string) => void,
): void {
  try {
    let token: string | undefined;

    // Priority 1: HttpOnly signed cookie `ws_token`
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const cookies = parseCookie(cookieHeader);
      token = cookies['ws_token'];
    }

    // Priority 2: ?token= query parameter (for native/mobile clients)
    // Note: query params appear in server access logs; keep tokens short-lived
    if (!token) {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      token = url.searchParams.get('token') ?? undefined;
    }

    if (!token) {
      wsLogger.warn('Handshake rejected: no token', {});
      return callback(false, 401, 'Unauthorized: No authentication token provided');
    }

    const payload = verifyAccessToken(token);

    // Attach to request for the 'connection' handler to consume
    (req as IncomingMessage & { _wsUser?: JwtPayload })._wsUser = payload;

    wsLogger.debug('Handshake accepted', { username: payload.username });
    callback(true);
  } catch (err) {
    wsLogger.warn('Handshake rejected: invalid token', { error: (err as Error).message });
    callback(false, 401, 'Unauthorized: Invalid or expired token');
  }
}

export { wss };

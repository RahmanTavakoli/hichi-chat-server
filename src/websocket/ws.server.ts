import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseCookie } from 'cookie';

import { verifyAccessToken, JwtPayload } from '@/services/auth.service';
import { handleWsEvent } from './ws.handler';
import { WsRateLimiter } from './ws.rateLimit';

export interface AuthenticatedWebSocket extends WebSocket {
  userId: string;
  username: string;
  currentRoom: string | null;
  rateLimiter: WsRateLimiter;
  isAlive: boolean;
}

let wss: WebSocketServer;

export function initWebSocketServer(server: http.Server): void {
  wss = new WebSocketServer({
    server,
    // Enforce strict upgrade authentication before the WS connection is established
    verifyClient: (
      info: { req: IncomingMessage; origin: string; secure: boolean },
      callback: (res: boolean, code?: number, message?: string) => void,
    ) => {
      verifyWsHandshake(info.req, callback);
    },
    maxPayload: 8 * 1024, // 8kb max frame size
    clientTracking: true,
  });

  wss.on('connection', (ws: AuthenticatedWebSocket) => {
    ws.isAlive = true;
    ws.currentRoom = null;
    ws.rateLimiter = new WsRateLimiter(20, 10_000); // 20 events per 10s per connection

    console.log(`[WSS] Client connected: ${ws.username} (${ws.userId})`);

    ws.on('message', (rawData) => {
      // Enforce rate limit per connection before any processing
      if (!ws.rateLimiter.isAllowed()) {
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Slow down.' }));
        return;
      }

      let parsed: unknown;
      try {
        // Hard-cap parsed size & ensure valid JSON
        const text = rawData.toString('utf-8').slice(0, 8192);
        parsed = JSON.parse(text);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
        return;
      }

      handleWsEvent(ws, parsed);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => {
      console.log(`[WSS] Client disconnected: ${ws.username}`);
    });

    ws.on('error', (err) => {
      console.error(`[WSS] Error for user ${ws.username}:`, err.message);
    });
  });

  // Heartbeat: ping all clients every 30s, terminate stale connections
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((rawWs) => {
      const ws = rawWs as AuthenticatedWebSocket;
      if (!ws.isAlive) {
        console.log(`[WSS] Terminating stale connection: ${ws.username}`);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  heartbeatInterval.unref();

  wss.on('close', () => clearInterval(heartbeatInterval));
  console.log('[WSS] WebSocket server initialized');
}

/**
 * Handshake verification: runs BEFORE the WebSocket upgrade is accepted.
 * Rejects the entire TCP upgrade if the JWT is missing or invalid.
 */
function verifyWsHandshake(
  req: IncomingMessage,
  callback: (res: boolean, code?: number, message?: string) => void,
): void {
  try {
    let token: string | undefined;

    // 1. Try cookie (preferred for browser clients)
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      const cookies = parseCookie(cookieHeader);
      // Signed cookies require express cookie-parser — parse the raw value here
      // For simplicity, the WS client can also pass an unsigned short-lived token
      token = cookies['ws_token'];
    }

    // 2. Try query param (useful for native clients where cookies aren't available)
    // NOTE: query params appear in server logs — only use as fallback for non-browser
    if (!token) {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const queryToken = url.searchParams.get('token');
      if (queryToken) token = queryToken;
    }

    if (!token) {
      console.warn('[WSS] Rejected: No token in handshake');
      return callback(false, 401, 'Unauthorized: No authentication token provided');
    }

    const payload = verifyAccessToken(token);

    // Attach auth data directly to the request so we can transfer to the WS object
    (req as IncomingMessage & { _wsUser?: JwtPayload })._wsUser = payload;

    callback(true);
  } catch (err) {
    console.warn('[WSS] Rejected: Invalid token -', (err as Error).message);
    callback(false, 401, 'Unauthorized: Invalid or expired token');
  }
}

export { wss };
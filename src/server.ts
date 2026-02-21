import http from 'http';
import { createApp } from './app';
import { connectDB } from '@/config/db';
import { env } from '@/config/env';
import { initWebSocketServer } from '@/websocket/ws.server';
import { messageStore } from '@/services/message.store';

async function bootstrap(): Promise<void> {
  // Connect DB before accepting any traffic
  await connectDB();

  const app = createApp();
  const httpServer = http.createServer(app);

  // Attach WSS to the same HTTP server (shares port)
  initWebSocketServer(httpServer);

  // Start in-memory store garbage collector
  messageStore.startGC();

  const server = httpServer.listen(env.PORT, () => {
    console.log(`🚀 Server running on port ${env.PORT} [${env.NODE_ENV}]`);
  });

  // ─── Graceful Shutdown ──────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    messageStore.stopGC();
    server.close(async () => {
      const { disconnectDB } = await import('@/config/db.js');
      await disconnectDB();
      console.log('✅ Clean shutdown complete.');
      process.exit(0);
    });

    // Force kill after 10s
    setTimeout(() => {
      console.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    shutdown('unhandledRejection');
  });
}

bootstrap();

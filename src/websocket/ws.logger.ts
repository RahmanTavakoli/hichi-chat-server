import { env } from '@/config/env';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface LogContext {
  username?: string;
  userId?: string;
  event?: string;
  to?: string;
  roomId?: string;
  msgId?: string;
  clientCount?: number;
  [key: string]: unknown;
}

function timestamp(): string {
  return new Date().toISOString();
}

function format(level: LogLevel, message: string, ctx: LogContext): string {
  const ctxStr = Object.keys(ctx).length ? ' ' + JSON.stringify(ctx) : '';
  return `[${timestamp()}] [WSS:${level}] ${message}${ctxStr}`;
}

const isDev = env.NODE_ENV !== 'production';

export const wsLogger = {
  debug(message: string, ctx: LogContext = {}): void {
    if (isDev) console.debug(format('DEBUG', message, ctx));
  },
  info(message: string, ctx: LogContext = {}): void {
    console.info(format('INFO', message, ctx));
  },
  warn(message: string, ctx: LogContext = {}): void {
    console.warn(format('WARN', message, ctx));
  },
  error(message: string, ctx: LogContext = {}): void {
    console.error(format('ERROR', message, ctx));
  },
};

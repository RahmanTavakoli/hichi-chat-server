import { Request, Response, NextFunction } from 'express';
import { env } from '@/config/env';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = err.statusCode ?? 500;

  // Never leak stack traces or internal details in production
  const response: Record<string, unknown> = {
    status: 'error',
    message: err.isOperational ? err.message : 'An unexpected error occurred',
  };

  if (env.NODE_ENV === 'development') {
    response['stack'] = err.stack;
    response['detail'] = err.message;
  }

  console.error(`[${new Date().toISOString()}] Error ${statusCode}:`, err.message);

  res.status(statusCode).json(response);
}

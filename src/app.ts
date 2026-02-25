import express, { Application, Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { corsOptions } from '@/config/corsOptions';
import { env } from '@/config/env';
import { globalRateLimiter } from '@/middleware/rateLimiter';
import { errorHandler } from '@/middleware/errorHandler';
import authRoutes from '@/routes/auth.routes';
import userRoutes from '@/routes/user.routes';

export function createApp(): Application {
  const app = express();

  // ─── Proxy Configuration (Security & Rate Limiter) ─────────────────────────
  app.set('trust proxy', 1);

  // ─── HTTP Security Headers ─────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
      hsts: {
        maxAge: 63072000, // 2 years
        includeSubDomains: true,
        preload: true,
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      frameguard: { action: 'deny' },
      noSniff: true,
      xssFilter: true,
    }),
  );

  // ─── CORS (strict whitelist) ───────────────────────────────────────────────
  app.use(cors(corsOptions));

  // ─── Body Parsing ──────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10kb' })); // hard cap to prevent payload bombs
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(cookieParser(env.COOKIE_SECRET));

  // ─── Disable fingerprinting ────────────────────────────────────────────────
  app.disable('x-powered-by');
  app.disable('etag');

  //! JUST route for prevent Crash App & Redirect to Client
  app.get('/', globalRateLimiter, (_req: Request, res: Response) => {
    res.redirect('https://digikala.ir');
  });

  // ─── Global Rate Limiter ───────────────────────────────────────────────────
  app.use('/api', globalRateLimiter);

  // ─── Routes ────────────────────────────────────────────────────────────────
  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/users', userRoutes);

  // ─── 404 Handler ──────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ status: 'error', message: 'Resource not found' });
  });

  // ─── Global Error Handler ──────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}

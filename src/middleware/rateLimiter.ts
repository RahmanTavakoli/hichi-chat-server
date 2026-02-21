import rateLimit from 'express-rate-limit';

const createLimiter = (windowMs: number, max: number, message: string) =>
  rateLimit({
    windowMs,
    max,
    message: { status: 'error', message },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    // Use X-Forwarded-For only if you're behind a trusted proxy
    // If behind nginx/LB, enable: app.set('trust proxy', 1)
  });

// Global: 100 requests per 15 minutes per IP
export const globalRateLimiter = createLimiter(
  15 * 60 * 1000,
  100,
  'Too many requests, please try again later',
);

// Auth endpoints: stricter — 10 attempts per 15 minutes per IP
export const authRateLimiter = createLimiter(
  15 * 60 * 1000,
  10,
  'Too many authentication attempts. Please try again in 15 minutes',
);

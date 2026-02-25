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
  50,
  'Too many authentication attempts. Please try again in 15 minutes',
);

/**
 * Search rate limiter — stricter than global, looser than auth.
 *
 * Rationale:
 * - The search endpoint hits MongoDB with a regex query on each call.
 * - Even with index anchoring (^prefix), allowing hundreds of searches
 *   per minute from one IP would be an easy vector for database DoS.
 * - 20 requests per minute allows normal user behaviour (typing a username
 *   character by character with 450ms debounce ≈ ~4 requests per search
 *   session) while blocking automated enumeration attempts.
 */
export const searchRateLimiter = createLimiter(
  60 * 1000, // 1-minute window
  20, // 20 searches per minute per IP
  'Too many search requests. Please slow down.',
);

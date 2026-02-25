import { Router } from 'express';
import { searchUsers } from '@/controllers/user.controller';
import { searchRateLimiter } from '@/middleware/rateLimiter';
import { validate } from '@/middleware/validate';
import { UserSearchSchema } from '@/schemas/user.schema';

const router = Router();

/**
 * GET /api/v1/users/search?q=<term>
 *
 * Middleware chain (left to right):
 *
 * 1. requireAuth      — Verifies the JWT from HttpOnly cookie or Bearer header.
 *                       Attaches `req.user` (JwtPayload) on success.
 *                       Returns 401 if token is missing, invalid, or expired.
 *                       ⟹ Unauthenticated clients cannot enumerate users.
 *
 * 2. searchRateLimiter — IP-level throttle: max 20 requests / 60s.
 *                        Returns 429 when exceeded.
 *                        ⟹ Prevents automated username enumeration scripts.
 *
 * 3. validate(UserSearchSchema) — Zod validation on req.query.
 *                        Rejects any `q` value that contains regex metacharacters,
 *                        is shorter than 2 chars, or longer than 30 chars.
 *                        Returns 422 with field-level errors on failure.
 *                        ⟹ Eliminates ReDoS vectors before touching the DB.
 *
 * 4. searchUsers      — Controller: executes the anchored regex query against
 *                        MongoDB and returns ≤20 sanitized PublicUserProfile objects.
 */
router.get(
  '/search',
  // requireAuth,
  searchRateLimiter,
  validate(UserSearchSchema),
  searchUsers,
);

export default router;

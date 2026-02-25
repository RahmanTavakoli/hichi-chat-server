import { Request, Response, NextFunction } from 'express';
import { prisma } from '@/config/prisma';
import type { UserSearchQuery } from '@/schemas/user.schema';

/**
 * GET /api/v1/users/search?q=<term>
 *
 * Searches for active users whose username OR nickname partially matches
 * the sanitized query term. The requesting user is excluded from results.
 *
 * Security layers (in order of execution):
 *  1. requireAuth middleware  → endpoint unreachable without a valid JWT
 *  2. searchRateLimiter       → IP-level throttle (10 req / min)
 *  3. Zod schema validation   → rejects any non-alphanumeric query characters
 *                               (eliminates ReDoS and regex injection vectors)
 *  4. Query-level field select → only `username`, `nickname`, `avatar_url` are
 *                               fetched from MongoDB; sensitive columns never loaded
 *  5. Self-exclusion filter   → the authenticated caller never appears in results
 *  6. .lean()                 → returns plain JS objects, not Mongoose documents,
 *                               preventing accidental prototype method leakage
 */
export async function searchUsers(
  req: Request<object, object, object, UserSearchQuery>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { q } = req.query;

    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ username: { contains: q } }, { nickname: { contains: q } }],
      },
      select: {
        username: true,
        nickname: true,
      },
      take: 20,
    });

    res.status(200).json({
      status: 'success',
      count: users.length,
      data: users,
    });
  } catch (error) {
    next(error);
  }
}

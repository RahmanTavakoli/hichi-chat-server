import { z } from 'zod';

/**
 * Validates the `q` query parameter for the user search endpoint.
 *
 * Security constraints:
 * - Minimum 2 characters: prevents full-collection scans on empty/single-char queries
 * - Maximum 30 characters: caps regex complexity to match username max length
 * - Regex whitelist: only alphanumeric + underscore characters are allowed.
 *   This ELIMINATES the risk of a ReDoS attack or a MongoDB regex injection,
 *   since special regex metacharacters (., *, +, (, ), [, ], ^, $, |, ?)
 *   are all rejected at the validation layer before touching the database.
 */
export const UserSearchSchema = z.object({
  query: z.object({
    q: z
      .string('Search query is required')
      .min(2, 'Query must be at least 2 characters')
      .max(30, 'Query must be at most 30 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Query may only contain letters, numbers, and underscores'),
  }),
});

export type UserSearchQuery = z.infer<typeof UserSearchSchema>['query'];

import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be under 128 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const RegisterSchema = z.object({
  body: z.object({
    username: z
      .string()
      .min(3)
      .max(30)
      .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'),
    nickname: z.string().max(254).toLowerCase(),
    password: passwordSchema,
  }),
});

export const LoginSchema = z.object({
  body: z.object({
    username: z.string().max(254).toLowerCase(),
    password: z.string().min(1).max(128),
  }),
});

export type RegisterBody = z.infer<typeof RegisterSchema>['body'];
export type LoginBody = z.infer<typeof LoginSchema>['body'];

import { Router } from 'express';
import { register, login, refresh, logout } from '@/controllers/auth.controller';
import { validate } from '@/middleware/validate';
import { requireAuth } from '@/middleware/auth.middleware';
import { authRateLimiter } from '@/middleware/rateLimiter';
import { RegisterSchema, LoginSchema } from '@/schemas/auth.schema';

const router = Router();

router.post('/register', authRateLimiter, validate(RegisterSchema), register);
router.post('/login', authRateLimiter, validate(LoginSchema), login);
router.post('/refresh', authRateLimiter, refresh);
router.post('/logout', requireAuth, logout);

export default router;
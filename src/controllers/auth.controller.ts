import { Request, Response, NextFunction } from 'express';
import { prisma } from '@/config/prisma';
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashRefreshToken,
} from '@/services/auth.service';
import { env } from '@/config/env';
import type { RegisterBody, LoginBody } from '@/schemas/auth.schema';

const COOKIE_BASE_OPTIONS = {
  // httpOnly: true,
  secure: env.NODE_ENV === 'production',
  signed: true,
};

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 دقیقه

export async function register(
  req: Request<object, object, RegisterBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { username, nickname, password } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { username } });

    if (existingUser) {
      res.status(409).json({
        status: 'error',
        message: 'Account with these credentials already exists',
      });
      return;
    }

    const passwordHash = await hashPassword(password);

    // جایگزین User.create
    const user = await prisma.user.create({
      data: {
        username,
        nickname,
        passwordHash,
      },
    });

    res.status(201).json({
      status: 'success',
      message: 'User registered successfully',
      data: { userId: user.id, username: user.username },
    });
  } catch (error) {
    next(error);
  }
}

export async function login(
  req: Request<object, object, LoginBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { username, password } = req.body;

    // جایگزین User.findOne
    const user = await prisma.user.findUnique({
      where: { username },
    });

    // بررسی قفل بودن حساب
    if (user && user.lockUntil && user.lockUntil > new Date()) {
      res.status(423).json({
        status: 'error',
        message: 'Account temporarily locked due to multiple failed login attempts',
      });
      return;
    }

    const DUMMY_HASH = '$argon2id$v=19$m=65536,t=4,p=2$placeholder$placeholder';
    const passwordHash = user?.passwordHash ?? DUMMY_HASH;
    const isValid = await verifyPassword(passwordHash, password);

    if (!user || !user.isActive || !isValid) {
      if (user) {
        // بازنویسی منطق incrementLoginAttempts از user.model.ts
        let attempts = user.loginAttempts;
        let newLockUntil = user.lockUntil;

        if (user.lockUntil && user.lockUntil < new Date()) {
          attempts = 1;
          newLockUntil = null;
        } else {
          attempts += 1;
          if (attempts >= MAX_LOGIN_ATTEMPTS) {
            newLockUntil = new Date(Date.now() + LOCK_DURATION_MS);
          }
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { loginAttempts: attempts, lockUntil: newLockUntil },
        });
      }

      res.status(401).json({
        status: 'error',
        message: 'Invalid credentials',
      });
      return;
    }

    // لاگین موفق: ریست کردن خطاها
    await prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 0, lockUntil: null },
    });

    const payload = { sub: user.id, username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: hashRefreshToken(refreshToken) },
    });

    res.cookie('refreshToken', refreshToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth/refresh',
    });

    res.cookie('accessToken', accessToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    });

    res.status(200).json({
      status: 'success',
      message: 'Logged in successfully',
      token: accessToken,
      username: user.username,
      nickname: user.nickname,
    });
  } catch (error) {
    next(error);
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  try {
    const token = req.signedCookies?.refreshToken as string | undefined;

    if (!token) {
      res.status(401).json({ status: 'error', message: 'No refresh token provided' });
      return;
    }

    const payload = verifyRefreshToken(token);

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        username: true,
        nickname: true,
        refreshTokenHash: true,
      },
    });

    if (!user || user.refreshTokenHash !== hashRefreshToken(token)) {
      // Potential token reuse attack → invalidate session
      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: { refreshTokenHash: null },
        });
      }

      res.clearCookie('refreshToken').clearCookie('accessToken');
      res.status(401).json({
        status: 'error',
        message: 'Refresh token invalid or reused',
      });
      return;
    }

    const newPayload = {
      sub: user.id,
      username: user.username,
    };

    const newAccessToken = signAccessToken(newPayload);
    const newRefreshToken = signRefreshToken(newPayload);

    // Rotate refresh token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash: hashRefreshToken(newRefreshToken),
      },
    });

    res.cookie('accessToken', newAccessToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', newRefreshToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth/refresh',
    });

    res.status(200).json({
      status: 'success',
      message: 'Token refreshed',
      token: newAccessToken,
      username: user.username,
      nickname: user.nickname || user.username,
    });
  } catch {
    res.status(401).json({
      status: 'error',
      message: 'Invalid refresh token',
    });
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user) {
      await prisma.user.update({
        where: { id: req.user.sub },
        data: {
          refreshTokenHash: null,
        },
      });
    }
    res
      .clearCookie('accessToken')
      .clearCookie('refreshToken', { path: '/api/v1/auth/refresh' })
      .status(200)
      .json({ status: 'success', message: 'Logged out successfully' });
  } catch (error) {
    next(error);
  }
}

import { Request, Response, NextFunction } from 'express';
import { User } from '@/models/user.model';
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
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  signed: true,
};

export async function register(
  req: Request<object, object, RegisterBody>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { username, email, password } = req.body;

    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    }).lean();

    if (existingUser) {
      // Use same message for both cases to prevent username/email enumeration
      res.status(409).json({
        status: 'error',
        message: 'Account with these credentials already exists',
      });
      return;
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      username,
      email,
      passwordHash,
    });

    res.status(201).json({
      status: 'success',
      message: 'Account created successfully',
      data: { userId: user._id, username: user.username },
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
    const { email, password } = req.body;

    // Explicitly select passwordHash and lockUntil — excluded by default
    const user = await User.findOne({ email, isActive: true }).select(
      '+passwordHash +refreshTokenHash +loginAttempts +lockUntil',
    );

    // Constant-time response: always run verify even if user not found
    // to prevent timing-based user enumeration
    const DUMMY_HASH = '$argon2id$v=19$m=65536,t=4,p=2$placeholder$placeholder';
    const passwordHash = user?.passwordHash ?? DUMMY_HASH;
    const isValid = await verifyPassword(passwordHash, password);

    if (!user || !isValid) {
      if (user) await user.incrementLoginAttempts();
      res.status(401).json({
        status: 'error',
        message: 'Invalid credentials',
      });
      return;
    }

    if (user.isLocked) {
      res.status(423).json({
        status: 'error',
        message: 'Account temporarily locked due to multiple failed login attempts',
      });
      return;
    }

    // Successful login — reset attempt counter
    await user.updateOne({ $set: { loginAttempts: 0, lockUntil: null } });

    const payload = { sub: user._id.toString(), username: user.username };
    const accessToken = signAccessToken(payload);
    const refreshToken = signRefreshToken(payload);

    // Store only the hash of refresh token for breach resistance
    await user.updateOne({ $set: { refreshTokenHash: hashRefreshToken(refreshToken) } });

    // Set tokens as signed HttpOnly cookies
    res.cookie('accessToken', accessToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 15 * 60 * 1000, // 15 minutes
    });

    res.cookie('refreshToken', refreshToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/api/v1/auth/refresh', // Limit refresh cookie scope
    });

    res.status(200).json({
      status: 'success',
      message: 'Logged in successfully',
      data: { userId: user._id, username: user.username },
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
    const user = await User.findById(payload.sub).select('+refreshTokenHash');

    if (!user || user.refreshTokenHash !== hashRefreshToken(token)) {
      // Potential token reuse attack: invalidate all sessions
      if (user) await user.updateOne({ $set: { refreshTokenHash: null } });
      res.clearCookie('refreshToken').clearCookie('accessToken');
      res.status(401).json({ status: 'error', message: 'Refresh token invalid or reused' });
      return;
    }

    const newPayload = { sub: user._id.toString(), username: user.username };
    const newAccessToken = signAccessToken(newPayload);
    const newRefreshToken = signRefreshToken(newPayload);

    // Rotate refresh token
    await user.updateOne({ $set: { refreshTokenHash: hashRefreshToken(newRefreshToken) } });

    res.cookie('accessToken', newAccessToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 15 * 60 * 1000,
    });
    res.cookie('refreshToken', newRefreshToken, {
      ...COOKIE_BASE_OPTIONS,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth/refresh',
    });

    res.status(200).json({ status: 'success', message: 'Token refreshed' });
  } catch {
    res.status(401).json({ status: 'error', message: 'Invalid refresh token' });
  }
}

export async function logout(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user) {
      await User.findByIdAndUpdate(req.user.sub, { $set: { refreshTokenHash: null } });
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

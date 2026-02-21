import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, JwtPayload } from '@/services/auth.service';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    let token: string | undefined;

    // 1. Prefer HttpOnly cookie
    if (req.signedCookies?.accessToken) {
      token = req.signedCookies.accessToken as string;
    }
    // 2. Fall back to Authorization: Bearer header
    else if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      res.status(401).json({ status: 'error', message: 'Authentication required' });
      return;
    }

    const payload = verifyAccessToken(token);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

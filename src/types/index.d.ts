import 'ws';
import { JwtPayload } from '@services/auth.service';

declare module 'ws' {
  interface WebSocket {
    userId: string;
    username: string;
    currentRoom: string | null;
    isAlive: boolean;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}
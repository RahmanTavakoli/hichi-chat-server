import { CorsOptions } from 'cors';
import { env } from './env';

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server requests with no origin only in dev
    if (!origin && env.NODE_ENV === 'development') {
      return callback(null, true);
    }

    if (origin && env.ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error(`CORS policy violation: origin '${origin}' not allowed`));
  },
  credentials: true, // Required for HttpOnly cookie transport
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: [],
  maxAge: 600, // 10 minutes preflight cache
  optionsSuccessStatus: 204,
};

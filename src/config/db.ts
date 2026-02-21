import mongoose from 'mongoose';
import { env } from './env';

const MONGOOSE_OPTIONS: mongoose.ConnectOptions = {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  maxPoolSize: 10,
  minPoolSize: 2,
  autoIndex: env.NODE_ENV !== 'production', // disable auto-index in prod
};

export async function connectDB(): Promise<void> {
  try {
    mongoose.set('strictQuery', true);

    // Prevent mongoose from leaking query details in errors
    mongoose.set('debug', false);

    await mongoose.connect(env.MONGO_URI, MONGOOSE_OPTIONS);
    console.log('✅ MongoDB connected');

    mongoose.connection.on('error', (err) => {
      console.error('MongoDB runtime error:', err.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB disconnected. Reconnecting...');
    });
  } catch (error) {
    console.error('❌ MongoDB connection failed:', (error as Error).message);
    process.exit(1);
  }
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
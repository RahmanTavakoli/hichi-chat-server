import { Schema, model, Document, Model } from 'mongoose';

export interface IUser {
  username: string;
  email: string;
  passwordHash?: string;
  refreshTokenHash?: string | null; // store only hash of refresh token
  loginAttempts: number;
  lockUntil?: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUserDocument extends IUser, Document {
  isLocked: boolean;
  incrementLoginAttempts(): Promise<void>;
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

const UserSchema = new Schema<IUserDocument>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      // Only alphanumeric + underscores — prevents injection via username field
      match: [/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers, and underscores'],
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email format'],
    },
    passwordHash: {
      type: String,
      required: true,
      select: false, // NEVER returned by default in queries
    },
    refreshTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    // Prevent __v field from leaking schema version
    versionKey: false,
    // Remove sensitive fields from all toJSON calls
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        delete ret.refreshTokenHash;
        delete ret.lockUntil;
        return ret;
      },
    },
  },
);

// Virtual: is account currently locked?
UserSchema.virtual('isLocked').get(function (this: IUserDocument): boolean {
  return !!(this.lockUntil && this.lockUntil > new Date());
});

// Method: increment failed login attempts & apply lockout
UserSchema.methods.incrementLoginAttempts = async function (
  this: IUserDocument,
): Promise<void> {
  // If lock expired, reset
  if (this.lockUntil && this.lockUntil < new Date()) {
    await this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 },
    });
    return;
  }

  const update: Record<string, unknown> = { $inc: { loginAttempts: 1 } };

  if (this.loginAttempts + 1 >= MAX_LOGIN_ATTEMPTS && !this.isLocked) {
    update['$set'] = { lockUntil: new Date(Date.now() + LOCK_DURATION_MS) };
  }

  await this.updateOne(update);
};

// Index for fast lookup, TTL queries
UserSchema.index({ email: 1 });
UserSchema.index({ username: 1 });

export const User: Model<IUserDocument> = model<IUserDocument>('User', UserSchema);
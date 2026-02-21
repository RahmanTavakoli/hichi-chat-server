/**
 * Per-connection sliding window rate limiter for WebSocket messages.
 * Tracks event timestamps in a compact array; older entries are dropped.
 */
export class WsRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly maxEvents: number;
  private readonly windowMs: number;

  constructor(maxEvents: number, windowMs: number) {
    this.maxEvents = maxEvents;
    this.windowMs = windowMs;
  }

  isAllowed(): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Discard timestamps outside the current window
    while (this.timestamps.length > 0 && this.timestamps[0] < windowStart) {
      this.timestamps.shift();
    }

    if (this.timestamps.length >= this.maxEvents) {
      return false;
    }

    this.timestamps.push(now);
    return true;
  }

  reset(): void {
    this.timestamps.length = 0;
  }
}

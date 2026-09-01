const TOP_APPROACH_COOLDOWN_MS = 900;

/**
 * One explicit upward gesture grants one history request. Range responses and
 * virtualizer remeasurement can re-run proximity checks, but cannot manufacture
 * another grant. Continued wheel/touch input records another grant and fires as
 * soon as the cooldown allows.
 */
export class TranscriptTopApproachGate {
  private pendingIntent = false;
  private lastFire = Number.NEGATIVE_INFINITY;

  request() {
    this.pendingIntent = true;
  }

  reset() {
    this.pendingIntent = false;
    this.lastFire = Number.NEGATIVE_INFINITY;
  }

  shouldFire(nearTop: boolean, now: number): boolean {
    if (
      !this.pendingIntent ||
      !nearTop ||
      now - this.lastFire < TOP_APPROACH_COOLDOWN_MS
    )
      return false;
    this.pendingIntent = false;
    this.lastFire = now;
    return true;
  }
}

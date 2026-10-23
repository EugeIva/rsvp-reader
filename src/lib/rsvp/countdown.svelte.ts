/**
 * Reading countdown: counts the configured time down while RSVP plays, and
 * calls `onExpire` when it reaches zero. Time is measured against a fixed end
 * time (Date.now()), not by counting interval ticks, which run late and drift.
 */
export class Countdown {
    /** Seconds left, rounded up; 0 when not counting. */
    remaining = $state(0);
    private interval: ReturnType<typeof setInterval> | null = null;
    // Exact time left while paused, and the end time while running.
    private remainingMs = 0;
    private endAt = 0;

    /**
     * @param totalSeconds the configured duration (0 = no countdown)
     * @param onExpire called when the countdown reaches zero
     */
    constructor(
        private totalSeconds: () => number,
        private onExpire: () => void,
    ) {}

    /** Start from the full configured duration (no-op if none is set). */
    start() {
        const total = this.totalSeconds();
        if (total <= 0) return;
        this.remainingMs = total * 1000;
        this.run();
    }

    pause() {
        if (this.interval) this.remainingMs = Math.max(0, this.endAt - Date.now());
        this.clear();
    }

    /** Continue a paused countdown (no-op if none is set or it already ran out). */
    resume() {
        if (this.totalSeconds() <= 0) return;
        if (this.remainingMs <= 0) return;
        this.run();
    }

    stop() {
        this.clear();
        this.remainingMs = 0;
        this.remaining = 0;
    }

    /** Seconds to display: the time left while counting, otherwise `total`. */
    shown(total: number): number {
        if (total <= 0) return 0;
        return this.remaining > 0 ? this.remaining : total;
    }

    private run() {
        this.clear();
        this.endAt = Date.now() + this.remainingMs;
        this.remaining = Math.ceil(this.remainingMs / 1000);
        // Check several times a second so the display and expiry are on time.
        this.interval = setInterval(() => this.tick(), 250);
    }

    private tick() {
        const left = this.endAt - Date.now();
        this.remaining = Math.max(0, Math.ceil(left / 1000));
        if (left <= 0) {
            this.remainingMs = 0;
            this.clear();
            this.onExpire();
        }
    }

    private clear() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

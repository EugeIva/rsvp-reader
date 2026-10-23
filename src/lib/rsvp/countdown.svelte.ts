/**
 * Reading countdown: counts the configured time down once a second while RSVP
 * plays, and calls `onExpire` when it reaches zero.
 */
export class Countdown {
    /** Seconds left; 0 when not counting. */
    remaining = $state(0);
    private interval: ReturnType<typeof setInterval> | null = null;

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
        this.remaining = total;
        this.run();
    }

    pause() {
        this.clear();
    }

    /** Continue a paused countdown (no-op if none is set or it already ran out). */
    resume() {
        if (this.totalSeconds() <= 0) return;
        if (this.remaining <= 0) return;
        this.run();
    }

    stop() {
        this.clear();
        this.remaining = 0;
    }

    /** Seconds to display: the time left while counting, otherwise `total`. */
    shown(total: number): number {
        if (total <= 0) return 0;
        return this.remaining > 0 ? this.remaining : total;
    }

    private run() {
        this.clear();
        this.interval = setInterval(() => {
            this.remaining--;
            if (this.remaining <= 0) {
                this.remaining = 0;
                this.clear();
                this.onExpire();
            }
        }, 1000);
    }

    private clear() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

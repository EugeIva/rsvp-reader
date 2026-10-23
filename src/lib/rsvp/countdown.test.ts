import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Countdown } from "./countdown.svelte";

describe("Countdown", () => {
    let total: number;
    let expired: number;
    let countdown: Countdown;

    beforeEach(() => {
        vi.useFakeTimers();
        total = 3;
        expired = 0;
        countdown = new Countdown(() => total, () => expired++);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("counts down once a second and calls onExpire once at zero", () => {
        countdown.start();
        expect(countdown.remaining).toBe(3);
        vi.advanceTimersByTime(2000);
        expect(countdown.remaining).toBe(1);
        expect(expired).toBe(0);
        vi.advanceTimersByTime(1000);
        expect(countdown.remaining).toBe(0);
        expect(expired).toBe(1);
        vi.advanceTimersByTime(5000);
        expect(expired).toBe(1);
    });

    it("does nothing when no duration is set", () => {
        total = 0;
        countdown.start();
        vi.advanceTimersByTime(5000);
        expect(countdown.remaining).toBe(0);
        expect(expired).toBe(0);
    });

    it("pauses and resumes where it left off", () => {
        countdown.start();
        vi.advanceTimersByTime(1000);
        countdown.pause();
        vi.advanceTimersByTime(10_000);
        expect(countdown.remaining).toBe(2);
        countdown.resume();
        vi.advanceTimersByTime(2000);
        expect(expired).toBe(1);
    });

    it("does not resume once it has run out or been stopped", () => {
        countdown.start();
        countdown.stop();
        expect(countdown.remaining).toBe(0);
        countdown.resume();
        vi.advanceTimersByTime(5000);
        expect(expired).toBe(0);
    });

    it("restarting begins again from the full duration", () => {
        countdown.start();
        vi.advanceTimersByTime(2000);
        countdown.start();
        expect(countdown.remaining).toBe(3);
        vi.advanceTimersByTime(2000);
        expect(expired).toBe(0);
    });

    it("shows the time left while counting, else the configured duration", () => {
        expect(countdown.shown(90)).toBe(90);
        expect(countdown.shown(0)).toBe(0);
        countdown.start();
        vi.advanceTimersByTime(1000);
        expect(countdown.shown(3)).toBe(2);
    });
});

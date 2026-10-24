import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

// settings.ts keeps module state (loaded once), so each test imports a fresh copy.
async function fresh() {
    vi.resetModules();
    const stores = await import("$lib/stores");
    const settings = await import("./settings");
    const { DEFAULT_RSVP_CONFIG } = await import("./rsvp");
    return { ...stores, ...settings, DEFAULT_RSVP_CONFIG };
}

const saves = () => invoke.mock.calls.filter(([cmd]) => cmd === "save_settings");

describe("global RSVP settings", () => {
    beforeEach(() => {
        invoke.mockReset();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("loads settings.json into rsvpConfig", async () => {
        invoke.mockImplementation(async (cmd: string) => (cmd === "load_settings" ? { wpm: 450 } : null));
        const { loadSettings, rsvpConfig } = await fresh();
        await loadSettings();
        expect(get(rsvpConfig).wpm).toBe(450);
    });

    it("adopts a book's old per-book settings only when there are no global ones", async () => {
        invoke.mockImplementation(async (cmd: string) => (cmd === "load_settings" ? null : null));
        let m = await fresh();
        await m.loadSettings();
        m.adoptLegacySettings({ rsvp: { ...m.DEFAULT_RSVP_CONFIG, wpm: 600 } });
        expect(get(m.rsvpConfig).wpm).toBe(600);
        // Only the first book's settings are adopted.
        m.adoptLegacySettings({ rsvp: { ...m.DEFAULT_RSVP_CONFIG, wpm: 200 } });
        expect(get(m.rsvpConfig).wpm).toBe(600);

        invoke.mockImplementation(async (cmd: string) => (cmd === "load_settings" ? { wpm: 450 } : null));
        m = await fresh();
        await m.loadSettings();
        m.adoptLegacySettings({ rsvp: { ...m.DEFAULT_RSVP_CONFIG, wpm: 600 } });
        expect(get(m.rsvpConfig).wpm).toBe(450);
    });

    it("saves changes once loaded, debounced, and not the initial value", async () => {
        invoke.mockImplementation(async (cmd: string) => (cmd === "load_settings" ? { wpm: 450 } : null));
        const { syncSettings, loadSettings, rsvpConfig } = await fresh();
        const stop = syncSettings();
        await loadSettings();
        await vi.advanceTimersByTimeAsync(1000);
        expect(saves()).toHaveLength(0);

        rsvpConfig.update((c) => ({ ...c, wpm: 500 }));
        rsvpConfig.update((c) => ({ ...c, wpm: 550 }));
        await vi.advanceTimersByTimeAsync(300);
        expect(saves()).toHaveLength(1);
        expect(saves()[0][1]).toEqual({ data: expect.objectContaining({ wpm: 550 }) });

        stop();
        rsvpConfig.update((c) => ({ ...c, wpm: 600 }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(saves()).toHaveLength(1);
    });

    it("loads the font size from settings.json, and saves it with the RSVP settings", async () => {
        invoke.mockImplementation(async (cmd: string) =>
            cmd === "load_settings" ? { wpm: 450, fontSize: 1.6 } : null,
        );
        const { syncSettings, loadSettings, fontSize } = await fresh();
        const stop = syncSettings();
        await loadSettings();
        expect(get(fontSize)).toBe(1.6);
        fontSize.set(1.8);
        await vi.advanceTimersByTimeAsync(300);
        expect(saves()[0][1]).toEqual({ data: expect.objectContaining({ wpm: 450, fontSize: 1.8 }) });
        stop();
    });

    it("adopts a book's old font size when settings.json has none, even with RSVP settings", async () => {
        invoke.mockImplementation(async (cmd: string) => (cmd === "load_settings" ? { wpm: 450 } : null));
        const m = await fresh();
        await m.loadSettings();
        m.adoptLegacySettings({ rsvp: { ...m.DEFAULT_RSVP_CONFIG, wpm: 600 }, fontSize: 1.4 });
        expect(get(m.rsvpConfig).wpm).toBe(450); // global RSVP settings win
        expect(get(m.fontSize)).toBe(1.4); // but the font size was missing
        m.adoptLegacySettings({ fontSize: 2.0 }); // only once
        expect(get(m.fontSize)).toBe(1.4);
    });
});

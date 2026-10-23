<script lang="ts">
    import { rsvpConfig } from "$lib/stores";
    import type { Countdown } from "$lib/rsvp/countdown.svelte";

    // Minutes and seconds inputs for the RSVP reading countdown. They show the
    // time left while counting and the configured duration otherwise.
    let { countdown, started, playing }: { countdown: Countdown; started: boolean; playing: boolean } = $props();

    let total = $derived($rsvpConfig.timerMinutes * 60 + $rsvpConfig.timerSeconds);
    let shown = $derived(countdown.shown(total));
    let locked = $derived(started && playing && countdown.remaining > 0);

    function setTimerMin(e: Event) {
        if (started && countdown.remaining > 0) return;
        const raw = (e.target as HTMLInputElement).value.replace(/\D/g, "");
        const v = parseInt(raw);
        if (!isNaN(v)) {
            rsvpConfig.update((c) => ({ ...c, timerMinutes: Math.max(0, Math.min(99, v)) }));
        } else if (raw === "") {
            rsvpConfig.update((c) => ({ ...c, timerMinutes: 0 }));
        }
        (e.target as HTMLInputElement).value = String(Math.max(0, Math.min(99, parseInt(raw) || 0)));
    }

    function setTimerSec(e: Event) {
        if (started && countdown.remaining > 0) return;
        const raw = (e.target as HTMLInputElement).value.replace(/\D/g, "");
        const v = parseInt(raw);
        if (!isNaN(v)) {
            rsvpConfig.update((c) => ({ ...c, timerSeconds: Math.max(0, Math.min(59, v)) }));
        } else if (raw === "") {
            rsvpConfig.update((c) => ({ ...c, timerSeconds: 0 }));
        }
        (e.target as HTMLInputElement).value = String(Math.max(0, Math.min(59, parseInt(raw) || 0)));
    }
</script>

<input type="text" inputmode="numeric" maxlength="2" value={Math.floor(shown / 60)} oninput={setTimerMin} class="timer-input timer-min" disabled={locked} />
<span class="timer-colon">:</span>
<input type="text" inputmode="numeric" maxlength="2" value={shown % 60} oninput={setTimerSec} class="timer-input timer-sec" disabled={locked} />

<style>
    .timer-input {
        width: 3rem;
        padding: 0.2rem 0.3rem;
        border: 1px solid #444;
        border-radius: 4px;
        background: #1a1a1a;
        color: #6a9cf5;
        font-size: 1.1rem;
        font-variant-numeric: tabular-nums;
        text-align: center;
    }

    .timer-input:disabled {
        opacity: 1;
        border-color: transparent;
    }

    .timer-input:focus {
        border-color: #6a9cf5;
        outline: none;
    }

    .timer-colon {
        font-size: 1.1rem;
        color: #6a9cf5;
        font-weight: bold;
    }
</style>

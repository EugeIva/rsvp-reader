<script lang="ts">
    import { rsvpConfig } from "$lib/stores";

    let speed = $state(300);
    let complexity = $state(50);
    let punctMs = $state(200);
    let longMult = $state(0.5);

    $effect(() => {
        const cfg = $rsvpConfig;
        speed = cfg.wpm;
        punctMs = cfg.punctuationDelayMs;
        longMult = cfg.longWordMultiplier;
        complexity = Math.round(cfg.complexityWeight * 100);
    });

    function setWpm(e: Event) {
        const v = parseInt((e.target as HTMLInputElement).value);
        rsvpConfig.update((c) => ({ ...c, wpm: v }));
    }

    function setComplexity(e: Event) {
        const v = parseInt((e.target as HTMLInputElement).value);
        rsvpConfig.update((c) => ({ ...c, complexityWeight: v / 100 }));
    }

    function setPunctMs(e: Event) {
        const v = parseInt((e.target as HTMLInputElement).value);
        rsvpConfig.update((c) => ({ ...c, punctuationDelayMs: v }));
    }

    function setLongMult(e: Event) {
        const v = parseFloat((e.target as HTMLInputElement).value);
        rsvpConfig.update((c) => ({ ...c, longWordMultiplier: v }));
    }
</script>

<div class="controls">
    <div class="control-row">
        <span class="label">Speed</span>
        <input type="range" min="100" max="1000" step="10" value={speed} oninput={setWpm} />
        <span class="value">{speed} WPM</span>
    </div>

    <div class="control-row">
        <span class="label">Punctuation pause</span>
        <input type="range" min="0" max="500" step="10" value={punctMs} oninput={setPunctMs} />
        <span class="value">{punctMs === 0 ? "off" : `${punctMs}ms`}</span>
    </div>

    <div class="control-row">
        <span class="label">Word length delay</span>
        <input type="range" min="0" max="3" step="0.1" value={longMult} oninput={setLongMult} />
        <span class="value">{longMult === 0 ? "off" : `${longMult.toFixed(1)}x`}</span>
    </div>

    <div class="control-row">
        <span class="label">Complexity delay</span>
        <input type="range" min="0" max="100" step="5" value={complexity} oninput={setComplexity} />
        <span class="value">{complexity}%</span>
    </div>
</div>

<style>
    .controls {
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .control-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .label {
        width: 7.5rem;
        font-size: 0.85rem;
        color: #aaa;
        flex-shrink: 0;
    }

    input[type="range"] {
        flex: 1;
        accent-color: #6a9cf5;
    }

    .value {
        width: 4rem;
        text-align: right;
        font-size: 0.85rem;
        color: #e0e0e0;
        flex-shrink: 0;
    }
</style>

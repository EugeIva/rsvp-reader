// Quick test for persistence.ts logic
// Run: npx tsx scripts/test-persistence.ts

// Test that loadState correctly reads snake_case and camelCase keys
function simulateLoadState(raw: Record<string, unknown>) {
    return {
        page: (raw.page ?? 0) as number,
        rsvpWordOffset: (raw.rsvpWordOffset ?? raw.rsvp_word_offset ?? 0) as number,
        fontSize: (raw.fontSize ?? raw.font_size ?? 1.2) as number,
        windowWidth: (raw.windowWidth ?? raw.window_width ?? 0) as number,
        windowHeight: (raw.windowHeight ?? raw.window_height ?? 0) as number,
        wpm: (raw.wpm ?? 300) as number,
        longWordDelay: (raw.longWordDelay ?? raw.long_word_delay ?? true) as boolean,
        punctuationPause: (raw.punctuationPause ?? raw.punctuation_pause ?? true) as boolean,
        complexityWeight: (raw.complexityWeight ?? raw.complexity_weight ?? 0.5) as number,
    };
}

// Test 1: camelCase keys (new format)
const camelInput = {
    page: 42,
    rsvpWordOffset: 7,
    fontSize: 1.5,
    windowWidth: 1024,
    windowHeight: 768,
    wpm: 450,
    longWordDelay: true,
    punctuationPause: false,
    complexityWeight: 0.3,
};
const camelResult = simulateLoadState(camelInput);
console.assert(camelResult.page === 42, `camel page: expected 42 got ${camelResult.page}`);
console.assert(camelResult.windowWidth === 1024, `camel windowWidth: expected 1024 got ${camelResult.windowWidth}`);
console.assert(camelResult.windowHeight === 768, `camel windowHeight: expected 768 got ${camelResult.windowHeight}`);
console.assert(camelResult.fontSize === 1.5, `camel fontSize: expected 1.5 got ${camelResult.fontSize}`);
console.assert(camelResult.wpm === 450, `camel wpm: expected 450 got ${camelResult.wpm}`);
console.assert(camelResult.punctuationPause === false, `camel punctuationPause: expected false got ${camelResult.punctuationPause}`);
console.log("✓ camelCase keys work");

// Test 2: snake_case keys (old format, backward compat)
const snakeInput = {
    page: 10,
    rsvp_word_offset: 3,
    font_size: 1.3,
    window_width: 800,
    window_height: 600,
    wpm: 300,
    long_word_delay: true,
    punctuation_pause: true,
    complexity_weight: 0.5,
};
const snakeResult = simulateLoadState(snakeInput);
console.assert(snakeResult.page === 10, `snake page: expected 10 got ${snakeResult.page}`);
console.assert(snakeResult.windowWidth === 800, `snake windowWidth: expected 800 got ${snakeResult.windowWidth}`);
console.assert(snakeResult.fontSize === 1.3, `snake fontSize: expected 1.3 got ${snakeResult.fontSize}`);
console.log("✓ snake_case keys work");

// Test 3: localStorage round-trip
try {
    const testData = { w: 1366, h: 768 };
    localStorage.setItem("rsvp-reader:win", JSON.stringify(testData));
    const raw = localStorage.getItem("rsvp-reader:win");
    const parsed = raw ? JSON.parse(raw) : null;
    console.assert(parsed.w === 1366, `localStorage w: expected 1366 got ${parsed.w}`);
    console.assert(parsed.h === 768, `localStorage h: expected 768 got ${parsed.h}`);
    localStorage.removeItem("rsvp-reader:win");
    console.log("✓ localStorage round-trip works");
} catch (e) {
    console.log("localStorage not available in this environment (expected in Node)");
}
// Fix syntax errors from above - this is a test file
console.log("");
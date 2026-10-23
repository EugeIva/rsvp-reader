// Quick test for RSVP engine logic
// Run: npx tsx scripts/test-rsvp.ts

import {
    tokenize,
    getORP,
    calculateDelay,
    RsvpEngine,
    DEFAULT_RSVP_CONFIG,
} from "../src/lib/utils/rsvp";

// Test 1: tokenize
const tokens = tokenize("Hello, world! How are you?");
console.assert(tokens.length === 5, `Expected 5 tokens, got ${tokens.length}`);
console.assert(tokens[0].text === "Hello", `Expected 'Hello', got '${tokens[0].text}'`);
console.assert(tokens[0].punctSuffix === ",", `Expected ',', got '${tokens[0].punctSuffix}'`);
console.assert(tokens[0].isWord === true, `Expected word`);
console.assert(tokens[0].orpIndex === 1, `ORP of Hello should be 1, got ${tokens[0].orpIndex}`);
console.assert(tokens[0].isPunctuation === false, `Word should not be punctuation`);
console.assert(tokens[1].text === "world", `Expected 'world', got '${tokens[1].text}'`);
console.assert(tokens[1].punctSuffix === "!", `Expected '!', got '${tokens[1].punctSuffix}'`);
console.log("✓ tokenize works");

// Test 1b: tokenize special word patterns
const timeTokens = tokenize("at 7:30 pm");
console.assert(timeTokens.length >= 3, `time tokens: expected >=3 got ${timeTokens.length}`);
console.assert(timeTokens.some(t => t.text === "7:30"), `'7:30' should be one token, got ${timeTokens.map(t => t.text).join(",")}`);

const abbrTokens = tokenize("at A.M. it");
console.assert(abbrTokens.length >= 3, `abbr tokens: expected >=3 got ${abbrTokens.length}`);
const abbrMatch = abbrTokens.filter(t => t.text === "A.M" || t.text === "A.M.");
console.assert(abbrMatch.length >= 1, `'A.M.' should be one token, got ${abbrTokens.map(t => t.text + t.punctSuffix).join(",")}`);

const hypTokens = tokenize("my mother-in-law is");
console.assert(hypTokens.length >= 3, `hyphen tokens: expected >=3 got ${hypTokens.length}`);
console.assert(hypTokens.some(t => t.text === "mother-in-law"), `'mother-in-law' should be one token, got ${hypTokens.map(t => t.text).join(",")}`);

const aptTokens = tokenize("don't stop");
console.assert(aptTokens.length >= 2, `apostrophe tokens: expected >=2 got ${aptTokens.length}`);
console.assert(aptTokens.some(t => t.text === "don't"), `'don't' should be one token, got ${aptTokens.map(t => t.text).join(",")}`);

console.log("✓ special word patterns work");

// Test 1c: opening quotes attached to following word
const quoteTokens = tokenize('he said "tin" to her');
const tin = quoteTokens.find(t => t.text === "tin");
console.assert(tin, `should find 'tin', got ${quoteTokens.map(t => t.text + "[" + t.quotePrefix + t.punctSuffix + "]").join(",")}`);
console.assert(tin && tin.quotePrefix === '"', `'tin' should have quotePrefix '"', got '${tin?.quotePrefix}'`);
console.assert(tin && tin.punctSuffix === '"', `'tin' should have punctSuffix '"', got '${tin?.punctSuffix}'`);

const dayQuoteTokens = tokenize('"this day" gone');
console.assert(dayQuoteTokens.length >= 3, `'this day' should be '"this' and 'day"' as 2 word tokens + 'gone', got ${dayQuoteTokens.map(t => t.quotePrefix + t.text + t.punctSuffix).join(",")}`);
console.assert(dayQuoteTokens[0].text === "this" && dayQuoteTokens[0].quotePrefix === '"', `'"this' should be one token, got ${dayQuoteTokens[0].quotePrefix}${dayQuoteTokens[0].text}`);
console.assert(dayQuoteTokens[1].text === "day" && dayQuoteTokens[1].punctSuffix === '"', `'day"' should be one token, got ${dayQuoteTokens[1].text}${dayQuoteTokens[1].punctSuffix}`);
console.log("✓ opening quote attachment works");

console.log("✓ quote handling works");

// Test 2: getORP
console.assert(getORP("a") === 0, "ORP of 'a' should be 0");
console.assert(getORP("he") === 0, "ORP of 'he' should be 0");
console.assert(getORP("hel") === 1, "ORP of 'hel' should be 1");
console.assert(getORP("hello") === 1, "ORP of 'hello' should be 1");
console.assert(getORP("incomprehensibilities") === 7, "ORP of long word should be 7");
console.log("✓ getORP works");

// Test 3: calculateDelay
const cfg300 = { ...DEFAULT_RSVP_CONFIG, wpm: 300 };
const wordToken = { text: "hello", isWord: true, orpIndex: 1, isPunctuation: false, punctSuffix: "" };
const wordWithPunct = { text: "hello", isWord: true, orpIndex: 1, isPunctuation: false, punctSuffix: "," };
const punctToken = { text: ",", isWord: false, orpIndex: -1, isPunctuation: true, punctSuffix: "" };

console.assert(calculateDelay(wordToken, cfg300) === 200, `Base 300 WPM should be 200ms, got ${calculateDelay(wordToken, cfg300)}`);

const cfg600 = { ...DEFAULT_RSVP_CONFIG, wpm: 600 };
console.assert(calculateDelay(wordToken, cfg600) === 100, `Base 600 WPM should be 100ms, got ${calculateDelay(wordToken, cfg600)}`);

const longWord = { text: "incomprehensibilities", isWord: true, orpIndex: 7, isPunctuation: false, punctSuffix: "" };
const delayLong = calculateDelay(longWord, cfg300);
console.assert(delayLong > 200, `Long word delay should be > 200ms, got ${delayLong}`);

console.assert(
    calculateDelay(punctToken, cfg300) === cfg300.punctuationDelayMs,
    `Punct delay should be ${cfg300.punctuationDelayMs}, got ${calculateDelay(punctToken, cfg300)}`
);

const cfgNoPunct = { ...DEFAULT_RSVP_CONFIG, punctuationPause: false };
console.assert(calculateDelay(punctToken, cfgNoPunct) === 0, `Punct disabled should be 0ms`);

console.assert(
    calculateDelay(wordWithPunct, cfg300) === 400,
    `Word + punct delay should be 400ms, got ${calculateDelay(wordWithPunct, cfg300)}`
);
console.log("✓ calculateDelay works");

// Test 4: RsvpEngine continuous flow
const shortTokens = tokenize("one two three four five");
let emitted: string[] = [];

const engine = new RsvpEngine(shortTokens, cfg300, (tok, idx) => {
    emitted.push(tok.text);
});

engine.start();

// Wait for engine to finish
await new Promise<void>((resolve) => {
    const check = () => {
        if (emitted.length >= 5) {
            resolve();
        } else {
            setTimeout(check, 50);
        }
    };
    setTimeout(check, 50);
});

console.assert(emitted.length === 5, `Engine should have emitted 5 words, got ${emitted.length}`);
console.assert(emitted[0] === "one", `First word should be 'one', got '${emitted[0]}'`);
console.assert(emitted[1] === "two", `Second word should be 'two', got '${emitted[1]}'`);
console.log("✓ engine.start() emits all words continuously");

// Test 5: pause/resume
const pauseTokens = tokenize("a b c d e f g h i j");
let pauseEmitted: string[] = [];
const pauseEngine = new RsvpEngine(pauseTokens, cfg600, (tok, idx) => {
    pauseEmitted.push(tok.text);
});

pauseEngine.start();

await new Promise<void>((resolve) => {
    const check = () => {
        if (pauseEmitted.length >= 3) {
            pauseEngine.pause();
            resolve();
        } else {
            setTimeout(check, 20);
        }
    };
    setTimeout(check, 20);
});

const afterPause = pauseEmitted.length;
await new Promise((r) => setTimeout(r, 200)); // wait to confirm it's really paused
console.assert(pauseEmitted.length === afterPause, `Engine should NOT advance during pause, was ${afterPause}, now ${pauseEmitted.length}`);

pauseEngine.resume();
await new Promise<void>((resolve) => {
    const check = () => {
        if (pauseEmitted.length >= 7) {
            resolve();
        } else {
            setTimeout(check, 30);
        }
    };
    setTimeout(check, 30);
});

console.assert(pauseEmitted.length >= 7, `After resume should have >= 7, got ${pauseEmitted.length}`);
console.log("✓ engine pause/resume works");

// Test 6: seek
const seekTokens = tokenize("alpha beta gamma delta");
let seekEmitted: string[] = [];
const seekEngine = new RsvpEngine(seekTokens, cfg600, (tok, idx) => {
    seekEmitted.push(tok.text);
});
seekEngine.seek(2);
seekEngine.start();

await new Promise<void>((resolve) => {
    const check = () => {
        if (seekEmitted.length >= 2) {
            resolve();
        } else {
            setTimeout(check, 30);
        }
    };
    setTimeout(check, 30);
});

console.assert(seekEmitted[0] === "gamma", `Seek to index 2 should start from 'gamma', got '${seekEmitted[0]}'`);
console.log("✓ engine seek works");

// Test 7: Space stops flow properly
const flowTokens = tokenize("x y z");
let flowEmitted: string[] = [];
const flowEngine = new RsvpEngine(flowTokens, cfg300, (tok, idx) => {
    flowEmitted.push(tok.text);
});

flowEngine.start();
await new Promise((r) => setTimeout(r, 150));
flowEngine.pause();
const beforePause = flowEmitted.length;
console.assert(flowEngine.isPlaying === false, "isPlaying should be false after pause");

flowEngine.resume();
await new Promise((r) => setTimeout(r, 500));
console.assert(flowEngine.isPlaying === false, "isPlaying should be false after all words done");
console.assert(flowEmitted.length === 3, `Should have emitted all 3 words, got ${flowEmitted.length}`);
console.log("✓ Space pause/resume cycle works");

console.log("\n✅ All tests passed!");
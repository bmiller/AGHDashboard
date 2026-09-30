"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Stub the AdGuard Home client before querylog.js destructures it.
const agh = require("../lib/agh");
let pages = [];
let urls = [];
agh.aghJson = async (_server, url) => {
    urls.push(url);
    return { data: pages.length > 0 ? pages.shift() : [] };
};

const { scanQueryLog, EMPTY_PAGE_RETRIES } = require("../lib/querylog");

const SERVER = { name: "s1" };
const CFG = { pageSize: 3, maxPages: 5 };
const NO_DELAY = { retryDelayMs: 0 };
const T0 = Date.UTC(2024, 0, 1, 12, 0, 0);
const at = (sec) => ({ time: new Date(T0 + sec * 1000).toISOString() });

async function scan(cutoffSec, cfg = CFG) {
    const seen = [];
    const out = await scanQueryLog(SERVER, cfg, T0 + cutoffSec * 1000, (_e, t) => seen.push((t - T0) / 1000), NO_DELAY);
    return { ...out, seen };
}

function reset(p) {
    pages = p;
    urls = [];
}

test("scanQueryLog: follows older_than cursors and stops at the cutoff", async () => {
    reset([[at(50), at(40), at(30)], [at(20), at(10), at(0)]]);
    const out = await scan(15);
    assert.deepEqual(out.seen, [50, 40, 30, 20]);
    assert.equal(out.complete, true);
    assert.equal(out.oldestSeenMs, T0 + 10000); // includes the entry that crossed the cutoff
    assert.equal(urls.length, 2);
    assert.match(urls[1], new RegExp(`older_than=${encodeURIComponent(at(30).time)}`));
});

test("scanQueryLog: an empty first page means an empty log (complete)", async () => {
    reset([]);
    const out = await scan(0);
    assert.equal(out.complete, true);
    assert.deepEqual(out.seen, []);
    assert.equal(urls.length, 1 + EMPTY_PAGE_RETRIES);
});

test("scanQueryLog: a transient empty page is retried, not treated as the end", async () => {
    reset([[at(50), at(40), at(30)], [], [at(20), at(10)]]);
    const out = await scan(15);
    assert.deepEqual(out.seen, [50, 40, 30, 20]);
    assert.equal(out.complete, true);
});

test("scanQueryLog: persistent empty pages after a cursor are incomplete", async () => {
    reset([[at(50), at(40), at(30)]]);
    const out = await scan(0);
    assert.deepEqual(out.seen, [50, 40, 30]);
    assert.equal(out.complete, false);
});

test("scanQueryLog: stops without progress instead of looping", async () => {
    reset([[at(50), at(40)], [at(40)], [at(40)], [at(40)]]);
    const out = await scan(0);
    assert.equal(out.complete, false);
    assert.equal(urls.length, 2);
});

test("scanQueryLog: maxPages caps pagination and reports incomplete", async () => {
    reset([[at(50)], [at(40)], [at(30)], [at(20)]]);
    const out = await scan(0, { pageSize: 1, maxPages: 2 });
    assert.deepEqual(out.seen, [50, 40]);
    assert.equal(out.complete, false);
});

test("scanQueryLog: entries with unparseable times are skipped", async () => {
    reset([[at(50), { time: "garbage" }, at(-10)]]);
    const out = await scan(0);
    assert.deepEqual(out.seen, [50]);
    assert.equal(out.complete, true);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyEntry, clientLabel, makeWindow, mergeClientBuckets } = require("../lib/activity");

test("classifyEntry: filtered reasons are blocked", () => {
    assert.equal(classifyEntry({ reason: "FilteredBlackList" }), "blocked");
    assert.equal(classifyEntry({ reason: "CustomFilter" }), "blocked");
});

test("classifyEntry: rewrites are other", () => {
    assert.equal(classifyEntry({ reason: "Rewrite" }), "other");
    assert.equal(classifyEntry({ reason: "RewrittenList" }), "other");
});

test("classifyEntry: cached flag wins over default permitted", () => {
    assert.equal(classifyEntry({ reason: "NotFilteredNotFound", cached: true }), "cached");
});

test("classifyEntry: NOERROR / NXDOMAIN are permitted, other statuses are other", () => {
    assert.equal(classifyEntry({}), "permitted");
    assert.equal(classifyEntry({ status: "NXDOMAIN" }), "permitted");
    assert.equal(classifyEntry({ status: "SERVFAIL" }), "other");
});

test("clientLabel: prefers client_info name, falls back to IP", () => {
    assert.equal(clientLabel({ client: "10.0.0.5", client_info: { name: "tv" } }), "tv");
    assert.equal(clientLabel({ client: "10.0.0.5" }), "10.0.0.5");
    assert.equal(clientLabel({}), "unknown");
});

test("clientLabel: VLAN descriptions are replaced by the IP", () => {
    assert.equal(clientLabel({ client: "10.0.0.5", client_info: { name: "Core VLAN" } }), "10.0.0.5");
});

test("makeWindow: aligned buckets covering the requested span", () => {
    const now = Date.UTC(2024, 0, 1, 12, 3, 30); // 12:03:30
    const win = makeWindow(24, 10, now);
    assert.equal(win.bucketCount, 144);
    assert.equal(win.bucketMs, 600000);
    // last bucket starts at 12:00, window end one bucket later
    assert.equal(win.windowEnd - win.windowStart, 144 * 600000);
    assert.equal(win.windowEnd % 600000, 0);
});

test("mergeClientBuckets: same label combined across servers", () => {
    const a = new Map([["pc", Float64Array.from([1, 2, 0])]]);
    const b = new Map([
        ["pc", Float64Array.from([0, 3, 4])],
        ["tv", Float64Array.from([5, 0, 0])],
    ]);
    const merged = mergeClientBuckets([a, b], 3);
    assert.deepEqual(Array.from(merged.get("pc")), [1, 5, 4]);
    assert.deepEqual(Array.from(merged.get("tv")), [5, 0, 0]);
});

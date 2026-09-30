"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Stub the AdGuard Home client before requests.js destructures it.
const agh = require("../lib/agh");
let aghImpl = null;
agh.aghJson = (...args) => aghImpl(...args);

const { validateRange, getRequestsInRange, createRequestsService } = require("../lib/requests");
const { ApiError } = require("../lib/util");

const HOUR = 3600000;
const CONFIG = {
    servers: [{ name: "s1", baseUrl: "http://x", timeoutMs: 1000 }],
    activity: { hours: 24, intervalMinutes: 10, pageSize: 100, maxPages: 2, maxClients: 24 },
    requests: { maxRangeMinutes: 60, maxRows: 5000, maxConcurrent: 2 },
};

/** Entries at the given ms offsets from `base`, newest first, as AGH returns them. */
function page(base, offsetsMs) {
    return {
        data: offsetsMs
            .slice()
            .sort((a, b) => b - a)
            .map((o) => ({ time: new Date(base + o).toISOString(), client: "c", question: { name: "x." } })),
    };
}

test("validateRange: accepts a recent 10-minute window", () => {
    const now = Date.now();
    assert.equal(validateRange(CONFIG, now - 600000, now, now), null);
});

test("validateRange: rejects bad, wide, old and future windows", () => {
    const now = Date.now();
    assert.match(validateRange(CONFIG, NaN, now, now), /required/);
    assert.match(validateRange(CONFIG, now, now, now), /required/);
    assert.match(validateRange(CONFIG, 0, 9e15, now), /too wide/);
    assert.match(validateRange(CONFIG, now - 2 * HOUR, now, now), /too wide/);
    assert.match(validateRange(CONFIG, now - 26 * HOUR, now - 25 * HOUR, now), /older than/);
    assert.match(validateRange(CONFIG, now + HOUR, now + 2 * HOUR, now), /future/);
});

test("getRequestsInRange: caps rows and reports the full count", async () => {
    const start = Date.now() - 600000;
    aghImpl = async () => page(start, [-1000, 1000, 2000, 3000]);
    const out = await getRequestsInRange({ ...CONFIG, requests: { ...CONFIG.requests, maxRows: 2 } }, start, start + 600000);
    assert.equal(out.count, 2);
    assert.equal(out.totalCount, 3);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.meta, { complete: true, servers: [{ name: "s1", ok: true, error: null, complete: true }] });
});

test("getRequestsInRange: paging limit is reported per server, distinct from failures", async () => {
    const start = Date.now() - 600000;
    // Every page stays inside the window, so maxPages runs out before startMs.
    let n = 0;
    aghImpl = async () => page(start, [500000 - n++ * 1000]);
    const out = await getRequestsInRange(CONFIG, start, start + 600000);
    assert.equal(out.meta.complete, false);
    assert.deepEqual(out.meta.servers, [{ name: "s1", ok: true, error: null, complete: false }]);
});

test("getRequestsInRange: all servers failing is a 502", async () => {
    aghImpl = async () => {
        throw new ApiError(502, "down");
    };
    const start = Date.now() - 600000;
    await assert.rejects(getRequestsInRange(CONFIG, start, start + 600000), (err) => err.status === 502);
});

test("createRequestsService: rejects invalid windows with 400", async () => {
    const { getRequests } = createRequestsService(CONFIG);
    await assert.rejects(getRequests(0, 9e15), (err) => err instanceof ApiError && err.status === 400);
});

test("createRequestsService: limits concurrent lookups with 429", async () => {
    const start = Date.now() - 600000;
    let release;
    const gate = new Promise((r) => (release = r));
    aghImpl = async () => {
        await gate;
        return page(start, [-1000, 1000]);
    };

    const { getRequests } = createRequestsService({ ...CONFIG, requests: { ...CONFIG.requests, maxConcurrent: 1 } });
    const first = getRequests(start, start + 600000);
    await assert.rejects(getRequests(start, start + 600000), (err) => err.status === 429);
    release();
    assert.equal((await first).count, 1);

    // The slot is freed afterwards.
    assert.equal((await getRequests(start, start + 600000)).count, 1);
});

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Stub the AdGuard Home client before activity.js destructures it.
const agh = require("../lib/agh");
let aghImpl = null;
agh.aghJson = (...args) => aghImpl(...args);

const { computeActivity, createActivityService } = require("../lib/activity");

const ACTIVITY = { hours: 1, intervalMinutes: 10, pageSize: 100, maxPages: 2, maxClients: 24 };
const SERVER = { name: "s1", baseUrl: "http://x", timeoutMs: 1000 };

/** A query-log page: one entry per client a minute ago, plus one entry before the window. */
function logPage(clients) {
    const recent = new Date(Date.now() - 60000).toISOString();
    const old = new Date(Date.now() - 3 * 3600000).toISOString();
    return {
        data: [...clients.map((c) => ({ time: recent, client: c })), { time: old, client: "old" }],
    };
}

test("computeActivity: hasOther flags the merged tail row", async () => {
    aghImpl = async () => logPage(["a", "b", "c"]);

    const merged = await computeActivity([SERVER], { ...ACTIVITY, maxClients: 1 });
    assert.equal(merged.clients.names.length, 2);
    assert.equal(merged.clients.names[1], "Other clients");
    assert.equal(merged.clients.hasOther, true);

    const all = await computeActivity([SERVER], ACTIVITY);
    assert.equal(all.clients.names.length, 3);
    assert.equal(all.clients.hasOther, false);
});

test("createActivityService: serves stale data while revalidating, waits once too stale", async (t) => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    t.after(() => {
        Date.now = realNow;
    });

    let calls = 0;
    let release = null;
    aghImpl = async () => {
        calls++;
        if (release) await new Promise((r) => (release = r));
        return logPage(["a"]);
    };

    const config = { servers: [SERVER], activity: ACTIVITY, cacheTtlSeconds: 60 };
    const { getActivity } = createActivityService(config);

    const first = await getActivity();
    assert.equal(calls, 1);

    // Within TTL: cached.
    assert.equal(await getActivity(), first);
    assert.equal(calls, 1);

    // Expired but recent: the old data comes back immediately while a
    // (deliberately stalled) refresh runs in the background.
    offset = 61000;
    release = () => {};
    assert.equal(await getActivity(), first);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
    release();
    await new Promise((r) => setImmediate(r));
    const refreshed = await getActivity();
    assert.notEqual(refreshed, first);

    // Far past expiry: the caller waits for a fresh computation.
    release = null;
    offset += 61000 + 5 * 60000 + 1000;
    const fresh = await getActivity();
    assert.equal(calls, 3);
    assert.notEqual(fresh, refreshed);
});

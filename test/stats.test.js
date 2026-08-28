"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
    normalizeTopList,
    firstArray,
    normalizeStats,
    sumArrays,
    mergeTopLists,
    buildClientNameMap,
    aggregateStats,
} = require("../lib/stats");

test("normalizeTopList: current {name,count} shape", () => {
    const out = normalizeTopList([{ domain: "a.com", count: 3 }, { domain: "b.com", count: 9 }], "domain");
    assert.deepEqual(out, [{ name: "b.com", count: 9 }, { name: "a.com", count: 3 }]);
});

test("normalizeTopList: legacy {name: count} shape", () => {
    const out = normalizeTopList([{ "a.com": 3 }, { "b.com": 9 }], "domain");
    assert.deepEqual(out, [{ name: "b.com", count: 9 }, { name: "a.com", count: 3 }]);
});

test("normalizeTopList: non-array yields empty", () => {
    assert.deepEqual(normalizeTopList(undefined, "ip"), []);
});

test("firstArray returns the first present array key", () => {
    assert.deepEqual(firstArray({ b: [1, 2], c: [3] }, ["a", "b", "c"]), [1, 2]);
    assert.deepEqual(firstArray({}, ["a"]), []);
});

test("sumArrays adds element-wise over ragged arrays", () => {
    assert.deepEqual(sumArrays([[1, 2, 3], [10, 20]]), [11, 22, 3]);
});

test("mergeTopLists sums by name, re-ranks, truncates", () => {
    const a = [{ name: "x", count: 5 }, { name: "y", count: 1 }];
    const b = [{ name: "y", count: 8 }, { name: "z", count: 2 }];
    assert.deepEqual(mergeTopLists([a, b], 2), [
        { name: "y", count: 9 },
        { name: "x", count: 5 },
    ]);
});

test("normalizeStats: totals and hourly from current format", () => {
    const n = normalizeStats({
        num_dns_queries: 100,
        num_blocked_filtering: 10,
        num_replaced_safebrowsing: 2,
        num_replaced_parental: 1,
        avg_processing_time: 0.025,
        dns_queries: [1, 2, 3],
        top_clients: [{ ip: "192.168.1.5", count: 40 }],
    });
    assert.equal(n.totals.queries, 100);
    assert.equal(n.totals.blocked, 10);
    assert.equal(n.totals.avgProcessingTimeMs, 25);
    assert.deepEqual(n.hourly.queries, [1, 2, 3]);
    assert.deepEqual(n.topClients, [{ name: "192.168.1.5", count: 40 }]);
});

test("normalizeStats: blocked falls back to summing per-hour array", () => {
    const n = normalizeStats({ num_dns_queries: 5, blocked_filtering: [1, 2, 3] });
    assert.equal(n.totals.blocked, 6);
});

test("buildClientNameMap: maps IPs, skips VLAN names, MACs and CIDRs", () => {
    const map = buildClientNameMap({
        auto_clients: [{ ip: "192.168.1.10", name: "laptop" }],
        clients: [
            { name: "phone", ids: ["192.168.1.20"] },
            { name: "Core VLAN", ids: ["192.168.1.30"] },
            { name: "router", ids: ["aa:bb:cc:dd:ee:ff", "192.168.1.0/24"] },
        ],
    });
    assert.deepEqual(map, { "192.168.1.10": "laptop", "192.168.1.20": "phone" });
});

test("buildClientNameMap: persistent clients override auto-discovered", () => {
    const map = buildClientNameMap({
        auto_clients: [{ ip: "10.0.0.1", name: "auto-name" }],
        clients: [{ name: "persistent-name", ids: ["10.0.0.1"] }],
    });
    assert.equal(map["10.0.0.1"], "persistent-name");
});

test("aggregateStats: sums totals and resolves client names across servers", () => {
    const results = [
        {
            name: "s1",
            ok: true,
            error: null,
            clientNames: { "192.168.1.5": "nas" },
            raw: { num_dns_queries: 100, num_blocked_filtering: 10, avg_processing_time: 0.02, top_clients: [{ ip: "192.168.1.5", count: 60 }] },
        },
        {
            name: "s2",
            ok: true,
            error: null,
            clientNames: {},
            raw: { num_dns_queries: 300, num_blocked_filtering: 30, avg_processing_time: 0.06, top_clients: [{ ip: "192.168.1.5", count: 40 }] },
        },
        { name: "s3", ok: false, error: "down", clientNames: {}, raw: null },
    ];
    const agg = aggregateStats(results, { domains: 10, clients: 10, upstreams: 10 });
    assert.equal(agg.totals.queries, 400);
    assert.equal(agg.totals.blocked, 40);
    // query-weighted: (20*100 + 60*300) / 400 = 50
    assert.equal(agg.totals.avgProcessingTimeMs, 50);
    assert.deepEqual(agg.topClients, [{ name: "nas", count: 100 }]);
    assert.deepEqual(
        agg.servers.map((s) => [s.name, s.ok]),
        [["s1", true], ["s2", true], ["s3", false]]
    );
});

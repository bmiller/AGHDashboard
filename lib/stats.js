"use strict";

const { ApiError } = require("./util");
const { aghJson } = require("./agh");

/* ------------------------------------------------------------------ */
/* Pure stats normalization / aggregation                             */
/* ------------------------------------------------------------------ */

/** Normalize top-list entries; supports both legacy ({name: count}) and current ({name, count}). */
function normalizeTopList(list, nameKey) {
    if (!Array.isArray(list)) return [];
    return list
        .map((entry) => {
            if (entry && typeof entry === "object") {
                if (typeof entry.count !== "undefined") {
                    const label = entry[nameKey] ?? entry.name ?? entry.ip ?? entry.domain;
                    return { name: String(label), count: Number(entry.count) || 0 };
                }
                const key = Object.keys(entry)[0];
                return key ? { name: String(key), count: Number(entry[key]) || 0 } : null;
            }
            return null;
        })
        .filter(Boolean)
        .sort((a, b) => b.count - a.count);
}

function firstArray(obj, keys) {
    for (const k of keys) {
        if (Array.isArray(obj[k])) return obj[k];
    }
    return [];
}

function normalizeStats(raw) {
    const total = Number(raw.num_dns_queries) || 0;
    const blocked =
        Number(raw.num_blocked_filtering) ||
        (Array.isArray(raw.blocked_filtering) ? raw.blocked_filtering.reduce((a, b) => a + (Number(b) || 0), 0) : 0);
    const safebrowsing =
        Number(raw.num_replaced_safebrowsing) ||
        (Array.isArray(raw.replaced_safebrowsing)
            ? raw.replaced_safebrowsing.reduce((a, b) => a + (Number(b) || 0), 0)
            : 0);
    const parental =
        Number(raw.num_replaced_parental) ||
        (Array.isArray(raw.replaced_parental) ? raw.replaced_parental.reduce((a, b) => a + (Number(b) || 0), 0) : 0);

    return {
        totals: {
            queries: total,
            blocked,
            safebrowsing,
            parental,
            avgProcessingTimeMs: Math.round((Number(raw.avg_processing_time) || 0) * 1000),
        },
        hourly: {
            queries: firstArray(raw, ["dns_queries", "num_queries_per_hour"]).map(Number),
            blocked: firstArray(raw, ["blocked_filtering", "num_blocked_filtering_per_hour"]).map(Number),
            safebrowsing: firstArray(raw, ["replaced_safebrowsing", "num_replaced_safebrowsing_per_hour"]).map(Number),
            parental: firstArray(raw, ["replaced_parental", "num_replaced_parental_per_hour"]).map(Number),
        },
        // Untruncated; size limits are applied after merging across servers.
        topQueried: normalizeTopList(raw.top_queried_domains, "domain"),
        topBlocked: normalizeTopList(raw.top_blocked_domains, "domain"),
        topClients: normalizeTopList(raw.top_clients, "ip"),
        topUpstreams: normalizeTopList(raw.top_upstreams_responses, "ip"),
        // "count" holds the average response time in seconds for this list.
        topUpstreamsAvgTime: normalizeTopList(raw.top_upstreams_avg_time, "ip"),
    };
}

/** Element-wise sum of numeric arrays of possibly different lengths. */
function sumArrays(arrays) {
    const len = arrays.reduce((m, a) => Math.max(m, a.length), 0);
    const out = new Array(len).fill(0);
    for (const a of arrays) {
        for (let i = 0; i < a.length; i++) out[i] += Number(a[i]) || 0;
    }
    return out;
}

/** Merge {name,count} lists from several servers: sum by name, re-rank, then truncate. */
function mergeTopLists(lists, limit) {
    const acc = new Map();
    for (const list of lists) {
        for (const it of list) acc.set(it.name, (acc.get(it.name) || 0) + it.count);
    }
    return [...acc.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
}

/** Map client IP -> display name from AGH's /control/clients (persistent + auto-discovered). */
function buildClientNameMap(payload) {
    const map = {};
    // Only map plain IPv4/IPv6 client ids; CIDR ranges, MAC addresses and
    // ClientIDs are skipped since the query log keys clients by bare IP.
    const isMac = (s) => /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(s);
    const isIp = (s) =>
        /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ||
        (/^[0-9a-f:]+$/i.test(s) && s.includes(":") && !isMac(s));
    const add = (id, name) => {
        const ip = String(id || "").trim();
        const nm = String(name || "").trim();
        if (!ip || !nm || !isIp(ip) || /vlan/i.test(nm)) return;
        map[ip] = nm;
    };
    if (payload && Array.isArray(payload.auto_clients)) {
        for (const c of payload.auto_clients) add(c.ip, c.name);
    }
    // Persistent clients win over auto-discovered ones.
    if (payload && Array.isArray(payload.clients)) {
        for (const c of payload.clients) {
            for (const id of c.ids || []) add(id, c.name);
        }
    }
    return map;
}

/**
 * Combine per-server normalized stats into one view.
 * @param {Array} results  fetchServerStats() outputs (ok + failed)
 * @param {{domains:number, clients:number, upstreams:number}} topCounts
 */
function aggregateStats(results, topCounts) {
    const okResults = results.filter((r) => r.ok);
    const norm = okResults.map((r) => normalizeStats(r.raw));

    // Resolve top-client IPs to their configured names (falls back to the IP).
    const clientNames = Object.assign({}, ...okResults.map((r) => r.clientNames || {}));
    for (const n of norm) {
        n.topClients = n.topClients.map((c) => ({ ...c, name: clientNames[c.name] || c.name }));
    }

    const totals = { queries: 0, blocked: 0, safebrowsing: 0, parental: 0 };
    let wProd = 0;
    let wSum = 0;
    let plainSum = 0;
    for (const n of norm) {
        totals.queries += n.totals.queries;
        totals.blocked += n.totals.blocked;
        totals.safebrowsing += n.totals.safebrowsing;
        totals.parental += n.totals.parental;
        wProd += n.totals.avgProcessingTimeMs * n.totals.queries;
        wSum += n.totals.queries;
        plainSum += n.totals.avgProcessingTimeMs;
    }
    // Query-weighted mean processing time; simple mean as fallback when no queries were reported.
    totals.avgProcessingTimeMs =
        wSum > 0 ? Math.round(wProd / wSum) : norm.length > 0 ? Math.round(plainSum / norm.length) : 0;

    // Merge per-upstream average response times, weighted by response counts,
    // then convert seconds -> ms. Only upstreams present in topUpstreams are kept.
    const upTimeAcc = new Map();
    for (const n of norm) {
        const countByName = new Map(n.topUpstreams.map((u) => [u.name, u.count]));
        for (const t of n.topUpstreamsAvgTime) {
            const weight = countByName.get(t.name);
            if (!weight || weight <= 0 || !(t.count > 0)) continue;
            const acc = upTimeAcc.get(t.name) || { sum: 0, weight: 0 };
            acc.sum += t.count * weight;
            acc.weight += weight;
            upTimeAcc.set(t.name, acc);
        }
    }
    const upstreamAvgTimesMs = {};
    for (const [name, acc] of upTimeAcc) {
        upstreamAvgTimesMs[name] = Math.round((acc.sum / acc.weight) * 1000);
    }

    return {
        totals,
        hourly: {
            queries: sumArrays(norm.map((n) => n.hourly.queries)),
            blocked: sumArrays(norm.map((n) => n.hourly.blocked)),
            safebrowsing: sumArrays(norm.map((n) => n.hourly.safebrowsing)),
            parental: sumArrays(norm.map((n) => n.hourly.parental)),
        },
        topQueried: mergeTopLists(norm.map((n) => n.topQueried), topCounts.domains),
        topBlocked: mergeTopLists(norm.map((n) => n.topBlocked), topCounts.domains),
        topClients: mergeTopLists(norm.map((n) => n.topClients), topCounts.clients),
        topUpstreams: mergeTopLists(norm.map((n) => n.topUpstreams), topCounts.upstreams),
        upstreamAvgTimesMs,
        generatedAt: new Date().toISOString(),
        servers: results.map(({ name, ok, error }) => ({ name, ok, error })),
    };
}

/* ------------------------------------------------------------------ */
/* Fetch + cache service                                              */
/* ------------------------------------------------------------------ */

async function fetchServerStats(server) {
    try {
        const raw = await aghJson(server, "/control/stats");
        // Best-effort: resolve client IPs to their configured names, matching
        // what the Client Activity tooltip shows. A failure here is non-fatal.
        let clientNames = {};
        try {
            clientNames = buildClientNameMap(await aghJson(server, "/control/clients"));
        } catch (err) {
            console.warn(`[stats] ${server.name}: could not load client names: ${err.message}`);
        }
        return { name: server.name, ok: true, raw, clientNames, error: null };
    } catch (err) {
        return { name: server.name, ok: false, raw: null, clientNames: {}, error: err.message };
    }
}

/** Build a cached getStats() bound to the given config. */
function createStatsService(config) {
    let cache = { data: null, expires: 0, inflight: null };

    async function getStats() {
        const now = Date.now();
        if (cache.data && now < cache.expires) return cache.data;
        if (cache.inflight) return cache.inflight;

        cache.inflight = (async () => {
            const results = await Promise.all(config.servers.map(fetchServerStats));
            if (!results.some((r) => r.ok)) {
                throw new ApiError(502, results.map((r) => `${r.name}: ${r.error}`).join("; "));
            }
            const down = results.filter((r) => !r.ok);
            if (down.length > 0) {
                console.warn(
                    `[stats] some servers unreachable: ${down.map((r) => `${r.name}: ${r.error}`).join("; ")}`
                );
            }
            const data = aggregateStats(results, config.topCounts);
            cache = { data, expires: Date.now() + config.cacheTtlSeconds * 1000, inflight: null };
            return data;
        })();

        try {
            return await cache.inflight;
        } catch (err) {
            cache.inflight = null;
            throw err;
        }
    }

    return { getStats };
}

module.exports = {
    normalizeTopList,
    firstArray,
    normalizeStats,
    sumArrays,
    mergeTopLists,
    buildClientNameMap,
    aggregateStats,
    fetchServerStats,
    createStatsService,
};

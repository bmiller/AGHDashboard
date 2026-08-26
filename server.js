#!/usr/bin/env node
"use strict";

/*
 * AdGuard Home Dashboard - zero-dependency Node.js server
 *
 * - Serves the static frontend from ./public
 * - Talks to one or more AdGuard Home instances (config `servers` array)
 * - Proxies /api/stats to AdGuard Home /control/stats (normalizes old/new formats)
 * - Aggregates AdGuard query log into 10-minute buckets for the last 24h:
 *     * Total queries (permitted / blocked / cached / other)
 *     * Client activity (per-client stacked series)
 * - With multiple servers, everything is summed/merged into one combined view;
 *   if a single instance is unreachable the dashboard keeps working with the rest
 * - Caches aggregated results to avoid hammering AdGuard Home
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

function hostLabel(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    } catch (_) {
        return null;
    }
}

/**
 * Accepts either a `servers: [...]` array or the legacy single `adguard: {...}`
 * block (wrapped into a one-element list). Each entry may carry its own
 * name, baseUrl, username, password and timeoutMs.
 */
function normalizeServers(user, defaults) {
    if (Array.isArray(user.servers)) {
        const servers = user.servers
            .map((s, i) => ({
                name: String(s.name || hostLabel(s.baseUrl) || `server-${i + 1}`),
                baseUrl: String(s.baseUrl || "").replace(/\/+$/, ""),
                username: s.username ?? "",
                password: s.password ?? "",
                timeoutMs: Number(s.timeoutMs) || 30000,
            }))
            .filter((s) => s.baseUrl);
        if (servers.length === 0) console.error("[config] 'servers' array contains no usable entries");
        return servers;
    }
    const a = { ...defaults.adguard, ...(user.adguard || {}) };
    return [
        {
            name: "AdGuard Home",
            baseUrl: String(a.baseUrl || "").replace(/\/+$/, ""),
            username: a.username ?? "",
            password: a.password ?? "",
            timeoutMs: Number(a.timeoutMs) || 30000,
        },
    ];
}

function loadConfig() {
    const defaults = {
        listenPort: 8199,
        adguard: {
            baseUrl: "http://192.168.5.30:8080",
            username: "",
            password: "",
            timeoutMs: 30000,
        },
        cacheTtlSeconds: 60,
        topCounts: { domains: 10, clients: 10, upstreams: 10 },
        activity: {
            hours: 24,
            intervalMinutes: 10,
            pageSize: 10000,
            maxPages: 80,
            maxClients: 24,
        },
    };

    let user = {};
    const cfgPath = path.join(ROOT, "config.json");
    try {
        if (fs.existsSync(cfgPath)) {
            user = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        } else {
            console.warn("[config] config.json not found, using defaults");
        }
    } catch (err) {
        console.error("[config] failed to parse config.json:", err.message);
        process.exit(1);
    }

    const cfg = {
        listenPort: user.listenPort ?? defaults.listenPort,
        cacheTtlSeconds: user.cacheTtlSeconds ?? defaults.cacheTtlSeconds,
        topCounts: { ...defaults.topCounts, ...(user.topCounts || {}) },
        activity: { ...defaults.activity, ...(user.activity || {}) },
        servers: [],
    };
    cfg.servers = normalizeServers(user, defaults);
    return cfg;
}

const CONFIG = loadConfig();

if (!Array.isArray(CONFIG.servers) || CONFIG.servers.length === 0) {
    console.error("[config] no AdGuard Home servers configured (see config.example.json)");
    process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/** Parse an RFC3339 timestamp that may carry nanosecond precision. */
function parseTimestampMs(ts) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?$/.exec(
        String(ts)
    );
    if (!m) {
        const fallback = Date.parse(ts);
        return Number.isNaN(fallback) ? null : fallback;
    }
    const [, Y, Mo, D, H, Mi, S, frac, zulu, sign, oh, om] = m;
    let ms = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
    if (frac) ms += Math.floor(Number((frac + "000").slice(0, 3)));
    if (!zulu && sign) ms += (sign === "-" ? 1 : -1) * ((+oh) * 60 + (+om)) * 60000;
    return ms;
}

async function aghFetch(server, apiPath) {
    const auth = Buffer.from(`${server.username}:${server.password}`).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), server.timeoutMs);
    try {
        const res = await fetch(server.baseUrl + apiPath, {
            headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
            signal: controller.signal,
        });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function aghJson(server, apiPath) {
    let res;
    try {
        res = await aghFetch(server, apiPath);
    } catch (err) {
        throw new ApiError(502, `Cannot reach ${server.name} at ${server.baseUrl}: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, `${server.name} rejected credentials (check username/password in config.json)`);
    }
    if (!res.ok) {
        throw new ApiError(502, `${server.name} returned HTTP ${res.status} for ${apiPath}`);
    }
    try {
        return await res.json();
    } catch (err) {
        throw new ApiError(502, `Invalid JSON from ${server.name} for ${apiPath}`);
    }
}

/* ------------------------------------------------------------------ */
/* Stats normalization                                                */
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

function aggregateStats(results) {
    const okResults = results.filter((r) => r.ok);
    const norm = okResults.map((r) => normalizeStats(r.raw));

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

    const tc = CONFIG.topCounts;
    return {
        totals,
        hourly: {
            queries: sumArrays(norm.map((n) => n.hourly.queries)),
            blocked: sumArrays(norm.map((n) => n.hourly.blocked)),
            safebrowsing: sumArrays(norm.map((n) => n.hourly.safebrowsing)),
            parental: sumArrays(norm.map((n) => n.hourly.parental)),
        },
        topQueried: mergeTopLists(norm.map((n) => n.topQueried), tc.domains),
        topBlocked: mergeTopLists(norm.map((n) => n.topBlocked), tc.domains),
        topClients: mergeTopLists(norm.map((n) => n.topClients), tc.clients),
        topUpstreams: mergeTopLists(norm.map((n) => n.topUpstreams), tc.upstreams),
        upstreamAvgTimesMs,
        generatedAt: new Date().toISOString(),
        servers: results.map(({ name, ok, error }) => ({ name, ok, error })),
    };
}

let statsCache = { data: null, expires: 0, inflight: null };

async function fetchServerStats(server) {
    try {
        const raw = await aghJson(server, "/control/stats");
        return { name: server.name, ok: true, raw, error: null };
    } catch (err) {
        return { name: server.name, ok: false, raw: null, error: err.message };
    }
}

async function getStats() {
    const now = Date.now();
    if (statsCache.data && now < statsCache.expires) return statsCache.data;
    if (statsCache.inflight) return statsCache.inflight;

    statsCache.inflight = (async () => {
        const results = await Promise.all(CONFIG.servers.map(fetchServerStats));
        if (!results.some((r) => r.ok)) {
            throw new ApiError(502, results.map((r) => `${r.name}: ${r.error}`).join("; "));
        }
        const down = results.filter((r) => !r.ok);
        if (down.length > 0) {
            console.warn(`[stats] some servers unreachable: ${down.map((r) => `${r.name}: ${r.error}`).join("; ")}`);
        }
        const data = aggregateStats(results);
        statsCache = { data, expires: Date.now() + CONFIG.cacheTtlSeconds * 1000, inflight: null };
        return data;
    })();

    try {
        return await statsCache.inflight;
    } catch (err) {
        statsCache.inflight = null;
        throw err;
    }
}

/* ------------------------------------------------------------------ */
/* Query-log activity aggregation                                     */
/* ------------------------------------------------------------------ */

function classifyEntry(entry) {
    const reason = String(entry.reason || "");
    if (/^Filtered/.test(reason) || reason === "CustomFilter") return "blocked";
    if (reason === "Rewrite" || reason === "RewrittenList") return "other";
    if (entry.cached === true) return "cached";
    const status = String(entry.status || "NOERROR");
    if (status !== "NOERROR" && status !== "NXDOMAIN" && status !== "") return "other";
    return "permitted";
}

function clientLabel(entry) {
    const ip = String(entry.client || "").trim();
    const infoName = entry.client_info && entry.client_info.name;
    const name = infoName ? String(infoName).trim() : "";
    if (!name) return ip || "unknown";
    // AGH sometimes reports a VLAN description (e.g. "Core VLAN") instead of
    // a hostname; those are ambiguous across clients, so show the IP instead.
    if (/vlan/i.test(name)) return ip || name;
    return name;
}

let activityCache = { data: null, expires: 0, inflight: null };

async function getActivity() {
    const now = Date.now();
    if (activityCache.data && now < activityCache.expires) return activityCache.data;
    if (activityCache.inflight) return activityCache.inflight;

    activityCache.inflight = computeActivity().then(
        (data) => {
            activityCache = { data, expires: Date.now() + CONFIG.cacheTtlSeconds * 1000, inflight: null };
            return data;
        },
        (err) => {
            activityCache.inflight = null;
            throw err;
        }
    );

    return activityCache.inflight;
}

/** Shared time window so all servers are bucketed identically. */
function makeWindow(hours, intervalMinutes) {
    const bucketMs = intervalMinutes * 60000;
    const bucketCount = Math.round((hours * 60) / intervalMinutes);
    // Buckets are aligned to absolute clock boundaries so bucket starts land on :00/:10/:20...
    const lastBucketStart = Math.floor(Date.now() / bucketMs) * bucketMs;
    const windowStart = lastBucketStart - (bucketCount - 1) * bucketMs;
    const windowEnd = lastBucketStart + bucketMs;
    return { bucketMs, bucketCount, windowStart, windowEnd };
}

// AdGuard Home sometimes answers a perfectly valid older_than page with an
// empty result (its query-log seek can fail transiently, e.g. while entries
// are being appended or around log rotation). Such a page must not be
// mistaken for the end of the log, or the charts lose their oldest hours.
const EMPTY_PAGE_RETRIES = 2;
const EMPTY_PAGE_RETRY_DELAY_MS = 500;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Page through one server's query log and tally it into the shared window buckets. */
async function collectServerActivity(server, win, activityCfg) {
    const { pageSize, maxPages } = activityCfg;

    const segments = { permitted: null, blocked: null, cached: null, other: null };
    for (const k of Object.keys(segments)) segments[k] = new Float64Array(win.bucketCount);
    const clientBuckets = new Map(); // label -> Float64Array(bucketCount)

    let olderThan = null;
    let scanned = 0;
    let complete = false;
    let oldestSeenMs = null;
    let emptyRetriesLeft = EMPTY_PAGE_RETRIES;

    let pagesUsed = 0;
    while (pagesUsed < maxPages) {
        let url = `/control/querylog?limit=${pageSize}&response_status=all`;
        if (olderThan) url += `&older_than=${encodeURIComponent(olderThan)}`;

        const payload = await aghJson(server, url);
        const entries = Array.isArray(payload.data) ? payload.data : [];
        if (entries.length === 0) {
            if (emptyRetriesLeft > 0) {
                // Could be a transient empty response rather than the real
                // end of the log; ask again before concluding anything.
                emptyRetriesLeft--;
                await sleep(EMPTY_PAGE_RETRY_DELAY_MS);
                continue;
            }
            // Out of retries. An empty very first page genuinely means the
            // log holds no entries at all; an empty page after a cursor means
            // we stopped short of windowStart and must not claim completion.
            if (olderThan === null) complete = true;
            break;
        }
        emptyRetriesLeft = EMPTY_PAGE_RETRIES;
        pagesUsed++;

        let reachedCutoff = false;
        for (const e of entries) {
            const t = parseTimestampMs(e.time);
            if (t === null) continue;
            if (oldestSeenMs === null || t < oldestSeenMs) oldestSeenMs = t;
            if (t < win.windowStart) {
                reachedCutoff = true;
                break; // entries arrive newest-first; everything after is older
            }
            const idx = Math.floor((t - win.windowStart) / win.bucketMs);
            if (idx < 0 || idx >= win.bucketCount) continue;

            segments[classifyEntry(e)][idx] += 1;
            const label = clientLabel(e);
            let row = clientBuckets.get(label);
            if (!row) {
                row = new Float64Array(win.bucketCount);
                clientBuckets.set(label, row);
            }
            row[idx] += 1;
            scanned++;
        }

        if (reachedCutoff) {
            complete = true;
            break;
        }

        const lastTime = entries[entries.length - 1].time;
        if (lastTime === olderThan) break; // no forward progress; avoid infinite loop
        olderThan = lastTime;
    }

    return { segments, clientBuckets, scanned, complete, oldestSeenMs };
}

function mergeClientBuckets(maps, bucketCount) {
    const merged = new Map();
    for (const map of maps) {
        for (const [label, row] of map) {
            let dst = merged.get(label);
            if (!dst) {
                dst = new Float64Array(bucketCount);
                merged.set(label, dst);
            }
            for (let b = 0; b < bucketCount; b++) dst[b] += row[b];
        }
    }
    return merged;
}

async function computeActivity() {
    const cfg = CONFIG.activity;
    const win = makeWindow(cfg.hours, cfg.intervalMinutes);

    // All servers are collected concurrently; each has its own pagination cursor.
    const settled = await Promise.allSettled(CONFIG.servers.map((s) => collectServerActivity(s, win, cfg)));

    const collected = [];
    const failed = [];
    settled.forEach((r, i) => {
        const name = CONFIG.servers[i].name;
        if (r.status === "fulfilled") {
            collected.push({ name, ...r.value });
        } else {
            failed.push({
                name,
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            });
        }
    });

    if (collected.length === 0) {
        throw new ApiError(502, failed.map((f) => `${f.name}: ${f.error}`).join("; "));
    }
    if (failed.length > 0) {
        console.warn(`[activity] some servers unavailable: ${failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`);
    }

    // Merge segment buckets.
    const segments = {};
    for (const key of Object.keys(collected[0].segments)) {
        const acc = new Float64Array(win.bucketCount);
        for (const c of collected) {
            for (let b = 0; b < win.bucketCount; b++) acc[b] += c.segments[key][b];
        }
        segments[key] = acc;
    }

    // Merge per-client buckets; clients with the same label on both servers are combined.
    const clientBuckets = mergeClientBuckets(
        collected.map((c) => c.clientBuckets),
        win.bucketCount
    );

    let scanned = 0;
    let complete = true;
    let oldestSeenMs = null;
    for (const c of collected) {
        scanned += c.scanned;
        complete = complete && c.complete;
        if (c.oldestSeenMs !== null && (oldestSeenMs === null || c.oldestSeenMs < oldestSeenMs)) {
            oldestSeenMs = c.oldestSeenMs;
        }
    }
    // With a server missing we can't claim full coverage even if the rest completed.
    if (failed.length > 0) complete = false;

    // Assemble per-client matrix, sorted by volume desc; merge tail into "Other clients"
    const clientTotals = [...clientBuckets.entries()]
        .map(([name, row]) => [name, row, row.reduce((a, b) => a + b, 0)])
        .sort((a, b) => b[2] - a[2]);

    const names = [];
    const rows = [];
    let otherRow = null;
    clientTotals.forEach(([name, row], i) => {
        if (i < cfg.maxClients) {
            names.push(name);
            rows.push(Array.from(row));
        } else {
            if (!otherRow) {
                otherRow = new Float64Array(win.bucketCount);
                names.push("Other clients");
            }
            for (let b = 0; b < win.bucketCount; b++) otherRow[b] += row[b];
        }
    });
    if (otherRow) rows.push(Array.from(otherRow));

    const total = new Float64Array(win.bucketCount);
    for (const seg of Object.values(segments)) {
        for (let b = 0; b < win.bucketCount; b++) total[b] += seg[b];
    }

    const grandTotal = total.reduce((a, b) => a + b, 0);
    const coveragePercent = Math.max(
        0,
        Math.min(
            100,
            complete
                ? 100
                : oldestSeenMs
                  ? Math.round(
                        ((win.windowEnd - Math.max(oldestSeenMs, win.windowStart)) /
                            (win.windowEnd - win.windowStart)) *
                            100
                    )
                  : 0
        )
    );
    if (!complete) {
        // A server failed, pagination hit maxPages, or AGH kept returning
        // empty pages before the window start was reached.
        console.warn(
            `[activity] ${cfg.hours}h window not fully covered: ~${coveragePercent}% coverage, ` +
                `${scanned} entries scanned${grandTotal === 0 ? ", none collected" : ""}`
        );
    }

    return {
        generatedAt: new Date().toISOString(),
        windowHours: cfg.hours,
        bucketMinutes: cfg.intervalMinutes,
        bucketCount: win.bucketCount,
        bucketStartsMs: Array.from({ length: win.bucketCount }, (_, i) => win.windowStart + i * win.bucketMs),
        windowEndMs: win.windowEnd,
        series: {
            permitted: Array.from(segments.permitted),
            blocked: Array.from(segments.blocked),
            cached: Array.from(segments.cached),
            other: Array.from(segments.other),
            total: Array.from(total),
        },
        clients: { names, rows },
        meta: {
            entriesScanned: scanned,
            complete,
            oldestEntryMs: oldestSeenMs,
            coveragePercent,
            servers: [
                ...collected.map((c) => ({ name: c.name, ok: true, error: null })),
                ...failed.map((f) => ({ name: f.name, ok: false, error: f.error })),
            ],
        },
    };
}

/* ------------------------------------------------------------------ */
/* Static files & routing                                             */
/* ------------------------------------------------------------------ */

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
    });
    res.end(body);
}

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === "/") rel = "/index.html";
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        return res.end("Forbidden");
    }
    fs.readFile(filePath, (err, buf) => {
        if (err) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            return res.end("Not found");
        }
        res.writeHead(200, {
            "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
            "Content-Length": buf.length,
            "Cache-Control": filePath.includes(`${path.sep}vendor${path.sep}`)
                ? "public, max-age=86400"
                : "no-cache",
        });
        res.end(buf);
    });
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const started = Date.now();

    try {
        if (url.pathname === "/api/stats") {
            const data = await getStats();
            sendJson(res, 200, data);
        } else if (url.pathname === "/api/activity") {
            const data = await getActivity();
            sendJson(res, 200, data);
        } else if (url.pathname === "/api/health") {
            sendJson(res, 200, {
                ok: true,
                uptimeSec: Math.round(process.uptime()),
                servers: CONFIG.servers.map((s) => ({ name: s.name, baseUrl: s.baseUrl })),
            });
        } else if (url.pathname.startsWith("/api/")) {
            sendJson(res, 404, { error: "Unknown API endpoint" });
        } else {
            serveStatic(req, res, url.pathname);
        }
    } catch (err) {
        const status = err instanceof ApiError ? err.status : 500;
        if (status >= 500) console.error(`[error] ${req.method} ${req.url} ->`, err.message);
        sendJson(res, status, { error: err.message || "Internal error" });
    } finally {
        if (!url.pathname.startsWith("/api/health")) {
            console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
        }
    }
});

server.listen(CONFIG.listenPort, () => {
    console.log(`AdGuard Home dashboard listening on http://localhost:${CONFIG.listenPort}`);
    for (const s of CONFIG.servers) {
        console.log(`Upstream AdGuard Home "${s.name}": ${s.baseUrl} (user: ${s.username || "<none>"})`);
    }

    // Warm caches at startup and keep them fresh in the background so that
    // browser requests are almost always served from cache.
    const warmActivity = async () => {
        try {
            const t0 = Date.now();
            await getActivity();
            console.log(`[activity] cache refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (err) {
            console.error("[activity] background refresh failed:", err.message);
        }
    };
    warmActivity();
    setInterval(warmActivity, Math.max(CONFIG.cacheTtlSeconds * 2, 120) * 1000);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        console.log(`\n${sig} received, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}

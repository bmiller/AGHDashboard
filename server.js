#!/usr/bin/env node
"use strict";

/*
 * AdGuard Home Dashboard - zero-dependency Node.js server
 *
 * - Serves the static frontend from ./public
 * - Proxies /api/stats to AdGuard Home /control/stats (normalizes old/new formats)
 * - Aggregates AdGuard query log into 10-minute buckets for the last 24h:
 *     * Total queries (permitted / blocked / cached / other)
 *     * Client activity (per-client stacked series)
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

    return {
        listenPort: user.listenPort ?? defaults.listenPort,
        cacheTtlSeconds: user.cacheTtlSeconds ?? defaults.cacheTtlSeconds,
        adguard: { ...defaults.adguard, ...(user.adguard || {}) },
        activity: { ...defaults.activity, ...(user.activity || {}) },
    };
}

const CONFIG = loadConfig();

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

async function aghFetch(apiPath) {
    const base = CONFIG.adguard.baseUrl.replace(/\/+$/, "");
    const auth = Buffer.from(
        `${CONFIG.adguard.username}:${CONFIG.adguard.password}`
    ).toString("base64");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.adguard.timeoutMs);
    try {
        const res = await fetch(base + apiPath, {
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

async function aghJson(apiPath) {
    let res;
    try {
        res = await aghFetch(apiPath);
    } catch (err) {
        throw new ApiError(502, `Cannot reach AdGuard Home at ${CONFIG.adguard.baseUrl}: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, "AdGuard Home rejected credentials (check username/password in config.json)");
    }
    if (!res.ok) {
        throw new ApiError(502, `AdGuard Home returned HTTP ${res.status} for ${apiPath}`);
    }
    try {
        return await res.json();
    } catch (err) {
        throw new ApiError(502, `Invalid JSON from AdGuard Home for ${apiPath}`);
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
        topQueried: normalizeTopList(raw.top_queried_domains, "domain").slice(0, CONFIG.topCounts?.domains ?? 10),
        topBlocked: normalizeTopList(raw.top_blocked_domains, "domain").slice(0, CONFIG.topCounts?.domains ?? 10),
        topClients: normalizeTopList(raw.top_clients, "ip"),
        topUpstreams: normalizeTopList(raw.top_upstreams_responses, "ip"),
    };
}

let statsCache = { data: null, expires: 0, inflight: null };

async function getStats() {
    const now = Date.now();
    if (statsCache.data && now < statsCache.expires) return statsCache.data;
    if (statsCache.inflight) return statsCache.inflight;

    statsCache.inflight = (async () => {
        const raw = await aghJson("/control/stats");
        const data = { ...normalizeStats(raw), generatedAt: new Date().toISOString() };
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
    const infoName = entry.client_info && entry.client_info.name;
    if (infoName && String(infoName).trim()) return String(infoName).trim();
    return String(entry.client || "unknown");
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

async function computeActivity() {
    const { hours, intervalMinutes, pageSize, maxPages, maxClients } = CONFIG.activity;
    const bucketMs = intervalMinutes * 60000;
    const bucketCount = Math.round((hours * 60) / intervalMinutes);

    // Buckets are aligned to absolute clock boundaries so bucket starts land on :00/:10/:20...
    const lastBucketStart = Math.floor(Date.now() / bucketMs) * bucketMs;
    const windowStart = lastBucketStart - (bucketCount - 1) * bucketMs;
    const windowEnd = lastBucketStart + bucketMs;

    const segments = { permitted: null, blocked: null, cached: null, other: null };
    for (const k of Object.keys(segments)) segments[k] = new Float64Array(bucketCount);
    const clientBuckets = new Map(); // label -> Float64Array(bucketCount)

    let olderThan = null;
    let scanned = 0;
    let complete = false;
    let oldestSeenMs = null;

    for (let page = 0; page < maxPages; page++) {
        let url = `/control/querylog?limit=${pageSize}&response_status=all`;
        if (olderThan) url += `&older_than=${encodeURIComponent(olderThan)}`;

        const payload = await aghJson(url);
        const entries = Array.isArray(payload.data) ? payload.data : [];
        if (entries.length === 0) {
            complete = true;
            break;
        }

        let reachedCutoff = false;
        for (const e of entries) {
            const t = parseTimestampMs(e.time);
            if (t === null) continue;
            if (oldestSeenMs === null || t < oldestSeenMs) oldestSeenMs = t;
            if (t < windowStart) {
                reachedCutoff = true;
                break; // entries arrive newest-first; everything after is older
            }
            const idx = Math.floor((t - windowStart) / bucketMs);
            if (idx < 0 || idx >= bucketCount) continue;

            segments[classifyEntry(e)][idx] += 1;
            const label = clientLabel(e);
            let row = clientBuckets.get(label);
            if (!row) {
                row = new Float64Array(bucketCount);
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

    // Assemble per-client matrix, sorted by volume desc; merge tail into "Other clients"
    const clientTotals = [...clientBuckets.entries()]
        .map(([name, row]) => [name, row, row.reduce((a, b) => a + b, 0)])
        .sort((a, b) => b[2] - a[2]);

    const names = [];
    const rows = [];
    let otherRow = null;
    clientTotals.forEach(([name, row], i) => {
        if (i < maxClients) {
            names.push(name);
            rows.push(Array.from(row));
        } else {
            if (!otherRow) {
                otherRow = new Float64Array(bucketCount);
                names.push("Other clients");
            }
            for (let b = 0; b < bucketCount; b++) otherRow[b] += row[b];
        }
    });
    if (otherRow) rows.push(Array.from(otherRow));

    const total = new Float64Array(bucketCount);
    for (const seg of Object.values(segments)) {
        for (let b = 0; b < bucketCount; b++) total[b] += seg[b];
    }

    const grandTotal = total.reduce((a, b) => a + b, 0);
    if (grandTotal === 0 && !complete) {
        // Nothing usable was collected and we did not reach the window start.
        console.warn("[activity] window not fully covered by available data");
    }

    return {
        generatedAt: new Date().toISOString(),
        windowHours: hours,
        bucketMinutes: intervalMinutes,
        bucketCount,
        bucketStartsMs: Array.from({ length: bucketCount }, (_, i) => windowStart + i * bucketMs),
        windowEndMs: windowEnd,
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
            coveragePercent: Math.max(
                0,
                Math.min(
                    100,
                    complete
                        ? 100
                        : oldestSeenMs
                          ? Math.round(((windowEnd - Math.max(oldestSeenMs, windowStart)) / (windowEnd - windowStart)) * 100)
                          : 0
                )
            ),
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
            sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
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
    console.log(`Upstream AdGuard Home: ${CONFIG.adguard.baseUrl} (user: ${CONFIG.adguard.username || "<none>"})`);

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

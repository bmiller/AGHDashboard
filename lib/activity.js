"use strict";

const { ApiError, parseTimestampMs, sleep } = require("./util");
const { aghJson } = require("./agh");

/* ------------------------------------------------------------------ */
/* Query-log classification helpers (pure)                            */
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

/** Shared time window so all servers are bucketed identically. */
function makeWindow(hours, intervalMinutes, now = Date.now()) {
    const bucketMs = intervalMinutes * 60000;
    const bucketCount = Math.round((hours * 60) / intervalMinutes);
    // Buckets are aligned to absolute clock boundaries so bucket starts land on :00/:10/:20...
    const lastBucketStart = Math.floor(now / bucketMs) * bucketMs;
    const windowStart = lastBucketStart - (bucketCount - 1) * bucketMs;
    const windowEnd = lastBucketStart + bucketMs;
    return { bucketMs, bucketCount, windowStart, windowEnd };
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

// AdGuard Home sometimes answers a perfectly valid older_than page with an
// empty result (its query-log seek can fail transiently, e.g. while entries
// are being appended or around log rotation). Such a page must not be
// mistaken for the end of the log, or the charts lose their oldest hours.
const EMPTY_PAGE_RETRIES = 2;
const EMPTY_PAGE_RETRY_DELAY_MS = 500;

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

/* ------------------------------------------------------------------ */
/* Full aggregation across servers                                    */
/* ------------------------------------------------------------------ */

async function computeActivity(servers, activityCfg) {
    const win = makeWindow(activityCfg.hours, activityCfg.intervalMinutes);

    // All servers are collected concurrently; each has its own pagination cursor.
    const settled = await Promise.allSettled(servers.map((s) => collectServerActivity(s, win, activityCfg)));

    const collected = [];
    const failed = [];
    settled.forEach((r, i) => {
        const name = servers[i].name;
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
        if (i < activityCfg.maxClients) {
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
            `[activity] ${activityCfg.hours}h window not fully covered: ~${coveragePercent}% coverage, ` +
                `${scanned} entries scanned${grandTotal === 0 ? ", none collected" : ""}`
        );
    }

    return {
        generatedAt: new Date().toISOString(),
        windowHours: activityCfg.hours,
        bucketMinutes: activityCfg.intervalMinutes,
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

// How long a previously-complete dataset may keep standing in for incomplete
// refreshes. Past this the (partial) fresh data is shown rather than something
// visibly stale.
const STALE_FALLBACK_MAX_MS = 15 * 60 * 1000;

/** Build a cached getActivity() bound to the given config. */
function createActivityService(config) {
    let cache = { data: null, expires: 0, inflight: null, lastComplete: null };

    function getActivity() {
        const now = Date.now();
        if (cache.data && now < cache.expires) return Promise.resolve(cache.data);
        if (cache.inflight) return cache.inflight;

        cache.inflight = computeActivity(config.servers, config.activity).then(
            (fresh) => {
                const ttl = config.cacheTtlSeconds * 1000;
                const prev = cache.lastComplete;
                let data = fresh;

                if (
                    !fresh.meta.complete &&
                    prev &&
                    Date.now() - Date.parse(prev.generatedAt) < STALE_FALLBACK_MAX_MS
                ) {
                    console.warn("[activity] refresh incomplete; keeping last complete dataset");
                    data = prev;
                }

                cache = {
                    data,
                    expires: Date.now() + ttl,
                    inflight: null,
                    lastComplete: fresh.meta.complete ? fresh : prev,
                };
                return data;
            },
            (err) => {
                cache.inflight = null;
                throw err;
            }
        );

        return cache.inflight;
    }

    return { getActivity };
}

module.exports = {
    classifyEntry,
    clientLabel,
    makeWindow,
    mergeClientBuckets,
    collectServerActivity,
    computeActivity,
    createActivityService,
};

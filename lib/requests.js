"use strict";

const { ApiError, parseTimestampMs, sleep } = require("./util");
const { aghJson } = require("./agh");
const { classifyEntry, clientLabel } = require("./activity");

/** Extract the queried domain name from a querylog entry, trimming the trailing root dot. */
function domainOf(entry) {
    const q = entry.question || {};
    let name = String(q.name || q.host || "").trim();
    if (name.endsWith(".")) name = name.slice(0, -1);
    return name || "unknown";
}

/** DNS record type queried (A, AAAA, HTTPS, ...), or "" if unknown. */
function queryTypeOf(entry) {
    return String((entry.question && entry.question.type) || "");
}

/** Processing time in ms, rounded to 1 decimal, or null if unavailable. */
function elapsedMsOf(entry) {
    const n = Number(entry.elapsedMs);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Text of the single filter rule that matched, or "" if none did. */
function ruleOf(entry) {
    if (entry.rule) return String(entry.rule);
    if (Array.isArray(entry.rules) && entry.rules.length > 0) return String(entry.rules[0].text || "");
    return "";
}

const EMPTY_PAGE_RETRIES = 2;
const EMPTY_PAGE_RETRY_DELAY_MS = 500;

/**
 * Check a requested [startMs, endMs) window against the configured limits.
 * Returns an error message, or null if the window is acceptable.
 */
function validateRange(config, startMs, endMs, now = Date.now()) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        return "start and end query params (ms since epoch) are required, with end > start";
    }
    const maxRangeMs = config.requests.maxRangeMinutes * 60000;
    if (endMs - startMs > maxRangeMs) {
        return `requested window is too wide (max ${config.requests.maxRangeMinutes} minutes)`;
    }
    const oldestMs = now - config.activity.hours * 3600000;
    if (endMs <= oldestMs) {
        return `requested window is older than the last ${config.activity.hours} hours`;
    }
    if (startMs > now) {
        return "requested window is in the future";
    }
    return null;
}

/**
 * Page through one server's query log collecting entries whose timestamp
 * falls in [startMs, endMs). AdGuard Home returns entries newest-first, so
 * pages newer than the window are skipped until entries fall into range,
 * then collection stops as soon as an entry older than startMs is seen.
 */
async function collectServerRequests(server, startMs, endMs, activityCfg) {
    const { pageSize, maxPages } = activityCfg;
    const results = [];

    let olderThan = null;
    let complete = false;
    let emptyRetriesLeft = EMPTY_PAGE_RETRIES;
    let pagesUsed = 0;

    while (pagesUsed < maxPages) {
        let url = `/control/querylog?limit=${pageSize}&response_status=all`;
        if (olderThan) url += `&older_than=${encodeURIComponent(olderThan)}`;

        const payload = await aghJson(server, url);
        const entries = Array.isArray(payload.data) ? payload.data : [];
        if (entries.length === 0) {
            if (emptyRetriesLeft > 0) {
                emptyRetriesLeft--;
                await sleep(EMPTY_PAGE_RETRY_DELAY_MS);
                continue;
            }
            if (olderThan === null) complete = true;
            break;
        }
        emptyRetriesLeft = EMPTY_PAGE_RETRIES;
        pagesUsed++;

        let reachedCutoff = false;
        for (const e of entries) {
            const t = parseTimestampMs(e.time);
            if (t === null) continue;
            if (t < startMs) {
                reachedCutoff = true;
                break; // entries arrive newest-first; everything after is older
            }
            if (t >= endMs) continue; // still newer than the requested window

            results.push({
                timeMs: t,
                time: e.time,
                domain: domainOf(e),
                queryType: queryTypeOf(e),
                client: clientLabel(e),
                status: classifyEntry(e),
                upstream: String(e.upstream || ""),
                elapsedMs: elapsedMsOf(e),
                rule: ruleOf(e),
                server: server.name,
            });
        }

        if (reachedCutoff) {
            complete = true;
            break;
        }

        const lastTime = entries[entries.length - 1].time;
        if (lastTime === olderThan) break; // no forward progress; avoid infinite loop
        olderThan = lastTime;
    }

    return { results, complete };
}

/**
 * Fetch requests within [startMs, endMs) across every configured server,
 * optionally filtered by client label, capped at config.requests.maxRows.
 *
 * meta.servers lists every server ({name, ok, error, complete}), matching
 * /api/activity. A server can be ok but incomplete when pagination hit
 * activity.maxPages before reaching startMs.
 */
async function getRequestsInRange(config, startMs, endMs, clientFilter) {
    const settled = await Promise.allSettled(
        config.servers.map((s) => collectServerRequests(s, startMs, endMs, config.activity))
    );

    let results = [];
    const servers = [];
    settled.forEach((r, i) => {
        const name = config.servers[i].name;
        if (r.status === "fulfilled") {
            results = results.concat(r.value.results);
            servers.push({ name, ok: true, error: null, complete: r.value.complete });
        } else {
            const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
            servers.push({ name, ok: false, error, complete: false });
        }
    });

    if (!servers.some((s) => s.ok)) {
        throw new ApiError(502, servers.map((s) => `${s.name}: ${s.error}`).join("; "));
    }

    if (clientFilter) {
        const wanted = String(clientFilter).toLowerCase();
        results = results.filter((r) => r.client.toLowerCase() === wanted);
    }

    results.sort((a, b) => a.timeMs - b.timeMs);

    const totalCount = results.length;
    const truncated = totalCount > config.requests.maxRows;
    if (truncated) results = results.slice(0, config.requests.maxRows);

    return {
        generatedAt: new Date().toISOString(),
        startMs,
        endMs,
        client: clientFilter || null,
        count: results.length,
        totalCount,
        truncated,
        requests: results,
        meta: { complete: servers.every((s) => s.complete), servers },
    };
}

/**
 * Build a getRequests() bound to the given config that validates the window
 * and limits how many query-log scans run at once.
 */
function createRequestsService(config) {
    let active = 0;

    async function getRequests(startMs, endMs, clientFilter) {
        const problem = validateRange(config, startMs, endMs);
        if (problem) throw new ApiError(400, problem);
        if (active >= config.requests.maxConcurrent) {
            throw new ApiError(429, "Too many request lookups in progress; try again shortly");
        }
        active++;
        try {
            return await getRequestsInRange(config, startMs, endMs, clientFilter);
        } finally {
            active--;
        }
    }

    return { getRequests };
}

module.exports = {
    domainOf,
    queryTypeOf,
    elapsedMsOf,
    ruleOf,
    validateRange,
    collectServerRequests,
    getRequestsInRange,
    createRequestsService,
};

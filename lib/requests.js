"use strict";

const { parseTimestampMs, sleep } = require("./util");
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

/** Fetch all requests within [startMs, endMs) across every configured server, optionally filtered by client label. */
async function getRequestsInRange(config, startMs, endMs, clientFilter) {
    const settled = await Promise.allSettled(
        config.servers.map((s) => collectServerRequests(s, startMs, endMs, config.activity))
    );

    let results = [];
    let complete = true;
    const failed = [];
    settled.forEach((r, i) => {
        const name = config.servers[i].name;
        if (r.status === "fulfilled") {
            results = results.concat(r.value.results);
            complete = complete && r.value.complete;
        } else {
            failed.push({ name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
            complete = false;
        }
    });

    if (clientFilter) {
        const wanted = String(clientFilter).toLowerCase();
        results = results.filter((r) => r.client.toLowerCase() === wanted);
    }

    results.sort((a, b) => a.timeMs - b.timeMs);

    return {
        generatedAt: new Date().toISOString(),
        startMs,
        endMs,
        client: clientFilter || null,
        count: results.length,
        requests: results,
        meta: { complete, servers: failed },
    };
}

module.exports = { domainOf, queryTypeOf, elapsedMsOf, ruleOf, collectServerRequests, getRequestsInRange };

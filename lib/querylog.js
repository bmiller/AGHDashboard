"use strict";

const { parseTimestampMs, sleep } = require("./util");
const { aghJson } = require("./agh");

/* Shared query-log pagination used by activity bucketing and request listing. */

// AdGuard Home sometimes answers a perfectly valid older_than page with an
// empty result (its query-log seek can fail transiently, e.g. while entries
// are being appended or around log rotation). Such a page must not be
// mistaken for the end of the log, or callers lose their oldest entries.
const EMPTY_PAGE_RETRIES = 2;
const EMPTY_PAGE_RETRY_DELAY_MS = 500;

/**
 * Page through one server's query log (newest first, via `older_than`) and
 * call visit(entry, timeMs) for every timestamped entry at or after cutoffMs.
 * Stops at the first entry older than cutoffMs, after activityCfg.maxPages
 * non-empty pages, or when AGH stops making progress.
 *
 * Returns { complete, oldestSeenMs }: complete is true only if cutoffMs (or
 * the genuine end of the log) was reached; oldestSeenMs is the oldest
 * timestamp seen, including the entry that crossed the cutoff.
 */
async function scanQueryLog(server, activityCfg, cutoffMs, visit, { retryDelayMs = EMPTY_PAGE_RETRY_DELAY_MS } = {}) {
    const { pageSize, maxPages } = activityCfg;

    let olderThan = null;
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
                await sleep(retryDelayMs);
                continue;
            }
            // Out of retries. An empty very first page genuinely means the
            // log holds no entries at all; an empty page after a cursor means
            // we stopped short of cutoffMs and must not claim completion.
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
            if (t < cutoffMs) {
                reachedCutoff = true;
                break; // entries arrive newest-first; everything after is older
            }
            visit(e, t);
        }

        if (reachedCutoff) {
            complete = true;
            break;
        }

        const lastTime = entries[entries.length - 1].time;
        if (lastTime === olderThan) break; // no forward progress; avoid infinite loop
        olderThan = lastTime;
    }

    return { complete, oldestSeenMs };
}

module.exports = { scanQueryLog, EMPTY_PAGE_RETRIES };

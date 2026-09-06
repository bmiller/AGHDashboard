"use strict";

/* Small shared helpers with no I/O or config dependencies. */

/** HTTP-style error carrying a status code for the top-level handler. */
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "ApiError";
    }
}

/** Parse an RFC3339 timestamp that may carry nanosecond precision. Returns ms or null. */
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
    if (!zulu && sign) ms += (sign === "-" ? 1 : -1) * (+oh * 60 + +om) * 60000;
    return ms;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ApiError, parseTimestampMs, sleep };

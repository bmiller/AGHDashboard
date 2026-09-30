"use strict";

const crypto = require("crypto");

/* Optional HTTP Basic auth protecting the dashboard itself (config `auth`). */

/** Constant-time string comparison (hashing first so differing lengths don't leak). */
function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * True if the Authorization header carries the configured credentials.
 * With no `auth` configured every request is allowed.
 */
function checkBasicAuth(header, auth) {
    if (!auth) return true;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ""));
    if (!m) return false;
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return false;
    // Evaluate both comparisons so timing doesn't reveal which one failed.
    const userOk = safeEqual(decoded.slice(0, sep), auth.username);
    const passOk = safeEqual(decoded.slice(sep + 1), auth.password);
    return userOk && passOk;
}

/** Loopback bind addresses, for the "exposed without auth" startup warning. */
function isLoopbackHost(host) {
    return host === "localhost" || host === "::1" || /^127\./.test(host);
}

module.exports = { safeEqual, checkBasicAuth, isLoopbackHost };

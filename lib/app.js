"use strict";

const fs = require("fs");
const path = require("path");

const { checkBasicAuth } = require("./auth");
const { ApiError } = require("./util");

/* HTTP request handling: security headers, auth, API routing and static files. */

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

// Sent on every response. Scripts are same-origin files only (no inline
// scripts); inline style attributes are still needed by the chart and table
// markup. The favicon is a data: URI.
const SECURITY_HEADERS = {
    "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
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

function sendText(res, status, text, headers = {}) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
    res.end(text);
}

function serveStatic(req, res, publicDir, pathname) {
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch (_) {
        return sendText(res, 400, "Bad request");
    }
    if (rel === "/") rel = "/index.html";
    const filePath = path.normalize(path.join(publicDir, rel));
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
        return sendText(res, 403, "Forbidden");
    }
    fs.readFile(filePath, (err, buf) => {
        if (err) return sendText(res, 404, "Not found");
        res.writeHead(200, {
            "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
            "Content-Length": buf.length,
            "Cache-Control": filePath.includes(`${path.sep}vendor${path.sep}`)
                ? "public, max-age=86400"
                : "no-cache",
        });
        res.end(req.method === "HEAD" ? undefined : buf);
    });
}

/**
 * Build the HTTP request handler.
 * @param {object} config    loaded config (uses `auth`)
 * @param {object} services  { getStats, getActivity, getRequests }
 * @param {string} publicDir absolute path of the static frontend
 */
function createHandler(config, services, publicDir) {
    const { getStats, getActivity, getRequests } = services;

    return async function handle(req, res) {
        const started = Date.now();

        // Log once the response is actually flushed, so the status code is accurate
        // even for the async static-file path.
        res.on("finish", () => {
            if (!String(req.url).startsWith("/api/health")) {
                console.log(
                    `${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`
                );
            }
        });

        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

        try {
            // Everything here is read-only.
            if (req.method !== "GET" && req.method !== "HEAD") {
                return sendText(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
            }

            // Fixed base: the Host header is client-controlled and never needed here
            // (a malformed one used to make this throw and crash the process).
            const url = new URL(req.url, "http://localhost");

            // Health stays open for monitoring; it reveals nothing about the upstreams.
            if (url.pathname === "/api/health") {
                return sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
            }

            if (!checkBasicAuth(req.headers.authorization, config.auth)) {
                return sendText(res, 401, "Authentication required", {
                    "WWW-Authenticate": 'Basic realm="AdGuard Home Dashboard", charset="UTF-8"',
                });
            }

            if (url.pathname === "/api/stats") {
                sendJson(res, 200, await getStats());
            } else if (url.pathname === "/api/activity") {
                sendJson(res, 200, await getActivity());
            } else if (url.pathname === "/api/requests") {
                const start = Number(url.searchParams.get("start"));
                const end = Number(url.searchParams.get("end"));
                sendJson(res, 200, await getRequests(start, end));
            } else if (url.pathname.startsWith("/api/")) {
                sendJson(res, 404, { error: "Unknown API endpoint" });
            } else {
                serveStatic(req, res, publicDir, url.pathname);
            }
        } catch (err) {
            // ApiError messages are written to be shown to users; anything else
            // is unexpected and its details stay in the server log.
            const isApi = err instanceof ApiError;
            const status = isApi ? err.status : 500;
            if (status >= 500) console.error(`[error] ${req.method} ${req.url} ->`, isApi ? err.message : err);
            if (!res.headersSent) sendJson(res, status, { error: isApi ? err.message : "Internal error" });
        }
    };
}

module.exports = { createHandler, SECURITY_HEADERS };

#!/usr/bin/env node
"use strict";

/*
 * AdGuard Home Dashboard - zero-dependency Node.js server
 *
 * - Serves the static frontend from ./public
 * - Talks to one or more AdGuard Home instances (config `servers` array)
 * - Proxies /api/stats to AdGuard Home /control/stats (normalizes old/new formats)
 * - Aggregates AdGuard query log into 10-minute buckets for the last 24h
 * - With multiple servers, everything is summed/merged into one combined view;
 *   if a single instance is unreachable the dashboard keeps working with the rest
 * - Caches aggregated results to avoid hammering AdGuard Home
 *
 * Implementation is split across ./lib:
 *   config.js   - config.json loading, defaults + validation
 *   auth.js     - optional Basic auth for the dashboard itself
 *   util.js     - ApiError, timestamp parsing, sleep
 *   agh.js      - AdGuard Home HTTP client
 *   stats.js    - /control/stats normalization + cached getStats()
 *   activity.js - query-log bucketing + cached getActivity()
 *   requests.js - per-window request listing (validated, concurrency-limited)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { loadConfig, ConfigError, ROOT } = require("./lib/config");
const { checkBasicAuth, isLoopbackHost } = require("./lib/auth");
const { ApiError } = require("./lib/util");
const { createStatsService } = require("./lib/stats");
const { createActivityService } = require("./lib/activity");
const { createRequestsService } = require("./lib/requests");

const PUBLIC_DIR = path.join(ROOT, "public");

let CONFIG;
try {
    CONFIG = loadConfig();
} catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`[config] ${err.message}`);
    process.exit(1);
}

const { getStats } = createStatsService(CONFIG);
const { getActivity, refreshActivity } = createActivityService(CONFIG);
const { getRequests } = createRequestsService(CONFIG);

// Last-resort guard: a stray rejected promise must never take the server down.
process.on("unhandledRejection", (reason) => {
    console.error("[error] unhandled rejection:", reason instanceof Error ? reason.stack : reason);
});

/* ------------------------------------------------------------------ */
/* Static files & routing                                             */
/* ------------------------------------------------------------------ */

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
    let rel;
    try {
        rel = decodeURIComponent(pathname);
    } catch (_) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        return res.end("Bad request");
    }
    if (rel === "/") rel = "/index.html";
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
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
        res.end(req.method === "HEAD" ? undefined : buf);
    });
}

const server = http.createServer(async (req, res) => {
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

    try {
        // Fixed base: the Host header is client-controlled and never needed here
        // (a malformed one used to make this throw and crash the process).
        const url = new URL(req.url, "http://localhost");

        // Health stays open for monitoring; it reveals nothing about the upstreams.
        if (url.pathname === "/api/health") {
            return sendJson(res, 200, { ok: true, uptimeSec: Math.round(process.uptime()) });
        }

        if (!checkBasicAuth(req.headers.authorization, CONFIG.auth)) {
            res.writeHead(401, {
                "WWW-Authenticate": 'Basic realm="AdGuard Home Dashboard", charset="UTF-8"',
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
            });
            return res.end("Authentication required");
        }

        if (url.pathname === "/api/stats") {
            sendJson(res, 200, await getStats());
        } else if (url.pathname === "/api/activity") {
            sendJson(res, 200, await getActivity());
        } else if (url.pathname === "/api/requests") {
            const start = Number(url.searchParams.get("start"));
            const end = Number(url.searchParams.get("end"));
            const client = url.searchParams.get("client");
            sendJson(res, 200, await getRequests(start, end, client));
        } else if (url.pathname.startsWith("/api/")) {
            sendJson(res, 404, { error: "Unknown API endpoint" });
        } else {
            serveStatic(req, res, url.pathname);
        }
    } catch (err) {
        const status = err instanceof ApiError ? err.status : 500;
        if (status >= 500) console.error(`[error] ${req.method} ${req.url} ->`, err.message);
        if (!res.headersSent) sendJson(res, status, { error: err.message || "Internal error" });
    }
});

server.on("error", (err) => {
    console.error("[server] fatal:", err.message);
    process.exit(1);
});

server.listen(CONFIG.listenPort, CONFIG.listenHost, () => {
    console.log(`AdGuard Home dashboard listening on http://${CONFIG.listenHost}:${CONFIG.listenPort}`);
    if (!CONFIG.auth && !isLoopbackHost(CONFIG.listenHost)) {
        console.warn(
            `[security] listening on ${CONFIG.listenHost} without 'auth' configured: anyone who can reach ` +
                "this port can read your full DNS query log. Set 'auth' in config.json or bind to 127.0.0.1."
        );
    }
    for (const s of CONFIG.servers) {
        console.log(`Upstream AdGuard Home "${s.name}": ${s.baseUrl} (user: ${s.username || "<none>"})`);
    }

    // Warm caches at startup and refresh them as they expire, so browser
    // requests are served from cache (getActivity also serves stale data
    // while revalidating, so a request never waits on a scan once warm).
    const warmActivity = async () => {
        try {
            const t0 = Date.now();
            await refreshActivity();
            console.log(`[activity] cache refreshed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (err) {
            console.error("[activity] background refresh failed:", err.message);
        }
    };
    warmActivity();
    setInterval(warmActivity, CONFIG.cacheTtlSeconds * 1000).unref();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        console.log(`\n${sig} received, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}

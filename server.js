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
 *   config.js   - config.json loading + defaults
 *   util.js     - ApiError, timestamp parsing, sleep
 *   agh.js      - AdGuard Home HTTP client
 *   stats.js    - /control/stats normalization + cached getStats()
 *   activity.js - query-log bucketing + cached getActivity()
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const { loadConfig, ROOT } = require("./lib/config");
const { ApiError } = require("./lib/util");
const { createStatsService } = require("./lib/stats");
const { createActivityService } = require("./lib/activity");
const { getRequestsInRange } = require("./lib/requests");

const PUBLIC_DIR = path.join(ROOT, "public");

const CONFIG = loadConfig();
if (!Array.isArray(CONFIG.servers) || CONFIG.servers.length === 0) {
    console.error("[config] no AdGuard Home servers configured (see config.example.json)");
    process.exit(1);
}

const { getStats } = createStatsService(CONFIG);
const { getActivity } = createActivityService(CONFIG);

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
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const started = Date.now();

    // Log once the response is actually flushed, so the status code is accurate
    // even for the async static-file path.
    res.on("finish", () => {
        if (!url.pathname.startsWith("/api/health")) {
            console.log(
                `${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`
            );
        }
    });

    try {
        if (url.pathname === "/api/stats") {
            sendJson(res, 200, await getStats());
        } else if (url.pathname === "/api/activity") {
            sendJson(res, 200, await getActivity());
        } else if (url.pathname === "/api/requests") {
            const start = Number(url.searchParams.get("start"));
            const end = Number(url.searchParams.get("end"));
            const client = url.searchParams.get("client");
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                sendJson(res, 400, { error: "start and end query params (ms since epoch) are required, with end > start" });
            } else {
                sendJson(res, 200, await getRequestsInRange(CONFIG, start, end, client));
            }
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
        if (!res.headersSent) sendJson(res, status, { error: err.message || "Internal error" });
    }
});

server.on("error", (err) => {
    console.error("[server] fatal:", err.message);
    process.exit(1);
});

server.listen(CONFIG.listenPort, CONFIG.listenHost, () => {
    console.log(`AdGuard Home dashboard listening on http://${CONFIG.listenHost}:${CONFIG.listenPort}`);
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
    setInterval(warmActivity, Math.max(CONFIG.cacheTtlSeconds * 2, 120) * 1000).unref();
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        console.log(`\n${sig} received, shutting down`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    });
}

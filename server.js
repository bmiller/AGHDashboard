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
 *   app.js      - HTTP handler: security headers, auth, routing, static files
 *   config.js   - config.json loading, defaults + validation
 *   auth.js     - optional Basic auth for the dashboard itself
 *   util.js     - ApiError, timestamp parsing, sleep
 *   agh.js      - AdGuard Home HTTP client
 *   querylog.js - shared query-log pagination
 *   stats.js    - /control/stats normalization + cached getStats()
 *   activity.js - query-log bucketing + cached getActivity()
 *   requests.js - per-window request listing (validated, concurrency-limited)
 */

const http = require("http");
const path = require("path");

const { loadConfig, ConfigError, ROOT } = require("./lib/config");
const { isLoopbackHost } = require("./lib/auth");
const { createHandler } = require("./lib/app");
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

const server = http.createServer(createHandler(CONFIG, { getStats, getActivity, getRequests }, PUBLIC_DIR));

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

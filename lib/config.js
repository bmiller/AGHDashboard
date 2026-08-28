"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function hostLabel(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    } catch (_) {
        return null;
    }
}

/**
 * Accepts either a `servers: [...]` array or the legacy single `adguard: {...}`
 * block (wrapped into a one-element list). Each entry may carry its own
 * name, baseUrl, username, password and timeoutMs.
 */
function normalizeServers(user, defaults) {
    if (Array.isArray(user.servers)) {
        const servers = user.servers
            .map((s, i) => ({
                name: String(s.name || hostLabel(s.baseUrl) || `server-${i + 1}`),
                baseUrl: String(s.baseUrl || "").replace(/\/+$/, ""),
                username: s.username ?? "",
                password: s.password ?? "",
                timeoutMs: Number(s.timeoutMs) || 30000,
            }))
            .filter((s) => s.baseUrl);
        if (servers.length === 0) console.error("[config] 'servers' array contains no usable entries");
        return servers;
    }
    const a = { ...defaults.adguard, ...(user.adguard || {}) };
    return [
        {
            name: "AdGuard Home",
            baseUrl: String(a.baseUrl || "").replace(/\/+$/, ""),
            username: a.username ?? "",
            password: a.password ?? "",
            timeoutMs: Number(a.timeoutMs) || 30000,
        },
    ];
}

const DEFAULTS = {
    listenPort: 8199,
    listenHost: "0.0.0.0",
    adguard: {
        baseUrl: "http://192.168.5.30:8080",
        username: "",
        password: "",
        timeoutMs: 30000,
    },
    cacheTtlSeconds: 60,
    topCounts: { domains: 10, clients: 10, upstreams: 10 },
    activity: {
        hours: 24,
        intervalMinutes: 10,
        pageSize: 50000, // AdGuard Home caps query-log pages at 50k entries
        maxPages: 10, // safety cap on pagination (50000 * 10 entries)
        maxClients: 24,
    },
};

/** Load config.json from the project root, merged onto DEFAULTS. */
function loadConfig(rootDir = ROOT) {
    let user = {};
    const cfgPath = path.join(rootDir, "config.json");
    try {
        if (fs.existsSync(cfgPath)) {
            user = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        } else {
            console.warn("[config] config.json not found, using defaults");
        }
    } catch (err) {
        console.error("[config] failed to parse config.json:", err.message);
        process.exit(1);
    }

    const cfg = {
        listenPort: user.listenPort ?? DEFAULTS.listenPort,
        listenHost: user.listenHost ?? DEFAULTS.listenHost,
        cacheTtlSeconds: user.cacheTtlSeconds ?? DEFAULTS.cacheTtlSeconds,
        topCounts: { ...DEFAULTS.topCounts, ...(user.topCounts || {}) },
        activity: { ...DEFAULTS.activity, ...(user.activity || {}) },
        servers: [],
    };
    cfg.servers = normalizeServers(user, DEFAULTS);
    return cfg;
}

module.exports = { loadConfig, normalizeServers, hostLabel, DEFAULTS, ROOT };

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Thrown for a missing, unparseable or invalid config.json; server.js reports it and exits. */
class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "ConfigError";
    }
}

function hostLabel(baseUrl) {
    try {
        return new URL(baseUrl).hostname;
    } catch (_) {
        return null;
    }
}

function normalizeServer(s, i, fallbackName) {
    return {
        name: String(s.name || fallbackName || hostLabel(s.baseUrl) || `server-${i + 1}`),
        baseUrl: String(s.baseUrl || "").replace(/\/+$/, ""),
        username: s.username ?? "",
        password: s.password ?? "",
        timeoutMs: s.timeoutMs ?? DEFAULTS.serverTimeoutMs,
    };
}

/**
 * Accepts either a `servers: [...]` array or the legacy single `adguard: {...}`
 * block (wrapped into a one-element list). Each entry may carry its own
 * name, baseUrl, username, password and timeoutMs. Entries that are not
 * objects are kept as-is so validateConfig() can report them.
 */
function normalizeServers(user) {
    if (Array.isArray(user.servers)) {
        return user.servers.map((s, i) => (s && typeof s === "object" ? normalizeServer(s, i) : s));
    }
    if (user.adguard && typeof user.adguard === "object") {
        return [normalizeServer(user.adguard, 0, "AdGuard Home")];
    }
    return [];
}

const DEFAULTS = {
    listenPort: 8199,
    listenHost: "127.0.0.1",
    serverTimeoutMs: 30000,
    cacheTtlSeconds: 60,
    topCounts: { domains: 10, clients: 10, upstreams: 10 },
    activity: {
        hours: 24,
        intervalMinutes: 10,
        pageSize: 50000, // AdGuard Home caps query-log pages at 50k entries
        maxPages: 10, // safety cap on pagination (50000 * 10 entries)
        maxClients: 24,
    },
    requests: {
        maxRangeMinutes: 60, // widest window /api/requests will serve
        maxRows: 5000, // rows returned per /api/requests call; the rest are counted but dropped
        maxConcurrent: 2, // simultaneous /api/requests scans; extra callers get 429
    },
};

const MAX_PAGE_SIZE = 50000;

/** Return a list of human-readable problems with a loaded config (empty when valid). */
function validateConfig(cfg) {
    const errors = [];
    const isInt = (v, min, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
    const checkInt = (label, v, min, max) => {
        if (!isInt(v, min, max)) {
            const range = max === undefined || max === Infinity ? `>= ${min}` : `${min}-${max}`;
            errors.push(`${label} must be an integer ${range} (got ${JSON.stringify(v)})`);
        }
    };

    checkInt("listenPort", cfg.listenPort, 1, 65535);
    if (typeof cfg.listenHost !== "string" || cfg.listenHost === "") {
        errors.push(`listenHost must be a non-empty string (got ${JSON.stringify(cfg.listenHost)})`);
    }
    checkInt("cacheTtlSeconds", cfg.cacheTtlSeconds, 1);
    for (const k of ["domains", "clients", "upstreams"]) checkInt(`topCounts.${k}`, cfg.topCounts[k], 1);

    const a = cfg.activity;
    checkInt("activity.hours", a.hours, 1);
    checkInt("activity.intervalMinutes", a.intervalMinutes, 1);
    if (isInt(a.hours, 1) && isInt(a.intervalMinutes, 1) && (a.hours * 60) % a.intervalMinutes !== 0) {
        errors.push("activity.intervalMinutes must divide the window (activity.hours * 60) evenly");
    }
    checkInt("activity.pageSize", a.pageSize, 1, MAX_PAGE_SIZE);
    checkInt("activity.maxPages", a.maxPages, 1);
    checkInt("activity.maxClients", a.maxClients, 1);

    const r = cfg.requests;
    checkInt("requests.maxRangeMinutes", r.maxRangeMinutes, 1);
    checkInt("requests.maxRows", r.maxRows, 1);
    checkInt("requests.maxConcurrent", r.maxConcurrent, 1);

    if (cfg.auth !== null) {
        const { username, password } = cfg.auth;
        if (typeof username !== "string" || username === "" || typeof password !== "string" || password === "") {
            errors.push("auth.username and auth.password must both be non-empty strings (or omit 'auth')");
        }
    }

    if (cfg.servers.length === 0) {
        errors.push("no AdGuard Home servers configured (add a 'servers' array, see config.example.json)");
    }
    cfg.servers.forEach((s, i) => {
        const label = `servers[${i}]`;
        if (!s || typeof s !== "object") {
            errors.push(`${label} must be an object (got ${JSON.stringify(s)})`);
            return;
        }
        let url = null;
        try {
            url = new URL(s.baseUrl);
        } catch (_) { /* reported below */ }
        if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
            errors.push(`${label}.baseUrl must be an http(s) URL (got ${JSON.stringify(s.baseUrl)})`);
        }
        if (typeof s.username !== "string" || typeof s.password !== "string") {
            errors.push(`${label}.username and .password must be strings`);
        }
        checkInt(`${label}.timeoutMs`, s.timeoutMs, 1);
    });

    return errors;
}

/** Merge a parsed config.json onto DEFAULTS and validate it. Throws ConfigError. */
function buildConfig(user) {
    if (!user || typeof user !== "object" || Array.isArray(user)) {
        throw new ConfigError("config.json must contain a JSON object");
    }
    const cfg = {
        listenPort: user.listenPort ?? DEFAULTS.listenPort,
        listenHost: user.listenHost ?? DEFAULTS.listenHost,
        cacheTtlSeconds: user.cacheTtlSeconds ?? DEFAULTS.cacheTtlSeconds,
        topCounts: { ...DEFAULTS.topCounts, ...(user.topCounts || {}) },
        activity: { ...DEFAULTS.activity, ...(user.activity || {}) },
        requests: { ...DEFAULTS.requests, ...(user.requests || {}) },
        auth: user.auth ? { username: user.auth.username, password: user.auth.password } : null,
        servers: normalizeServers(user),
    };
    const errors = validateConfig(cfg);
    if (errors.length > 0) {
        throw new ConfigError(`invalid config.json:\n  - ${errors.join("\n  - ")}`);
    }
    return cfg;
}

/** Load and validate config.json from the project root. Throws ConfigError. */
function loadConfig(rootDir = ROOT) {
    const cfgPath = path.join(rootDir, "config.json");
    let text;
    try {
        text = fs.readFileSync(cfgPath, "utf8");
    } catch (err) {
        if (err.code === "ENOENT") {
            throw new ConfigError(`${cfgPath} not found; copy config.example.json to config.json and edit it`);
        }
        throw new ConfigError(`cannot read ${cfgPath}: ${err.message}`);
    }
    let user;
    try {
        user = JSON.parse(text);
    } catch (err) {
        throw new ConfigError(`failed to parse config.json: ${err.message}`);
    }
    return buildConfig(user);
}

module.exports = {
    loadConfig,
    buildConfig,
    validateConfig,
    normalizeServers,
    hostLabel,
    ConfigError,
    DEFAULTS,
    ROOT,
};

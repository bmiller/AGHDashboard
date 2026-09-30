"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildConfig, loadConfig, ConfigError, DEFAULTS } = require("../lib/config");

const SERVER = { name: "a", baseUrl: "http://10.0.0.1:8080/" };

test("buildConfig: applies defaults and strips trailing slashes", () => {
    const cfg = buildConfig({ servers: [SERVER] });
    assert.equal(cfg.listenHost, "127.0.0.1");
    assert.equal(cfg.auth, null);
    assert.deepEqual(cfg.activity, DEFAULTS.activity);
    assert.deepEqual(cfg.requests, DEFAULTS.requests);
    assert.equal(cfg.servers[0].baseUrl, "http://10.0.0.1:8080");
    assert.equal(cfg.servers[0].timeoutMs, 30000);
});

test("buildConfig: legacy adguard block becomes a single server", () => {
    const cfg = buildConfig({ adguard: { baseUrl: "http://10.0.0.1" } });
    assert.equal(cfg.servers.length, 1);
    assert.equal(cfg.servers[0].name, "AdGuard Home");
});

test("buildConfig: no servers is an error (no hardcoded fallback)", () => {
    assert.throws(() => buildConfig({}), (err) => err instanceof ConfigError && /no AdGuard Home servers/.test(err.message));
});

test("buildConfig: intervalMinutes 0 is rejected", () => {
    assert.throws(() => buildConfig({ servers: [SERVER], activity: { intervalMinutes: 0 } }), /activity.intervalMinutes/);
});

test("buildConfig: intervalMinutes must divide the window", () => {
    assert.throws(() => buildConfig({ servers: [SERVER], activity: { intervalMinutes: 7 } }), /divide the window/);
});

test("buildConfig: null server entry is reported, not a crash", () => {
    assert.throws(() => buildConfig({ servers: [null] }), /servers\[0\] must be an object/);
});

test("buildConfig: non-http baseUrl is rejected", () => {
    assert.throws(() => buildConfig({ servers: [{ baseUrl: "ftp://x" }] }), /servers\[0\].baseUrl/);
});

test("buildConfig: string numbers and oversize pageSize are rejected", () => {
    assert.throws(() => buildConfig({ servers: [SERVER], listenPort: "8199" }), /listenPort/);
    assert.throws(() => buildConfig({ servers: [SERVER], activity: { pageSize: 100000 } }), /activity.pageSize/);
});

test("buildConfig: reports every problem at once", () => {
    try {
        buildConfig({ servers: [SERVER], cacheTtlSeconds: -1, topCounts: { domains: 0 } });
        assert.fail("expected ConfigError");
    } catch (err) {
        assert.match(err.message, /cacheTtlSeconds/);
        assert.match(err.message, /topCounts.domains/);
    }
});

test("buildConfig: auth requires both username and password", () => {
    assert.throws(() => buildConfig({ servers: [SERVER], auth: { username: "u" } }), /auth.username/);
    const cfg = buildConfig({ servers: [SERVER], auth: { username: "u", password: "p" } });
    assert.deepEqual(cfg.auth, { username: "u", password: "p" });
});

test("loadConfig: missing config.json throws ConfigError", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agh-dash-"));
    try {
        assert.throws(() => loadConfig(dir), (err) => err instanceof ConfigError && /not found/.test(err.message));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("loadConfig: invalid JSON throws ConfigError", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agh-dash-"));
    try {
        fs.writeFileSync(path.join(dir, "config.json"), "{ nope");
        assert.throws(() => loadConfig(dir), (err) => err instanceof ConfigError && /parse/.test(err.message));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

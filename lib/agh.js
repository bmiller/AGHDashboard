"use strict";

const { ApiError } = require("./util");

/* Thin AdGuard Home HTTP client: Basic auth, per-server timeout, JSON parsing. */

async function aghFetch(server, apiPath) {
    const headers = { Accept: "application/json" };
    if (server.username || server.password) {
        const auth = Buffer.from(`${server.username}:${server.password}`).toString("base64");
        headers.Authorization = `Basic ${auth}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), server.timeoutMs);
    try {
        return await fetch(server.baseUrl + apiPath, { headers, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function aghJson(server, apiPath) {
    let res;
    try {
        res = await aghFetch(server, apiPath);
    } catch (err) {
        throw new ApiError(502, `Cannot reach ${server.name} at ${server.baseUrl}: ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, `${server.name} rejected credentials (check username/password in config.json)`);
    }
    if (!res.ok) {
        throw new ApiError(502, `${server.name} returned HTTP ${res.status} for ${apiPath}`);
    }
    try {
        return await res.json();
    } catch (err) {
        throw new ApiError(502, `Invalid JSON from ${server.name} for ${apiPath}`);
    }
}

module.exports = { aghFetch, aghJson };

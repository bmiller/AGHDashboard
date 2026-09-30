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

/*
 * Errors thrown here end up in browser-visible responses (error banners,
 * per-server status), so their messages name the server but never its URL or
 * low-level network errors; those details are logged here instead.
 */
async function aghJson(server, apiPath) {
    let res;
    try {
        res = await aghFetch(server, apiPath);
    } catch (err) {
        const reason = err.name === "AbortError" ? `timed out after ${server.timeoutMs} ms` : err.message;
        console.warn(`[agh] ${server.name}: cannot reach ${server.baseUrl}${apiPath}: ${reason}`);
        throw new ApiError(502, `Cannot reach ${server.name}${err.name === "AbortError" ? " (timed out)" : ""}`);
    }
    if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, `${server.name} rejected credentials (check username/password in config.json)`);
    }
    if (!res.ok) {
        console.warn(`[agh] ${server.name}: HTTP ${res.status} for ${apiPath}`);
        throw new ApiError(502, `${server.name} returned HTTP ${res.status}`);
    }
    try {
        return await res.json();
    } catch (err) {
        console.warn(`[agh] ${server.name}: invalid JSON for ${apiPath}: ${err.message}`);
        throw new ApiError(502, `Invalid response from ${server.name}`);
    }
}

module.exports = { aghFetch, aghJson };

/* Helpers shared by the dashboard (app.js) and request detail page (requests.js).
 * Loaded first as a classic script, so these are globals for the page scripts. */

"use strict";

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

/** GET a JSON endpoint; non-2xx responses throw with the server's `error` message when present. */
async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
            const body = await res.json();
            if (body && body.error) msg = body.error;
        } catch (_) { /* ignore */ }
        throw new Error(msg);
    }
    return res.json();
}

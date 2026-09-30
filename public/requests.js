/* AdGuard Home Dashboard - request detail page
 *
 * Reached by clicking a bucket bar on the "Total queries" or "Client activity"
 * chart. Lists the individual query-log entries for that time window (and,
 * when opened from the client chart, for that one client).
 */

"use strict";

// $, escapeHtml, pad2 and fetchJson come from common.js.

const STATUS_LABEL = {
    permitted: "Permitted",
    blocked: "Blocked",
    cached: "Cached",
    other: "Other",
};

function fmtTime(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function fmtRange(startMs, endMs) {
    const s = new Date(startMs);
    const e = new Date(endMs);
    const from = `${pad2(s.getHours())}:${pad2(s.getMinutes())}`;
    const to = `${pad2(e.getHours())}:${pad2(e.getMinutes())}`;
    return `${s.toLocaleDateString()}, ${from}&ndash;${to}`;
}

function showError(msg) {
    const el = $("error-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
}

// Caveats about the loaded window (truncation, missing servers), kept so they
// survive re-rendering the subtitle when the client filter changes.
let windowNotes = [];

function readParams() {
    const p = new URLSearchParams(location.search);
    const start = Number(p.get("start"));
    const end = Number(p.get("end"));
    const client = p.get("client");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return { start, end, client };
}

/** Build the client dropdown from the distinct clients seen in `rows`, selecting `selected` if it's still present. */
function renderClientFilter(rows, selected) {
    const el = $("requests-filters");
    const clients = [...new Set(rows.map((r) => r.client))].sort((a, b) => a.localeCompare(b));

    const select = document.createElement("select");
    select.id = "client-select";
    select.className = "client-select";
    select.innerHTML =
        `<option value="">All clients</option>` +
        clients.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    select.value = selected && clients.includes(selected) ? selected : "";

    select.addEventListener("change", () => applyClientFilter(rows, select.value));

    el.innerHTML = "";
    const label = document.createElement("label");
    label.className = "filter-label";
    label.textContent = "Client: ";
    label.appendChild(select);
    el.appendChild(label);

    return select;
}

/** Filter the in-memory rows to `client` (or all, if empty), re-render, and reflect the choice in the URL. */
function applyClientFilter(allRows, client) {
    const filtered = client ? allRows.filter((r) => r.client === client) : allRows;
    renderTable(filtered);

    const params = readParams();
    $("requests-title").textContent = client ? `Requests — ${client}` : "Requests";
    $("requests-sub").innerHTML =
        `${fmtRange(params.start, params.end)} &middot; ${filtered.length} request${filtered.length === 1 ? "" : "s"}` +
        windowNotes.map((n) => ` &middot; ${escapeHtml(n)}`).join("");

    const url = new URL(location.href);
    if (client) url.searchParams.set("client", client);
    else url.searchParams.delete("client");
    history.replaceState(null, "", url);
}

function renderTable(rows) {
    const tbody = $("requests-tbody");
    if (rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-note">No requests recorded in this window</td></tr>';
        return;
    }
    tbody.innerHTML = rows
        .map(
            (r) =>
                `<tr>` +
                `<td class="col-time">${fmtTime(r.timeMs)}</td>` +
                `<td class="col-domain" title="${escapeHtml(r.domain)}">${escapeHtml(r.domain)}</td>` +
                `<td class="col-type">${escapeHtml(r.queryType || "–")}</td>` +
                `<td class="col-client">${escapeHtml(r.client)}</td>` +
                `<td class="col-status"><span class="status-pill status-${escapeHtml(r.status)}">${escapeHtml(STATUS_LABEL[r.status] || r.status)}</span></td>` +
                `<td class="col-upstream" title="${escapeHtml(r.upstream)}">${escapeHtml(r.upstream || "–")}</td>` +
                `<td class="col-elapsed">${r.elapsedMs == null ? "–" : escapeHtml(r.elapsedMs)}</td>` +
                `<td class="col-rule" title="${escapeHtml(r.rule)}">${r.rule ? escapeHtml(r.rule) : "–"}</td>` +
                `</tr>`
        )
        .join("");
}

async function load() {
    const params = readParams();
    if (!params) {
        showError("Missing or invalid start/end parameters.");
        $("requests-overlay").classList.add("hidden");
        return;
    }

    $("requests-title").textContent = params.client ? `Requests — ${params.client}` : "Requests";
    $("requests-sub").innerHTML = fmtRange(params.start, params.end);
    document.title = `Requests – AdGuard Home Dashboard`;

    try {
        // Fetch the whole window unfiltered so the client dropdown can switch
        // between clients instantly, without a round trip per selection.
        const qs = new URLSearchParams({ start: String(params.start), end: String(params.end) });
        const data = await fetchJson(`/api/requests?${qs.toString()}`);
        const allRows = data.requests || [];
        const effectiveClient = params.client && allRows.some((r) => r.client === params.client) ? params.client : "";

        const notes = [];
        if (data.truncated) {
            notes.push(`showing the first ${data.count.toLocaleString()} of ${data.totalCount.toLocaleString()} requests`);
        }
        const servers = (data.meta && data.meta.servers) || [];
        const down = servers.filter((s) => !s.ok).map((s) => s.name);
        if (down.length > 0) {
            notes.push(`unavailable: ${down.join(", ")}`);
        } else if (data.meta && !data.meta.complete) {
            // Every server answered, but paging hit activity.maxPages before
            // reaching the start of this window.
            notes.push("older part of this window may be missing (query-log paging limit reached)");
        }
        windowNotes = notes;

        renderClientFilter(allRows, effectiveClient);
        applyClientFilter(allRows, effectiveClient);
    } catch (err) {
        showError(`Failed to load requests: ${err.message}`);
    } finally {
        $("requests-overlay").classList.add("hidden");
    }
}

load();

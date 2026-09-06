/* AdGuard Home Dashboard - frontend
 *
 * Charts are modeled after the Pi-hole web UI (pi-hole/web, scripts/js/index.js):
 * stacked bar charts for "Total queries" and "Client activity", custom HTML tooltips,
 * Pi-hole palette, hidden legends.
 */

"use strict";

/* ---------------- Constants (Pi-hole theme) ---------------- */

// One distinct color per client dataset. The first entries keep the Pi-hole
// palette; the rest fill it out so every possible dataset (up to
// activity.maxClients + the "Other clients" row) has its own fixed color.
// Anything beyond the list falls back to a deterministic hue (never random),
// so colors stay stable across refreshes.
const THEME_COLORS = [
    "#f56954", "#3c8dbc", "#00a65a", "#00c0ef", "#f39c12", "#0073b7",
    "#5b8def", "#39cccc", "#3d9970", "#01ff70", "#ff851b", "#f012be",
    "#8e24aa", "#d81b60", "#7cb342", "#c0703b", "#5c6bc0", "#26a69a",
    "#ec407a", "#ab47bc", "#ffa726", "#66bb6a", "#29b6f6", "#8d6e63",
    "#bdbd3a", "#546e7a", "#d4a017", "#5d4037", "#00897b", "#c2185b",
];

// Deterministic fallback color for dataset index `i` (golden-angle hue rotation).
function clientColor(i) {
    if (i < THEME_COLORS.length) return THEME_COLORS[i];
    const hue = ((i - THEME_COLORS.length) * 137.508) % 360;
    return `hsl(${hue.toFixed(1)}, 60%, 55%)`;
}

const SEGMENTS = [
    { key: "permitted", label: "Permitted" },
    { key: "blocked", label: "Blocked" },
    { key: "cached", label: "Cached" },
    { key: "other", label: "Other" },
];

// Segment colors live in style.css (`--seg-*` variables), so restyling is a pure CSS edit.
function segColor(key) {
    return cssVar(`--seg-${key}`);
}

const STATS_REFRESH_MS = 10000;
const ACTIVITY_REFRESH_MS = 60000;

/* ---------------- Small utilities ---------------- */

const $ = (id) => document.getElementById(id);

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fmtInt(n) {
    return Number(n).toLocaleString("en-US");
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

function hhmm(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 5) return "just now";
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
}

let lastStatsAt = null;
let liveSuffix = "";

function updateServerStatus(stats) {
    const servers = Array.isArray(stats && stats.servers) ? stats.servers : [];
    const down = servers.filter((s) => !s.ok);
    const pill = $("status-pill");
    if (servers.length > 1 && down.length > 0) {
        liveSuffix = ` · ${servers.length - down.length}/${servers.length} servers`;
        pill.title = "Unreachable: " + down.map((s) => s.name).join(", ");
    } else {
        liveSuffix = "";
        pill.removeAttribute("title");
    }
}

function setStatus(state, text) {
    const pill = $("status-pill");
    pill.classList.remove("ok", "err");
    pill.classList.add(state);
    $("status-text").textContent = text;
}

function showError(msg) {
    const el = $("error-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
    setStatus("err", "Error");
}

function clearError() {
    $("error-banner").classList.add("hidden");
}

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

/* ---------------- Custom tooltip (Pi-hole style) ---------------- */

function getOrCreateTooltipEl(chartId) {
    let el = document.getElementById(`${chartId}-customTooltip`);
    if (el) return el;
    el = document.createElement("div");
    el.id = `${chartId}-customTooltip`;
    el.className = "chartjs-tooltip";
    el.innerHTML = "<table></table>";
    document.body.appendChild(el);
    return el;
}

function makeExternalTooltip(chartId, titleFn) {
    return function external(context) {
        const chart = context.chart;
        const tooltip = chart.tooltip;
        const el = getOrCreateTooltipEl(chartId);

        if (tooltip.opacity === 0 || !tooltip.dataPoints || tooltip.dataPoints.length === 0) {
            el.style.opacity = 0;
            return;
        }

        // Title, e.g. "Queries from 17:40 to 17:49"
        const idx = tooltip.dataPoints[0].dataIndex;
        const title = titleFn(idx);

        let html = `<thead><tr><th>${escapeHtml(title)}</th></tr></thead><tbody>`;
        const rows = [...tooltip.dataPoints].sort((a, b) => b.raw - a.raw).filter((p) => p.raw > 0);
        const total = rows.reduce((acc, p) => acc + p.raw, 0);
        for (const p of rows) {
            const color =
                typeof p.dataset.backgroundColor === "function"
                    ? p.dataset.backgroundColor({})
                    : p.dataset.backgroundColor;
            const pct = total > 0 ? ((100 * p.raw) / total).toFixed(1) : "0.0";
            html +=
                `<tr><td><span class="chartjs-tooltip-key" style="background-color:${color};outline:1px solid ${color};border:1px solid #fff"></span>` +
                `${escapeHtml(p.dataset.label)}: ${fmtInt(p.raw)} (${pct}%)</td></tr>`;
        }
        if (rows.length === 0) html += '<tr class="muted-row"><td>No activity recorded</td></tr>';
        html += "</tbody>";
        el.querySelector("table").innerHTML = html;

        el.style.opacity = 1;

        // Position along the bottom edge of the chart, clamped within the canvas
        // (page coordinates, so it survives scrolling).
        const canvasRect = chart.canvas.getBoundingClientRect();
        const sx = window.scrollX;
        const sy = window.scrollY;
        const caretX = canvasRect.left + sx + tooltip.caretX;
        const width = el.offsetWidth;

        let left = caretX - width / 2;
        const minLeft = canvasRect.left + sx + 4;
        const maxLeft = canvasRect.right + sx - width - 4;
        left = Math.max(minLeft, Math.min(left, maxLeft));

        el.style.left = `${left}px`;
        el.style.top = `${canvasRect.bottom + sy - 20}px`;
    };
}

/* ---------------- Charts (Pi-hole clone) ---------------- */

let activityData = null;

function hourGridColor(ctx) {
    return ctx.tick && ctx.tick.label ? cssVar("--grid-line") : "transparent";
}

function commonScales() {
    return {
        x: {
            stacked: true,
            offset: false,
            grid: { color: hourGridColor },
            border: { display: false },
            ticks: {
                autoSkip: false,
                maxRotation: 0,
                minRotation: 0,
                color: () => cssVar("--tick"),
                font: { size: 11 },
            },
        },
        y: {
            stacked: true,
            beginAtZero: true,
            min: 0,
            grid: { color: () => cssVar("--grid-line") },
            border: { display: false },
            ticks: { precision: 0, color: () => cssVar("--tick"), font: { size: 11 } },
        },
    };
}

// Show a tick label only on full hours (like Pi-hole's hourly unit).
function buildLabels(bucketStartsMs) {
    return bucketStartsMs.map((ms) => {
        const d = new Date(ms);
        return d.getMinutes() === 0 ? hhmm(ms) : "";
    });
}

function rangeTitle(kind) {
    return (idx) => {
        if (!activityData) return kind;
        const start = activityData.bucketStartsMs[idx];
        const end = start + activityData.bucketMinutes * 60000 - 60000;
        return `${kind} from ${hhmm(start)} to ${hhmm(end)}`;
    };
}

function baseOptions(chartId, kind) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
            legend: { display: false },
            tooltip: {
                enabled: false,
                intersect: false,
                yAlign: "bottom",
                external: makeExternalTooltip(chartId, rangeTitle(kind)),
            },
        },
        scales: commonScales(),
        elements: {
            point: { radius: 0, hitRadius: 5, hoverRadius: 5 },
            bar: { borderWidth: 0 },
        },
    };
}

const totalQueriesChart = new Chart($("totalQueriesChart").getContext("2d"), {
    type: "bar",
    data: { labels: [], datasets: SEGMENTS.map(() => ({ data: [] })) },
    options: baseOptions("totalQueries", "Queries"),
});

const clientsChart = new Chart($("clientsChart").getContext("2d"), {
    type: "bar",
    data: { labels: [], datasets: [] },
    options: baseOptions("clientsChart", "Client activity"),
});

function updateCharts(data, firstLoad) {
    activityData = data;
    const labels = buildLabels(data.bucketStartsMs);
    const anim = firstLoad ? 400 : 0;

    totalQueriesChart.options.animation.duration = anim;
    totalQueriesChart.data.labels = labels;
    SEGMENTS.forEach((seg, i) => {
        const ds = totalQueriesChart.data.datasets[i];
        ds.label = seg.label;
        ds.backgroundColor = segColor(seg.key);
        ds.data = data.series[seg.key];
    });

    clientsChart.options.animation.duration = anim;
    clientsChart.data.labels = labels;
    clientsChart.data.datasets = data.clients.names.map((name, i) => ({
        label: name,
        data: data.clients.rows[i],
        backgroundColor: clientColor(i),
    }));

    totalQueriesChart.update();
    clientsChart.update();

    $("overlay-totalQueries").classList.add("hidden");
    $("overlay-clients").classList.add("hidden");
}

/* ---------------- Stats rendering ---------------- */

function pctOfTotal(total, n) {
    return total > 0 ? `${((100 * n) / total).toFixed(1)}% of all queries` : "n/a";
}

function renderTopList(listId, items, barColor) {
    const ol = $(listId);
    if (!items || items.length === 0) {
        ol.innerHTML = '<li class="empty-note">No data</li>';
        return;
    }
    const max = items[0].count || 1;
    const sum = items.reduce((a, b) => a + b.count, 0);
    ol.innerHTML = items
        .map((it) => {
            const width = Math.max(2, Math.round((100 * it.count) / max));
            const share = sum > 0 ? ((100 * it.count) / sum).toFixed(1) : "0.0";
            return (
                `<li title="${escapeHtml(it.name)}">` +
                `<div class="row-main"><span class="row-name">${escapeHtml(it.name)}</span>` +
                `<span class="row-count">${fmtInt(it.count)} &middot; ${share}%</span></div>` +
                `<div class="row-bar"><span style="width:${width}%;--bar-color:${barColor}"></span></div></li>`
            );
        })
        .join("");
}

function renderStats(stats) {
    updateServerStatus(stats);
    const t = stats.totals;
    $("stat-queries").textContent = fmtInt(t.queries);
    $("stat-queries-sub").textContent =
        t.queries > 0 ? `~${Math.max(1, Math.round(t.queries / (24 * 60)))}/min over 24h` : "";
    $("stat-blocked").textContent = fmtInt(t.blocked);
    $("stat-blocked-sub").textContent = pctOfTotal(t.queries, t.blocked);
    $("stat-malware").textContent = fmtInt(t.safebrowsing);
    $("stat-malware-sub").textContent = pctOfTotal(t.queries, t.safebrowsing);
    $("stat-adult").textContent = fmtInt(t.parental);
    $("stat-adult-sub").textContent = pctOfTotal(t.queries, t.parental);

    $("avg-processing").textContent = `Average processing time: ${t.avgProcessingTimeMs} ms`;

    renderTopList("list-top-domains", stats.topQueried, segColor("cached"));
    renderTopList("list-top-blocked", stats.topBlocked, segColor("blocked"));
    renderTopList("list-top-clients", stats.topClients, segColor("permitted"));
    renderTopList("list-upstreams", stats.topUpstreams, "#4a7fb5");

    const avgTimes = stats.upstreamAvgTimesMs || {};
    const rtNames = Object.keys(avgTimes)
        .filter((name) => stats.topUpstreams.some((u) => u.name === name))
        .sort((a, b) => avgTimes[b] - avgTimes[a]);
    const rtEl = $("upstream-response-times");
    if (rtNames.length === 0) {
        rtEl.innerHTML = "&nbsp;";
    } else {
        // Fixed-width name column (in ch units, monospace font) so times line up.
        const nameCh = Math.max(...rtNames.map((n) => n.length)) + 2;
        rtEl.innerHTML = rtNames
            .map(
                (name) =>
                    `<div class="rt-line" style="--rt-name-ch:${nameCh}ch">` +
                    `<span class="rt-name">${escapeHtml(name)}:</span>` +
                    `<span>${avgTimes[name]} ms</span></div>`
            )
            .join("");
    }

    lastStatsAt = stats.generatedAt;
}

/* ---------------- Data loading ---------------- */

async function loadStats(firstLoad = false) {
    try {
        const stats = await fetchJson("/api/stats");
        renderStats(stats);
        clearError();
        if (firstLoad) setStatus("ok", `Live${liveSuffix}`);
    } catch (err) {
        showError(`Failed to load stats: ${err.message}`);
    }
}

async function loadActivity(firstLoad = false) {
    try {
        const data = await fetchJson("/api/activity");
        updateCharts(data, firstLoad);
    } catch (err) {
        showError(`Failed to load query-log activity: ${err.message}`);
    }
}

/* ---------------- Theme toggle ---------------- */

function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function setTheme(theme, { persist = false } = {}) {
    document.documentElement.dataset.theme = theme;
    if (persist) {
        try {
            localStorage.setItem("agh-dash-theme", theme);
        } catch (_) { /* ignore */ }
    }
    // Re-render charts so tick/grid colors pick up the new CSS variables.
    if (typeof totalQueriesChart !== "undefined" && typeof clientsChart !== "undefined") {
        totalQueriesChart.update("none");
        clientsChart.update("none");
    }
}

$("theme-toggle").addEventListener("click", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark", { persist: true });
});

// Follow system theme changes as long as the user has not chosen explicitly.
const colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
colorSchemeMedia.addEventListener("change", (e) => {
    let stored = null;
    try {
        stored = localStorage.getItem("agh-dash-theme");
    } catch (_) { /* ignore */ }
    if (stored !== "light" && stored !== "dark") {
        setTheme(e.matches ? "dark" : "light");
    }
});

/* ---------------- Boot & refresh timers ---------------- */

loadStats(true);
loadActivity(true);
setInterval(loadStats, STATS_REFRESH_MS);
setInterval(loadActivity, ACTIVITY_REFRESH_MS);

setInterval(() => {
    if ($("status-pill").classList.contains("ok")) {
        $("status-text").textContent = `Live${liveSuffix} · updated ${timeAgo(lastStatsAt)}`;
    }
}, 1000);

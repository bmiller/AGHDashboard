# AdGuard Home Dashboard

A standalone dashboard for [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome) that keeps the
familiar layout of the built-in dashboard, but replaces the top statistics graph with two Pi-hole
style bar charts backed by AdGuard Home query-log data:

- **Total queries** - stacked bars (Permitted / Blocked / Cached / Other) for the last 24 hours in
  10-minute increments (144 buckets), using the Pi-hole color scheme.
- **Client activity** - stacked per-client bars for the same window, colored with the Pi-hole
  client palette.

Below the charts: DNS Queries, Blocked by Filters, Blocked Malware/Phishing and Blocked Adult
Websites stat cards (mirroring the built-in dashboard), plus Top Queried Domains, Top Blocked
Domains, Top Clients and Upstream Servers tables.

A light/dark toggle lives in the top-right corner. The dark palette uses the exact colors of the
AdGuard Home UI's dark theme (`#131313` background, `#1c1c1c` cards, `#3d3d3d` borders,
`#e6e6e6` text). The choice persists in `localStorage`; with no stored choice the dashboard
follows the system `prefers-color-scheme`. `/#light` and `/#dark` URLs force a theme for one
page load.

## How it works

- `server.js` - a zero-dependency Node.js (>= 18) server that:
  - talks to one or more AdGuard Home instances configured in `config.json` (`servers` array)
  - serves the static frontend from `public/`
  - proxies `/api/stats` to AdGuard Home `/control/stats` (handles both legacy and current
    response formats)
  - aggregates `/control/querylog` into 10-minute buckets server-side (pagination via
    `older_than`), classifying each entry as permitted / blocked / cached / other and tallying
    per-client counts
  - caches both endpoints (`cacheTtlSeconds`) and pre-warms the aggregation at startup so browser
    requests are served instantly
- `public/` - single-page frontend using a locally vendored Chart.js 4.5.1 (the same version
  Pi-hole uses). Chart layout, tooltips and colors are modeled on the Pi-hole web UI
  (`pi-hole/web` `scripts/js/index.js` and `scripts/js/charts.js`).

## Configuration

Copy `config.example.json` to `config.json` and adjust:

```json
{
    "listenPort": 8199,
    "cacheTtlSeconds": 60,
    "topCounts": { "domains": 10, "clients": 10, "upstreams": 10 },
    "servers": [
        {
            "name": "adguard-1",
            "baseUrl": "http://192.168.5.30:8080",
            "username": "your-user",
            "password": "your-password"
        }
    ],
    "activity": {
        "hours": 24,            // window size
        "intervalMinutes": 10,  // bucket size
        "pageSize": 50000,      // AdGuard caps query log pages at 50k entries
        "maxPages": 10,         // safety cap for pagination (50000 * 10 entries)
        "maxClients": 24        // individual client datasets; the rest merge into "Other clients"
    }
}
```

`config.json` is gitignored; credentials never leave the server (the browser only talks to this
proxy).

### Multiple AdGuard Home servers

Add more entries to the `servers` array and everything is aggregated into one combined view:

- **Stat cards** - query/block counts are summed across servers.
- **Top tables** - lists are merged, re-ranked by combined count and truncated to `topCounts`.
- **Average processing time** - weighted by each server's query volume.
- **Charts** - each server's query log is paginated concurrently and tallied into one shared set
  of buckets. Clients appearing on several servers are combined under the same label.

If a server is unreachable the dashboard keeps working with the remaining ones: the status pill
shows e.g. `Live · 1/2 servers` (hover for names) and `/api/stats`, `/api/activity` include
per-server `servers` status arrays. Only when *all* servers fail does the dashboard show an
error.

Note: if one instance forwards its queries to another (chained setup), those queries appear in
both logs and will be double-counted. The aggregation assumes independent instances.

The legacy single-server format (`"adguard": { ... }`) is still accepted for compatibility.

## Run

```sh
npm start          # or: node server.js
```

Then open http://localhost:8199/

## Notes

- The first aggregation after startup takes a few seconds (it pages through ~90k query-log
  entries on a busy network); afterwards it is cached and refreshed in the background.
- Stats refresh every 5 s, charts every 60 s.
- AdGuard Home's own 24 h statistics are used for the stat cards and top tables, so those numbers
  match the built-in dashboard exactly. The bar charts are computed independently from the query
  log, so they may differ from AdGuard's hourly stats by well under 1% due to differing window
  boundaries.

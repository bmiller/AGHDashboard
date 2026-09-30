"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const { createHandler, SECURITY_HEADERS } = require("../lib/app");
const { ApiError } = require("../lib/util");

// A temp site root with a public/ dir and a secret file beside it.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agh-dash-app-"));
const publicDir = path.join(root, "public");
fs.mkdirSync(path.join(publicDir, "sub"), { recursive: true });
fs.writeFileSync(path.join(publicDir, "index.html"), "<h1>hi</h1>");
fs.writeFileSync(path.join(root, "config.json"), "SECRET");

const services = {
    getStats: async () => ({ ok: "stats" }),
    getActivity: async () => {
        throw new TypeError("boom at /secret/path");
    },
    getRequests: async (start, end) => {
        if (!(end > start)) throw new ApiError(400, "bad window");
        return { start, end };
    },
};

let server;
let base;

test.before(async () => {
    console.log = () => {}; // silence access logs
    server = http.createServer(createHandler({ auth: { username: "u", password: "p" } }, services, publicDir));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
});

const AUTH = { Authorization: `Basic ${Buffer.from("u:p").toString("base64")}` };

/** Send a raw request line so paths aren't normalized by the client. */
function raw(requestText) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(server.address().port, "127.0.0.1", () => sock.end(requestText));
        let buf = "";
        sock.on("data", (d) => (buf += d));
        sock.on("end", () => resolve(buf));
        sock.on("error", reject);
    });
}

test("security headers are on every response", async () => {
    for (const url of ["/api/health", "/", "/api/stats"]) {
        const res = await fetch(base + url);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
            assert.equal(res.headers.get(name), value, `${name} on ${url}`);
        }
    }
});

test("health is open and minimal", async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()).sort(), ["ok", "uptimeSec"]);
});

test("auth is required elsewhere", async () => {
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /^Basic /);
    const ok = await fetch(`${base}/api/stats`, { headers: AUTH });
    assert.deepEqual(await ok.json(), { ok: "stats" });
});

test("non-GET/HEAD methods get 405", async () => {
    const res = await fetch(`${base}/api/stats`, { method: "POST", headers: AUTH });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
});

test("malformed Host header does not crash the server", async () => {
    const reply = await raw("GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
    assert.match(reply, /^HTTP\/1\.1 401/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("path traversal is refused", async () => {
    const encoded = await raw("GET /..%2fconfig.json HTTP/1.1\r\nHost: x\r\nAuthorization: " + AUTH.Authorization + "\r\nConnection: close\r\n\r\n");
    assert.match(encoded, /^HTTP\/1\.1 403/);
    assert.doesNotMatch(encoded, /SECRET/);
    const plain = await raw("GET /../config.json HTTP/1.1\r\nHost: x\r\nAuthorization: " + AUTH.Authorization + "\r\nConnection: close\r\n\r\n");
    assert.doesNotMatch(plain, /SECRET/);
});

test("static files, directories, bad encodings and unknown routes", async () => {
    const page = await fetch(`${base}/`, { headers: AUTH });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(await page.text(), "<h1>hi</h1>");
    assert.equal((await fetch(`${base}/sub`, { headers: AUTH })).status, 404);
    assert.equal((await fetch(`${base}/%E0%A4%A`, { headers: AUTH })).status, 400);
    assert.equal((await fetch(`${base}/api/nope`, { headers: AUTH })).status, 404);
});

test("ApiError status and message pass through", async () => {
    const res = await fetch(`${base}/api/requests?start=5&end=1`, { headers: AUTH });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad window" });
    const ok = await fetch(`${base}/api/requests?start=1&end=5`, { headers: AUTH });
    assert.deepEqual(await ok.json(), { start: 1, end: 5 });
});

test("unexpected errors are a generic 500", async (t) => {
    t.mock.method(console, "error", () => {});
    const res = await fetch(`${base}/api/activity`, { headers: AUTH });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal error" });
});

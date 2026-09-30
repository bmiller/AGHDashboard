"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const { aghJson } = require("../lib/agh");

function listen(handler) {
    return new Promise((resolve) => {
        const srv = http.createServer(handler).listen(0, "127.0.0.1", () => resolve(srv));
    });
}

test("aghJson: unreachable server error names the server but not its URL", async (t) => {
    t.mock.method(console, "warn", () => {});
    // Grab a free port, then close it so the connection is refused.
    const srv = await listen(() => {});
    const port = srv.address().port;
    await new Promise((r) => srv.close(r));

    const server = { name: "adguard-1", baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 };
    await assert.rejects(aghJson(server, "/control/stats"), (err) => {
        assert.equal(err.status, 502);
        assert.match(err.message, /adguard-1/);
        assert.doesNotMatch(err.message, /127\.0\.0\.1|ECONNREFUSED|\/control/);
        return true;
    });
    assert.match(console.warn.mock.calls[0].arguments[0], /127\.0\.0\.1/); // details go to the log
});

test("aghJson: HTTP and JSON errors don't leak paths", async (t) => {
    t.mock.method(console, "warn", () => {});
    let reply = (res) => res.writeHead(500).end();
    const srv = await listen((_req, res) => reply(res));
    t.after(() => srv.close());
    const server = { name: "adguard-1", baseUrl: `http://127.0.0.1:${srv.address().port}`, timeoutMs: 2000 };

    await assert.rejects(aghJson(server, "/control/stats"), { message: "adguard-1 returned HTTP 500" });
    reply = (res) => res.writeHead(200).end("not json");
    await assert.rejects(aghJson(server, "/control/stats"), { message: "Invalid response from adguard-1" });
    reply = (res) => res.writeHead(401).end();
    await assert.rejects(aghJson(server, "/control/stats"), /rejected credentials/);
});

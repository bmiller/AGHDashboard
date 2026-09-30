"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { checkBasicAuth, isLoopbackHost } = require("../lib/auth");

const AUTH = { username: "admin", password: "p:ss" };
const basic = (s) => `Basic ${Buffer.from(s).toString("base64")}`;

test("checkBasicAuth: no auth configured allows everything", () => {
    assert.equal(checkBasicAuth(undefined, null), true);
});

test("checkBasicAuth: correct credentials pass (password may contain ':')", () => {
    assert.equal(checkBasicAuth(basic("admin:p:ss"), AUTH), true);
});

test("checkBasicAuth: wrong or missing credentials fail", () => {
    assert.equal(checkBasicAuth(undefined, AUTH), false);
    assert.equal(checkBasicAuth(basic("admin:nope"), AUTH), false);
    assert.equal(checkBasicAuth(basic("root:p:ss"), AUTH), false);
    assert.equal(checkBasicAuth(basic("adminp:ss"), AUTH), false);
    assert.equal(checkBasicAuth("Bearer abc", AUTH), false);
});

test("isLoopbackHost", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("192.168.1.2"), false);
});

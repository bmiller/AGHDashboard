"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { domainOf } = require("../lib/requests");

test("domainOf: reads question.name and strips the trailing root dot", () => {
    assert.equal(domainOf({ question: { name: "example.com." } }), "example.com");
});

test("domainOf: falls back to question.host", () => {
    assert.equal(domainOf({ question: { host: "example.org" } }), "example.org");
});

test("domainOf: missing question yields unknown", () => {
    assert.equal(domainOf({}), "unknown");
});

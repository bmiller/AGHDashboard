"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseTimestampMs, ApiError } = require("../lib/util");

test("parseTimestampMs: Zulu with nanoseconds truncates to ms", () => {
    assert.equal(parseTimestampMs("2024-01-02T03:04:05.123456789Z"), Date.UTC(2024, 0, 2, 3, 4, 5) + 123);
});

test("parseTimestampMs: short fraction is padded", () => {
    assert.equal(parseTimestampMs("2024-01-02T03:04:05.5Z"), Date.UTC(2024, 0, 2, 3, 4, 5) + 500);
});

test("parseTimestampMs: positive offset is subtracted to reach UTC", () => {
    assert.equal(parseTimestampMs("2024-01-02T05:00:00+02:00"), Date.UTC(2024, 0, 2, 3, 0, 0));
});

test("parseTimestampMs: negative offset is added", () => {
    assert.equal(parseTimestampMs("2024-01-02T01:00:00-02:00"), Date.UTC(2024, 0, 2, 3, 0, 0));
});

test("parseTimestampMs: no timezone treated as UTC", () => {
    assert.equal(parseTimestampMs("2024-06-15T12:30:00"), Date.UTC(2024, 5, 15, 12, 30, 0));
});

test("parseTimestampMs: garbage returns null", () => {
    assert.equal(parseTimestampMs("not-a-date"), null);
    assert.equal(parseTimestampMs(undefined), null);
});

test("ApiError carries a status", () => {
    const e = new ApiError(502, "boom");
    assert.equal(e.status, 502);
    assert.ok(e instanceof Error);
});

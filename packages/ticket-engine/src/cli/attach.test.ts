import test from "node:test";
import assert from "node:assert/strict";
import { parseAttachArgs } from "./attach.js";

test("parses the log path as the first positional arg", () => {
  assert.deepEqual(parseAttachArgs(["/x/y.log"]), { logPath: "/x/y.log", ref: undefined });
});

test("parses --ref regardless of position", () => {
  assert.deepEqual(parseAttachArgs(["/x/y.log", "--ref", "PROJ-12"]), {
    logPath: "/x/y.log",
    ref: "PROJ-12",
  });
});

test("returns undefined logPath when only flags are given", () => {
  assert.deepEqual(parseAttachArgs(["--ref", "PROJ-12"]), {
    logPath: undefined,
    ref: "PROJ-12",
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { adapters } from "./agents.js";

test("codex buildArgs includes --model before the prompt when a model is set", () => {
  const args = adapters.codex.buildArgs("do the thing", { model: "gpt-5.6-terra" });
  assert.deepEqual(args, ["exec", "--full-auto", "--model", "gpt-5.6-terra", "do the thing"]);
});

test("codex buildArgs omits --model when no model is set, prompt stays last", () => {
  const args = adapters.codex.buildArgs("do the thing", {});
  assert.deepEqual(args, ["exec", "--full-auto", "do the thing"]);
  assert.equal(args[args.length - 1], "do the thing");
});

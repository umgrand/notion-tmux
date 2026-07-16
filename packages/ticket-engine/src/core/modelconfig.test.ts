import assert from "node:assert/strict";
import test from "node:test";
import { automationProjectSchema } from "@notion-tmux/shared";

const base = {
  id: "p1",
  key: "dochub",
  databaseId: "db1",
  repoRoot: "/tmp/repo",
};

test("legacy project configs parse with team defaults", () => {
  const project = automationProjectSchema.parse(base);
  assert.equal(project.model, undefined);
  assert.equal(project.agentTeam, false);
  assert.equal(project.tiers, undefined);
});

test("model, agentTeam, and tiers round-trip", () => {
  const project = automationProjectSchema.parse({
    ...base,
    model: "claude-sonnet-5",
    agentTeam: true,
    tiers: { strategist: "opus", developer: "sonnet", checker: "haiku", orchestrator: null },
  });
  assert.equal(project.model, "claude-sonnet-5");
  assert.equal(project.agentTeam, true);
  assert.deepEqual(
    { ...project.tiers },
    { strategist: "opus", developer: "sonnet", checker: "haiku", orchestrator: undefined },
  );
});

import { adapters } from "./agents.js";

test("claude adapter injects --model when set and omits it when not", () => {
  const withModel = adapters.claude.buildArgs("do it", { allowlist: [], model: "claude-opus-4-8" });
  const modelIdx = withModel.indexOf("--model");
  assert.ok(modelIdx >= 0);
  assert.equal(withModel[modelIdx + 1], "claude-opus-4-8");

  const without = adapters.claude.buildArgs("do it", { allowlist: [] });
  assert.equal(without.includes("--model"), false);
});

test("gemini/aider/cursor adapters ignore model", () => {
  for (const id of ["gemini", "aider", "cursor"] as const) {
    const args = adapters[id].buildArgs("do it", { allowlist: [], model: "whatever" });
    assert.ok(!args.includes("--model"), `${id} should not add --model`);
    assert.ok(!args.includes("whatever"), `${id} should not include the model id`);
  }
});

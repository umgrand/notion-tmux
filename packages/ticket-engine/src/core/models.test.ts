import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listCodexModels, listModelsForAgent } from "./sessions.js";

async function withCodexHome(
  cacheContents: string | null,
  run: (home: string) => void | Promise<void>,
): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    if (cacheContents !== null) {
      fs.writeFileSync(path.join(home, "models_cache.json"), cacheContents);
    }
    await run(home);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("listCodexModels maps listed models and drops non-list/invalid entries", async () => {
  const cache = JSON.stringify({
    models: [
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list" },
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hidden" },
      { display_name: "No slug", visibility: "list" },
    ],
  });
  await withCodexHome(cache, () => {
    const models = listCodexModels();
    assert.deepEqual(models, [
      { value: "gpt-5.6-terra", displayName: "GPT-5.6-Terra" },
      { value: "gpt-5.6-sol", displayName: "GPT-5.6-Sol" },
    ]);
  });
});

test("listCodexModels falls back to slug when display_name missing", async () => {
  const cache = JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list" }] });
  await withCodexHome(cache, () => {
    assert.deepEqual(listCodexModels(), [{ value: "gpt-5.5", displayName: "gpt-5.5" }]);
  });
});

test("listCodexModels returns [] for missing file, bad JSON, and non-array models", async () => {
  await withCodexHome(null, () => assert.deepEqual(listCodexModels(), []));
  await withCodexHome("{ not json", () => assert.deepEqual(listCodexModels(), []));
  await withCodexHome(JSON.stringify({ models: "nope" }), () =>
    assert.deepEqual(listCodexModels(), []),
  );
});

test("listModelsForAgent routes codex to the cache and others to []", async () => {
  const cache = JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list" }] });
  await withCodexHome(cache, async () => {
    assert.deepEqual(await listModelsForAgent("codex", process.cwd()), [
      { value: "gpt-5.5", displayName: "gpt-5.5" },
    ]);
    assert.deepEqual(await listModelsForAgent("gemini", process.cwd()), []);
    assert.deepEqual(await listModelsForAgent("aider", process.cwd()), []);
  });
});

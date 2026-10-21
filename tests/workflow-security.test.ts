import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("agent review lanes use only the released artifact and never expose provider secrets to forks", async () => {
  const workflow = await readFile(".github/workflows/workflow-hub.yml", "utf8");

  assert.match(workflow, /codex-correctness:/);
  assert.match(workflow, /codex-security:/);
  assert.match(workflow, /claude-correctness:/);
  assert.match(workflow, /claude-security:/);
  assert.match(workflow, /v0\.2\.0\/duthaho-workflow-hub-0\.2\.0\.tgz/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.fork == false/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /workflow-hub review --provider codex --kind correctness/);
  assert.match(workflow, /workflow-hub review --provider claude --kind security/);
});

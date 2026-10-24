import assert from "node:assert/strict";
import { test } from "node:test";
import {
  autoSaveKey,
  readAutoSave,
  readWorkspacePage,
  workspacePageKey,
} from "../../src/frontend/src/workspace-memory.ts";

const storageFor = (entries) => ({
  getItem: (key) => new Map(entries).get(key) ?? null,
});

test("an explicitly disabled autosave preference survives and belongs to its account", () => {
  const storage = storageFor([
    [autoSaveKey("a1"), "false"],
    [autoSaveKey("a2"), "true"],
  ]);
  assert.equal(readAutoSave(storage, "a1"), false);
  assert.equal(readAutoSave(storage, "a2"), true);
  assert.equal(readAutoSave(storage, "new-account"), true);
});

test("page memory restores the same account task and return context", () => {
  const task = { view: "tasks", selectedId: "task-a" };
  const stats = { view: "stats", selectedId: "task-b" };
  const storage = storageFor([
    [workspacePageKey("a1"), JSON.stringify(task)],
    [workspacePageKey("admin"), JSON.stringify(stats)],
  ]);
  assert.deepEqual(readWorkspacePage(storage, "a1", false), task);
  assert.deepEqual(readWorkspacePage(storage, "admin", true), stats);
  assert.deepEqual(readWorkspacePage(storage, "a2", false), {
    view: "tasks",
    selectedId: null,
  });
  assert.deepEqual(readWorkspacePage(storage, "admin", false), {
    view: "tasks",
    selectedId: null,
  });
});

test("unavailable or malformed storage falls back without restoring invalid navigation", () => {
  const unavailable = {
    getItem: () => {
      throw new Error("storage unavailable");
    },
  };
  assert.equal(readAutoSave(unavailable, "a1"), true);
  assert.deepEqual(readWorkspacePage(unavailable, "a1", false), {
    view: "tasks",
    selectedId: null,
  });
  for (const value of [
    "{broken",
    "null",
    '{"view":"unknown","selectedId":null}',
    '{"view":"tasks","selectedId":"../private"}',
    '{"view":"tasks"}',
  ]) {
    assert.deepEqual(
      readWorkspacePage(
        storageFor([[workspacePageKey("a1"), value]]),
        "a1",
        false,
      ),
      { view: "tasks", selectedId: null },
    );
  }
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { AddressInfo } from "node:net";

import { createServer } from "../src/server.js";

const server = createServer();
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function postTask(
  body: unknown,
  idempotencyKey?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (idempotencyKey !== undefined) {
    headers["idempotency-key"] = idempotencyKey;
  }
  return fetch(`${baseUrl}/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("POST /tasks creates a pending task", async () => {
  const response = await postTask({ title: "Ship workflow demo" }, "create-1");
  const task = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("location"), `/tasks/${task.id}`);
  assert.match(String(task.id), /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { title: task.title, status: task.status },
    { title: "Ship workflow demo", status: "pending" },
  );
});

test("replaying the same key and payload returns the original task", async () => {
  const first = await postTask({ title: "Retry safely" }, "create-2");
  const second = await postTask({ title: "Retry safely" }, "create-2");

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await second.json(), await first.json());
});

test("reusing a key with a different payload is rejected", async () => {
  await postTask({ title: "Original" }, "create-3");
  const response = await postTask({ title: "Different" }, "create-3");

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "idempotency_conflict",
    message: "Idempotency-Key was already used with a different payload",
  });
});

test("missing idempotency key and invalid titles are rejected", async () => {
  const missingKey = await postTask({ title: "No key" });
  const blankTitle = await postTask({ title: "   " }, "create-4");

  assert.equal(missingKey.status, 400);
  assert.deepEqual(await missingKey.json(), {
    error: "invalid_idempotency_key",
    message: "Idempotency-Key header is required",
  });
  assert.equal(blankTitle.status, 422);
  assert.deepEqual(await blankTitle.json(), {
    error: "invalid_task",
    message: "title must be a non-empty string",
  });
});

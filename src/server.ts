import { randomUUID } from "node:crypto";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

interface Task {
  id: string;
  title: string;
  status: "pending";
}

interface IdempotencyRecord {
  fingerprint: string;
  task: Task;
  expiresAt: number;
}

export interface ServerOptions {
  maxIdempotencyRecords?: number;
  idempotencyTtlMs?: number;
  now?: () => number;
}

const maximumBodyBytes = 64 * 1024;
const maximumTitleLength = 200;
const defaultMaximumIdempotencyRecords = 10_000;
const defaultIdempotencyTtlMs = 24 * 60 * 60 * 1_000;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumBodyBytes) {
      throw new Error("payload_too_large");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function parseTask(value: unknown):
  | { title: string; fingerprint: string }
  | { error: string } {
  if (typeof value !== "object" || value === null || !("title" in value)) {
    return { error: "title must be a non-empty string" };
  }
  if (Object.keys(value).length !== 1) {
    return { error: "task body must contain only title" };
  }
  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return { error: "title must be a non-empty string" };
  }
  if (title.length > maximumTitleLength) {
    return { error: "title must be at most 200 characters" };
  }
  return {
    title: title.trim(),
    fingerprint: JSON.stringify({ title }),
  };
}

export function createServer(options: ServerOptions = {}) {
  const maxIdempotencyRecords =
    options.maxIdempotencyRecords ?? defaultMaximumIdempotencyRecords;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? defaultIdempotencyTtlMs;
  const now = options.now ?? Date.now;
  if (maxIdempotencyRecords < 1 || idempotencyTtlMs < 1) {
    throw new Error("Idempotency capacity and TTL must be positive");
  }
  const idempotencyRecords = new Map<string, IdempotencyRecord>();

  function purgeExpiredRecords(currentTime: number): void {
    for (const [key, record] of idempotencyRecords) {
      if (record.expiresAt <= currentTime) {
        idempotencyRecords.delete(key);
      }
    }
  }

  return createNodeServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "POST" && request.url === "/tasks") {
      const rawKey = request.headers["idempotency-key"];
      const idempotencyKey =
        typeof rawKey === "string" ? rawKey.trim() : undefined;
      if (!idempotencyKey) {
        sendJson(response, 400, {
          error: "invalid_idempotency_key",
          message: "Idempotency-Key header is required",
        });
        return;
      }

      let body: unknown;
      try {
        body = await readJson(request);
      } catch (error) {
        const tooLarge =
          error instanceof Error && error.message === "payload_too_large";
        sendJson(response, tooLarge ? 413 : 400, {
          error: tooLarge ? "payload_too_large" : "invalid_json",
          message: tooLarge
            ? "request body exceeds 65536 bytes"
            : "request body must be valid JSON",
        });
        return;
      }

      const parsedTask = parseTask(body);
      if ("error" in parsedTask) {
        sendJson(response, 422, {
          error: "invalid_task",
          message: parsedTask.error,
        });
        return;
      }

      const currentTime = now();
      purgeExpiredRecords(currentTime);
      const existing = idempotencyRecords.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== parsedTask.fingerprint) {
          sendJson(response, 409, {
            error: "idempotency_conflict",
            message: "Idempotency-Key was already used with a different payload",
          });
          return;
        }
        sendJson(response, 200, existing.task, {
          "idempotency-replayed": "true",
          location: `/tasks/${existing.task.id}`,
        });
        return;
      }

      if (idempotencyRecords.size >= maxIdempotencyRecords) {
        sendJson(response, 503, {
          error: "idempotency_capacity_reached",
          message: "idempotency retention capacity is temporarily exhausted",
        });
        return;
      }

      const task: Task = {
        id: randomUUID(),
        title: parsedTask.title,
        status: "pending",
      };
      idempotencyRecords.set(idempotencyKey, {
        fingerprint: parsedTask.fingerprint,
        task,
        expiresAt: currentTime + idempotencyTtlMs,
      });
      sendJson(response, 201, task, { location: `/tasks/${task.id}` });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

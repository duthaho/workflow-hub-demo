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
}

const maximumBodyBytes = 64 * 1024;

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

function taskTitle(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("title" in value)) {
    return undefined;
  }
  const title = (value as { title?: unknown }).title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return undefined;
  }
  return title.trim();
}

export function createServer() {
  const idempotencyRecords = new Map<string, IdempotencyRecord>();

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

      const title = taskTitle(body);
      if (title === undefined) {
        sendJson(response, 422, {
          error: "invalid_task",
          message: "title must be a non-empty string",
        });
        return;
      }

      const fingerprint = JSON.stringify({ title });
      const existing = idempotencyRecords.get(idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
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

      const task: Task = {
        id: randomUUID(),
        title,
        status: "pending",
      };
      idempotencyRecords.set(idempotencyKey, { fingerprint, task });
      sendJson(response, 201, task, { location: `/tasks/${task.id}` });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

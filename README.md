# workflow-hub-demo

A minimal TypeScript REST API used to demonstrate `workflow-hub` with TDD, deterministic CI, and independent Codex review.

## Commands

```bash
npm ci
npm run check
npm start
```

`GET /health` returns the service health status.

## Create a task

`POST /tasks` requires an `Idempotency-Key` header and a JSON body with a non-empty `title`:

```bash
curl -i http://127.0.0.1:3000/tasks \
  -H 'content-type: application/json' \
  -H 'idempotency-key: task-123' \
  --data '{"title":"Ship workflow demo"}'
```

The first request returns `201`. Replaying the same key and payload returns the original task with `200` and `Idempotency-Replayed: true`; changing the payload for an existing key returns `409`.

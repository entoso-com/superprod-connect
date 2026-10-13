# superprod-connect

Tiny stateless REST gateway that creates [Super Productivity](https://github.com/super-productivity/super-productivity)
tasks by uploading an `addTask` operation directly to a (self-hosted) SuperSync server. Made for Node-RED.

## API

### `POST /tasks`

Headers:

| Header | |
|---|---|
| `Authorization: Bearer <supersync-token>` | required: your SuperSync access token |
| `X-Encryption-Key: <password>` | required only if end-to-end encryption is enabled in the app |
| `Content-Type: application/json` | |

Body:

| Field | |
|---|---|
| `title` | required |
| `project` | optional: project ID or title (case-insensitive). Defaults to Inbox |
| `notes` | optional, Markdown |
| `url` | optional: added as a link attachment |
| `plannedDate` | optional `YYYY-MM-DD`: "planned for" day (today ⇒ shows in Today) |
| `deadline` | optional `YYYY-MM-DD` |

Response `201 {"taskId": "..."}`. Errors: `{"errorCode": "...", "error": "..."}`. SuperSync's
`errorCode` is passed through. The gateway adds its own codes: `VALIDATION_FAILED`, `UNAUTHORIZED`,
`ENCRYPTION_KEY_REQUIRED`, `DECRYPTION_FAILED`, `PROJECT_NOT_FOUND`, `UPSTREAM_UNREACHABLE`.

### `GET /health`

`200 {"ok": true}`

## Node-RED example

A `function` node followed by an `http request` node (Method: `- set by msg.method -`, Return: `a parsed JSON object`):

```js
msg.method = 'POST';
msg.url = 'http://superprod-connect:8080/tasks';
msg.headers = {
  Authorization: 'Bearer ' + env.get('SUPERSYNC_TOKEN'),
  'X-Encryption-Key': env.get('SUPERSYNC_E2EE_KEY'), // omit without E2EE
  'Content-Type': 'application/json',
};
msg.payload = {
  title: 'Buy milk',
  project: 'Household',
  notes: 'From Node-RED',
  url: 'https://example.com',
  plannedDate: '2026-10-14',
  deadline: '2026-10-20',
};
return msg;
```

## Configuration

| Env | Default | |
|---|---|---|
| `SUPERSYNC_URL` | — | required, e.g. `https://sync.example.com` |
| `PORT` | `8080` | |
| `CLIENT_ID` | `superprod-connect` | the SuperSync client ID used for uploaded ops |

## How it works

On each request the gateway downloads the user's op log. From it, it builds the merged vector clock and
replays project ops, decrypting only those, so it can resolve project titles. It then uploads one
`[Task Shared] addTask` op (schemaVersion 4) whose clock dominates every clock it has seen, with the
`CLIENT_ID` entry incremented. When E2EE is on, the payload is encrypted the same way as the app does it:
Argon2id plus AES-256-GCM. No state is kept, and tokens and keys are never logged or stored.

## Deploy

`docker-compose.yml` works as a Portainer stack as-is. GitHub Actions publishes
`ghcr.io/entoso-com/superprod-connect:latest` on every push to `main`.

## Development

```sh
npm install
cp .env.example .env   # fill in
npm run dev            # Node >= 22.18 runs the .ts sources directly
npm run typecheck
```

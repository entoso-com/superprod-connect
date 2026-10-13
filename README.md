# superprod-connect

**A lightweight REST API gateway for [Super Productivity](https://super-productivity.com), enabling external tools and automation platforms to create tasks directly through a SuperSync server.**

### Why I built this

My personal productivity workflows rely heavily on automation. Documents arrive in Paperless-ngx, Node-RED processes events and information, and relevant actions automatically become tasks in my task management system.

This worked well with my previous task manager. However, after switching to Super Productivity, I discovered a missing piece: there was no straightforward REST API or external connector to create tasks programmatically.

I wanted to keep using Super Productivity without giving up the automations I had built around my existing tools.

So I built **superprod-connect** — a small, self-hosted REST gateway that communicates directly with SuperSync, allowing external applications to create tasks without requiring the Super Productivity app or web interface to be running.

### What it does

- **REST API for task creation** — Create Super Productivity tasks through a simple HTTP POST request.
- **Automation-friendly** — Designed for Node-RED, but works with n8n, scripts, webhooks, and virtually any application capable of making HTTP requests.
- **Project-aware** — Assign tasks to existing projects by name or ID, or send them to the Inbox.
- **Rich task metadata** — Supports descriptions (Markdown), URLs, planned dates, and deadlines.
- **End-to-end encryption support** — Compatible with SuperSync configurations using E2EE.
- **Stateless and self-hosted** — No additional database required; credentials and encryption keys are not stored.
- **Docker-ready** — Easy to deploy as a standalone container alongside your existing services.

### How it works

superprod-connect acts as a bridge between external automation systems and SuperSync. Rather than requiring a running Super Productivity client, it translates REST requests into Super Productivity-compatible synchronization operations and uploads them directly to the server.

This makes it possible to integrate task creation into automated workflows, whether triggered by incoming documents, emails, smart home events, or custom scripts.

### Project status

This is a small, independently developed utility, originally built to solve a problem in my own self-hosted setup. I'm sharing it in case others have encountered the same integration gap.

It is not an official Super Productivity integration and currently focuses on task creation rather than providing a complete API for all Super Productivity functionality.

### Related projects

- **[Super Productivity](https://github.com/super-productivity/super-productivity)** is the open-source to-do list
  and time tracker this gateway creates tasks for. It runs on desktop, mobile and the web. Its source code defines the
  task model and the sync operations that superprod-connect reproduces.
- **[SuperSync server](https://github.com/super-productivity/super-productivity/tree/master/packages/super-sync-server)**
  is the self-hostable sync backend from the same repository. It stores every change your devices make as an
  operation and relays those operations between devices. superprod-connect talks to this server, not to the app. It
  uploads the same kind of "add task" operation a device would, so your apps pick up the new task on their next sync.
  You need a running SuperSync server, your own or a hosted one, to use superprod-connect.

---

## Installation

Run the container next to your other services, with `SUPERSYNC_URL` pointing to your SuperSync server:

```yaml
services:
  superprod-connect:
    image: ghcr.io/entoso-com/superprod-connect:latest
    restart: unless-stopped
    environment:
      - SUPERSYNC_URL=https://sync.example.com
      - PORT=8080
      - CLIENT_ID=superprod-connect
    ports:
      - "8080:8080"
```

This works as a Portainer stack or with `docker compose up -d`. Check it with `curl http://<host>:8080/health`.

| Env | Default | |
|---|---|---|
| `SUPERSYNC_URL` | — | required: your SuperSync server |
| `PORT` | `8080` | |
| `CLIENT_ID` | `superprod-connect` | the client ID SuperSync sees for tasks created by the gateway |

The gateway holds no credentials. Every request carries the caller's own, so one instance can serve several users.

## API

### `POST /tasks`

Headers:

| Header | |
|---|---|
| `Authorization: Bearer <supersync-token>` | required: your SuperSync access token, the same one the app uses for sync |
| `X-Encryption-Key: <password>` | required only if end-to-end encryption is enabled in the app's sync settings |
| `Content-Type: application/json` | |

Body:

| Field | |
|---|---|
| `title` | required |
| `project` | optional: project ID or title (case-insensitive). Defaults to Inbox |
| `notes` | optional, Markdown |
| `url` | optional: added as a link attachment |
| `plannedDate` | optional `YYYY-MM-DD`: the day the task is planned for. Today's date puts it in Today |
| `deadline` | optional `YYYY-MM-DD` |

```sh
curl -X POST http://localhost:8080/tasks \
  -H "Authorization: Bearer $SUPERSYNC_TOKEN" \
  -H "X-Encryption-Key: $SUPERSYNC_E2EE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Buy milk","project":"Household","plannedDate":"2026-10-14"}'
```

Response: `201 {"taskId": "..."}`. Errors look like `{"errorCode": "...", "error": "..."}`. Error codes from SuperSync
are passed through. The gateway adds its own codes: `VALIDATION_FAILED`, `UNAUTHORIZED`, `ENCRYPTION_KEY_REQUIRED`,
`DECRYPTION_FAILED`, `PROJECT_NOT_FOUND` and `UPSTREAM_UNREACHABLE`.

### `GET /health`

`200 {"ok": true}`

## Node-RED sample flow

[`examples/node-red-flow.json`](examples/node-red-flow.json) is a ready-made flow:
**inject → Build request → superprod-connect → Result**.

1. In Node-RED, open **Menu → Import**, paste the contents of the file (or select the file), and click **Import**.
2. Double-click the new **Super Productivity** tab and set its **Environment Variables**:

   | Variable | |
   |---|---|
   | `SUPERPROD_CONNECT_URL` | where the gateway runs, e.g. `http://superprod-connect:8080` or `http://192.168.1.10:8080` |
   | `SUPERSYNC_TOKEN` | your SuperSync access token |
   | `SUPERSYNC_E2EE_KEY` | your E2EE password; leave empty if you don't use encryption |
   | `SUPERPROD_PROJECT` | optional default project name or ID; empty means Inbox |
   | `PLAN_FOR_TODAY` | `true` plans tasks for today when the message has no `plannedDate` |

3. Click **Deploy**, then click the **Example task** inject button. The debug sidebar shows the response, and the
   task appears in Super Productivity after the app's next sync.

To use it with your own data, connect any node to **Build request**. That node should send `msg.payload` with these
fields: `title` (required), `project`, `notes`, `url`, `plannedDate` and `deadline`.
Example: a webhook from Paperless-ngx, mapped by a change or function node:

```js
msg.payload = {
  title: `Process ${msg.payload.title}`,
  notes: `Correspondent: ${msg.payload.correspondent}`,
  url: msg.payload.url,
};
return msg;
```

If the debug node shows `401`, the token is wrong. Pasted tokens sometimes pick up spaces, which the sample flow removes.
If it shows `ENCRYPTION_KEY_REQUIRED` or `DECRYPTION_FAILED`, the E2EE key is missing or wrong.

## Technical notes

On each request the gateway downloads the user's op log. From it, it builds the merged vector clock and replays project
ops, decrypting only those, so it can resolve project titles. It then uploads one `[Task Shared] addTask` operation
(schemaVersion 4) whose clock dominates every clock it has seen. With E2EE on, the payload is encrypted the same way as
the app does it: Argon2id plus AES-256-GCM. Tokens and keys are never logged or stored.

## Development

```sh
npm install
cp .env.example .env   # fill in
npm run dev            # Node >= 22.18 runs the .ts sources directly
npm run typecheck
```

## License

MIT

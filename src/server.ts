import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { addTask, SyncError, type NewTask } from './supersync.ts';

const SUPERSYNC_URL = (process.env.SUPERSYNC_URL ?? '').replace(/\/+$/, '');
const CLIENT_ID = process.env.CLIENT_ID || 'superprod-connect';
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 64 * 1024;

if (!SUPERSYNC_URL) {
  console.error('SUPERSYNC_URL is required');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]{1,255}$/.test(CLIENT_ID)) {
  console.error('CLIENT_ID must be alphanumeric with underscores/hyphens only');
  process.exit(1);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new SyncError(413, 'PAYLOAD_TOO_LARGE', 'Body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SyncError(400, 'VALIDATION_FAILED', 'Body must be JSON');
  }
}

function parseTask(body: any): NewTask {
  const fail = (msg: string): never => {
    throw new SyncError(400, 'VALIDATION_FAILED', msg);
  };
  if (!body || typeof body !== 'object') fail('Body must be a JSON object');
  const str = (k: string): string | undefined => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') fail(`${k} must be a string`);
    return v;
  };
  const title = str('title')?.trim();
  if (!title) fail('title is required');
  const task: NewTask = {
    title: title!,
    project: str('project'),
    notes: str('notes'),
    url: str('url'),
    plannedDate: str('plannedDate'),
    deadline: str('deadline'),
  };
  for (const k of ['plannedDate', 'deadline'] as const) {
    const v = task[k];
    if (v && (!DATE.test(v) || Number.isNaN(Date.parse(v)))) fail(`${k} must be YYYY-MM-DD`);
  }
  return task;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (req.method !== 'POST' || path !== '/tasks') return send(res, 404, { errorCode: 'NOT_FOUND' });

  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
  if (!token) return send(res, 401, { errorCode: 'UNAUTHORIZED', error: 'Missing Bearer token' });
  const key = req.headers['x-encryption-key'];
  const encryptionKey = (Array.isArray(key) ? key[0] : key) || undefined;

  const input = parseTask(await readJson(req));
  const taskId = await addTask({ baseUrl: SUPERSYNC_URL, token, encryptionKey, clientId: CLIENT_ID }, input);
  send(res, 201, { taskId });
}

createServer((req, res) => {
  const started = Date.now();
  // Only method, path and status are logged — never headers or bodies (they carry credentials).
  res.on('finish', () => console.log(`${req.method} ${req.url?.split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`));
  handle(req, res).catch((err) => {
    if (err instanceof SyncError) return send(res, err.status, { errorCode: err.errorCode, error: err.message });
    console.error('Unhandled error:', err instanceof Error ? err.message : 'unknown');
    send(res, 500, { errorCode: 'INTERNAL_ERROR', error: 'Internal error' });
  });
}).listen(PORT, () => console.log(`superprod-connect listening on :${PORT} -> ${SUPERSYNC_URL}`));

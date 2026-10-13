// SuperSync wire helpers: E2EE payload crypto, op download/replay, add-task upload.
// Formats mirror upstream super-productivity (packages/sync-core, schemaVersion 4).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';

export const SCHEMA_VERSION = 4;
export const INBOX_PROJECT_ID = 'INBOX_PROJECT';
const MAX_VECTOR_CLOCK_SIZE = 20;
const FULL_STATE_OP_TYPES = new Set(['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR']);

type VectorClock = Record<string, number>;
interface Op {
  id: string;
  clientId: string;
  actionType: string;
  opType: string;
  entityType: string;
  entityId?: string;
  payload: unknown;
  vectorClock: VectorClock;
  timestamp: number;
  schemaVersion: number;
  isPayloadEncrypted?: boolean;
}
export interface Creds {
  baseUrl: string;
  token: string;
  encryptionKey?: string;
  clientId: string;
}
export interface NewTask {
  title: string;
  project?: string;
  notes?: string;
  url?: string;
  plannedDate?: string;
  deadline?: string;
}

/** Error carrying an HTTP status and a SuperSync-style errorCode for the API response. */
export class SyncError extends Error {
  status: number;
  errorCode: string;
  constructor(status: number, errorCode: string, message: string) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

// ---------------------------------------------------------------------------
// Encryption: base64([salt 16][iv 12][AES-256-GCM ciphertext][tag 16]),
// key = Argon2id(password, salt, t=3, m=64 MiB, p=1, 32 bytes).
// ---------------------------------------------------------------------------

class Keyring {
  // Lives for one request only; never persisted.
  private keys = new Map<string, Promise<Buffer>>();
  private password: string;
  constructor(password: string) {
    this.password = password;
  }

  key(salt: Buffer): Promise<Buffer> {
    const id = salt.toString('base64');
    let key = this.keys.get(id);
    if (!key) {
      key = argon2id({
        password: this.password,
        salt,
        hashLength: 32,
        parallelism: 1,
        iterations: 3,
        memorySize: 65536,
        outputType: 'binary',
      }).then((k) => Buffer.from(k));
      this.keys.set(id, key);
    }
    return key;
  }

  async decrypt(data: string): Promise<unknown> {
    const buf = Buffer.from(data, 'base64');
    if (buf.length < 44) throw new SyncError(400, 'DECRYPTION_FAILED', 'Unsupported ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', await this.key(buf.subarray(0, 16)), buf.subarray(16, 28));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    try {
      return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28, buf.length - 16)), decipher.final()]).toString('utf8'));
    } catch {
      throw new SyncError(400, 'DECRYPTION_FAILED', 'Could not decrypt payload (wrong encryption key?)');
    }
  }

  async encrypt(value: unknown): Promise<string> {
    // Reuse an already-derived salt like upstream's session cache does; IVs stay unique.
    const salt = this.keys.size ? Buffer.from(this.keys.keys().next().value!, 'base64') : randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(salt), iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([salt, iv, ct, cipher.getAuthTag()]).toString('base64');
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api<T>(creds: Creds, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(creds.baseUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${creds.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError(502, 'UPSTREAM_UNREACHABLE', 'SuperSync server unreachable');
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok) {
    throw new SyncError(res.status, json.errorCode ?? `HTTP_${res.status}`, json.error ?? res.statusText);
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// State: merged vector clock + project list, rebuilt from the op log per request.
// ---------------------------------------------------------------------------

interface SyncState {
  latestSeq: number;
  clock: VectorClock;
  projects: Map<string, string>; // id -> title
  encrypted: boolean;
}

function mergeClock(into: VectorClock, from: VectorClock | undefined): void {
  for (const [id, n] of Object.entries(from ?? {})) {
    if (typeof n === 'number' && n > (into[id] ?? 0)) into[id] = n;
  }
}

function isProjectOp(op: Op): boolean {
  return FULL_STATE_OP_TYPES.has(op.opType) || op.entityType === 'PROJECT';
}

function applyProjectOp(projects: Map<string, string>, op: Op, payload: any): void {
  if (FULL_STATE_OP_TYPES.has(op.opType)) {
    const state = payload?.appDataComplete ?? payload;
    projects.clear();
    for (const p of Object.values<any>(state?.project?.entities ?? {})) {
      if (p?.id) projects.set(p.id, p.title ?? '');
    }
    return;
  }
  const a = payload?.actionPayload ?? {};
  switch (op.actionType) {
    case '[Project] Add Project':
      if (a.project?.id) projects.set(a.project.id, a.project.title ?? '');
      break;
    case '[Project] Update Project':
      if (a.project?.id && projects.has(a.project.id) && typeof a.project.changes?.title === 'string') {
        projects.set(a.project.id, a.project.changes.title);
      }
      break;
    case '[Task Shared] deleteProject':
      projects.delete(a.projectId);
      break;
  }
}

async function loadState(creds: Creds, keyring: Keyring | undefined): Promise<SyncState> {
  const state: SyncState = { latestSeq: 0, clock: {}, projects: new Map(), encrypted: false };
  let sinceSeq = 0;
  for (;;) {
    const page = await api<{
      ops: { serverSeq: number; op: Op }[];
      hasMore: boolean;
      latestSeq: number;
      snapshotVectorClock?: VectorClock;
    }>(creds, `/api/sync/ops?sinceSeq=${sinceSeq}&limit=1000`);
    state.latestSeq = page.latestSeq;
    mergeClock(state.clock, page.snapshotVectorClock);
    for (const { serverSeq, op } of page.ops) {
      sinceSeq = Math.max(sinceSeq, serverSeq);
      mergeClock(state.clock, op.vectorClock);
      const encrypted = op.isPayloadEncrypted === true || typeof op.payload === 'string';
      if (encrypted) state.encrypted = true;
      if (!isProjectOp(op)) continue;
      if (encrypted && !keyring) {
        throw new SyncError(400, 'ENCRYPTION_KEY_REQUIRED', 'Data is end-to-end encrypted; send X-Encryption-Key');
      }
      applyProjectOp(state.projects, op, encrypted ? await keyring!.decrypt(op.payload as string) : op.payload);
    }
    if (!page.hasMore || page.ops.length === 0) break;
  }
  return state;
}

function nextClock(merged: VectorClock, clientId: string): VectorClock {
  const clock = { ...merged, [clientId]: (merged[clientId] ?? 0) + 1 };
  const entries = Object.entries(clock);
  if (entries.length <= MAX_VECTOR_CLOCK_SIZE) return clock;
  // Same idea as upstream limitVectorClockSize: keep our own entry, then the highest counters.
  const others = entries.filter(([id]) => id !== clientId).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries([[clientId, clock[clientId]], ...others.slice(0, MAX_VECTOR_CLOCK_SIZE - 1)]);
}

function resolveProject(projects: Map<string, string>, ref: string | undefined): string {
  if (!ref) return INBOX_PROJECT_ID;
  if (projects.has(ref)) return ref;
  const wanted = ref.trim().toLowerCase();
  const match = [...projects].find(([, title]) => title.trim().toLowerCase() === wanted);
  if (!match) throw new SyncError(404, 'PROJECT_NOT_FOUND', `Project "${ref}" not found`);
  return match[0];
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
const nanoid = (size = 21): string => [...randomBytes(size)].map((b) => NANOID_ALPHABET[b & 63]).join('');

function uuidv7(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Add task
// ---------------------------------------------------------------------------

export async function addTask(creds: Creds, input: NewTask): Promise<string> {
  const keyring = creds.encryptionKey ? new Keyring(creds.encryptionKey) : undefined;
  const state = await loadState(creds, keyring);
  if (state.encrypted && !keyring) {
    throw new SyncError(400, 'ENCRYPTION_KEY_REQUIRED', 'Data is end-to-end encrypted; send X-Encryption-Key');
  }
  const projectId = resolveProject(state.projects, input.project);
  const now = Date.now();
  const taskId = nanoid();

  // Field order and defaults match tasks created by the app.
  const task: Record<string, unknown> = {
    id: taskId,
    subTaskIds: [],
    timeSpentOnDay: {},
    timeSpent: 0,
    timeEstimate: 0,
    isDone: false,
    title: input.title,
    tagIds: [],
    created: now,
    attachments: input.url ? [{ id: nanoid(), type: 'LINK', path: input.url, title: input.url, icon: 'link' }] : [],
    projectId,
  };
  if (input.notes) task.notes = input.notes;
  if (input.plannedDate) task.dueDay = input.plannedDate;
  if (input.deadline) task.deadlineDay = input.deadline;

  const payload = {
    actionPayload: {
      task,
      workContextId: projectId,
      workContextType: 'PROJECT',
      isAddToBacklog: false,
      isAddToBottom: false,
    },
    entityChanges: [],
  };
  const op: Op = {
    id: uuidv7(),
    clientId: creds.clientId,
    actionType: '[Task Shared] addTask',
    opType: 'CRT',
    entityType: 'TASK',
    entityId: taskId,
    payload: keyring ? await keyring.encrypt(payload) : payload,
    vectorClock: nextClock(state.clock, creds.clientId),
    timestamp: now,
    schemaVersion: SCHEMA_VERSION,
    isPayloadEncrypted: !!keyring,
  };

  const res = await api<{ results: { accepted: boolean; error?: string; errorCode?: string }[] }>(
    creds,
    '/api/sync/ops',
    { clientId: creds.clientId, ops: [op], lastKnownServerSeq: state.latestSeq },
  );
  const result = res.results?.[0];
  if (!result?.accepted) {
    const code = result?.errorCode ?? 'UPLOAD_REJECTED';
    throw new SyncError(code.startsWith('CONFLICT') || code === 'DUPLICATE_OPERATION' ? 409 : 400, code, result?.error ?? 'Operation rejected');
  }
  return taskId;
}

import type { ProofbenchRecord, SaveSuiteRequest, Suite, TestCase } from '@rayfin-app/shared';
import { digest, object, SafeError, stableId, text, uuid } from './safety.js';

export interface RecordPage { items: ProofbenchRecord[]; hasNextPage: boolean }
export interface GuardPage extends RecordPage { endCursor?: string }
export type GuardKind = 'notebook_guard' | 'notebook_guard_release';
/** Only owner-filtered reads and creates are available to the protocol. */
export interface Store {
  manifests(owner: string, familyId?: string): Promise<RecordPage>;
  runs(owner: string): Promise<RecordPage>;
  guardPage(owner: string, scopeId: string, kind: GuardKind, cursor?: string): Promise<GuardPage>;
  record(owner: string, id: string): Promise<ProofbenchRecord | undefined>;
  create(row: ProofbenchRecord): Promise<void>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SafeError('INVALID_INPUT', 'The request contains unsupported fields.');
}

export function parseSuite(input: string): SaveSuiteRequest {
  if (typeof input !== 'string' || Buffer.byteLength(input, 'utf8') > 100000) throw new SafeError('INVALID_INPUT', 'Suite JSON must not exceed 100 KB.');
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(input)); }
  catch { throw new SafeError('INVALID_INPUT', 'Suite JSON is invalid.'); }
  exactKeys(value, ['name', 'cases']);
  const name = text(value.name, 1, 120);
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 30) {
    throw new SafeError('INVALID_INPUT', 'A suite must contain between 1 and 30 questions.');
  }
  const cases = value.cases.map(item => {
    const row = object(item);
    // IDs from an edited/saved suite are ignored; stable IDs are always assigned by the backend.
    exactKeys(row, ['id', 'question', 'expectedAnswer', 'category', 'critical']);
    if (row.id !== undefined) uuid(row.id);
    if (typeof row.critical !== 'boolean') throw new SafeError('INVALID_INPUT', 'Each question requires a critical flag.');
    return {
      question: text(row.question, 1, 1000),
      expectedAnswer: text(row.expectedAnswer, 1, 1500),
      category: row.category === undefined ? '' : text(row.category, 0, 80),
      critical: row.critical,
    };
  });
  return { name, cases };
}

function iso(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error();
  return date.toISOString();
}

function family(owner: string, name: string): string {
  return stableId(['proofbench-family-v1', owner, name.normalize('NFC').trim().toLowerCase()]);
}

function suiteId(owner: string, name: string, version: number): string {
  return stableId(['proofbench-suite-v1', family(owner, name), version]);
}

function caseId(id: string, index: number): string {
  return stableId(['proofbench-case-v1', id, index]);
}

function suiteHash(suite: Omit<Suite, 'hash'>): string {
  return digest(['proofbench-suite-v1', suite.id, suite.name, suite.version, suite.createdAt,
    suite.cases.map(row => [row.id, row.question, row.expectedAnswer, row.category, row.critical])]);
}

// Length framing keeps even quote-heavy, maximum-length questions below text(4000).
function encodeCase(row: TestCase): string {
  return JSON.stringify([1, row.question.length, row.expectedAnswer.length, row.category.length, row.critical]) +
    '\n' + row.question + row.expectedAnswer + row.category;
}

function decodeCase(id: string, payload: string): TestCase {
  const separator = payload.indexOf('\n');
  const header: unknown = JSON.parse(payload.slice(0, separator));
  if (separator < 0 || !Array.isArray(header) || header.length !== 5 || header[0] !== 1 ||
      !header.slice(1, 3).every(value => Number.isInteger(value) && value > 0) ||
      !Number.isInteger(header[3]) || header[3] < 0 || typeof header[4] !== 'boolean') throw new Error();
  const [, q, a, c, critical] = header as [number, number, number, number, boolean];
  const content = payload.slice(separator + 1);
  if (content.length !== q + a + c) throw new Error();
  const row = { id, question: content.slice(0, q), expectedAnswer: content.slice(q, q + a), category: content.slice(q + a), critical };
  const normalized = parseSuite(JSON.stringify({ name: 'verify', cases: [row] })).cases[0];
  if (normalized.question !== row.question || normalized.expectedAnswer !== row.expectedAnswer || normalized.category !== row.category) throw new Error();
  return row;
}

interface Manifest { id: string; name: string; version: number; createdAt: string; caseIds: string[]; hash: string }

function manifest(row: ProofbenchRecord, owner: string): Manifest {
  if (row.owner_id !== owner || row.kind !== 'manifest' || typeof row.payload !== 'string' || row.payload.length > 4000) throw new Error();
  const parsed = object(JSON.parse(row.payload));
  exactKeys(parsed, ['id', 'name', 'version', 'createdAt', 'caseIds', 'hash']);
  const name = text(parsed.name, 1, 120);
  if (name !== parsed.name || !Number.isSafeInteger(parsed.version) || Number(parsed.version) < 1) throw new Error();
  const version = Number(parsed.version);
  const id = uuid(parsed.id);
  if (row.id !== id || id !== suiteId(owner, name, version) || row.suiteId !== family(owner, name) ||
      typeof parsed.createdAt !== 'string' || parsed.createdAt !== iso(parsed.createdAt) || iso(row.createdAt) !== parsed.createdAt ||
      typeof parsed.hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.hash) ||
      !Array.isArray(parsed.caseIds) || parsed.caseIds.length < 1 || parsed.caseIds.length > 30) throw new Error();
  const caseIds = parsed.caseIds.map((value, index) => {
    const key = uuid(value);
    if (key !== caseId(id, index)) throw new Error();
    return key;
  });
  return { id, name, version, createdAt: parsed.createdAt, caseIds, hash: parsed.hash };
}

export class Suites {
  constructor(private readonly store: Store, private readonly owner: string) {}

  /** Resolve one owner-scoped version independently of the bounded history view. */
  async getById(id: string): Promise<Suite> {
    const stored = await this.store.record(this.owner, uuid(id));
    if (!stored) throw new SafeError('SUITE_NOT_FOUND', 'The saved test version was not found or is not accessible.');
    return this.load(stored);
  }

  private async load(row: ProofbenchRecord): Promise<Suite> {
    try {
      const entry = manifest(row, this.owner);
      const cases: TestCase[] = [];
      for (const id of entry.caseIds) {
        const stored = await this.store.record(this.owner, id);
        if (!stored || stored.id !== id || stored.owner_id !== this.owner || stored.kind !== 'case' ||
            stored.suiteId !== entry.id || iso(stored.createdAt) !== entry.createdAt ||
            typeof stored.payload !== 'string' || stored.payload.length > 4000) throw new Error();
        cases.push(decodeCase(id, stored.payload));
      }
      const suite = { id: entry.id, name: entry.name, version: entry.version, createdAt: entry.createdAt, cases, hash: entry.hash };
      if (suiteHash(suite) !== entry.hash) throw new Error();
      return suite;
    } catch {
      throw new SafeError('STORED_SUITE_INVALID', 'A persisted suite is incomplete or failed integrity validation. It was not silently omitted.');
    }
  }

  async history(): Promise<{ suites: Suite[]; complete: boolean }> {
    const page = await this.store.manifests(this.owner);
    try {
      if (page.items.length > 100) throw new Error();
      for (const row of page.items) manifest(row, this.owner);
    } catch { throw new SafeError('STORED_SUITE_INVALID', 'Persisted suite metadata failed validation.'); }
    const suites: Suite[] = [];
    for (const row of page.items.slice(0, 25)) suites.push(await this.load(row));
    return { suites, complete: !page.hasNextPage && page.items.length <= 25 };
  }

  async save(input: string): Promise<Suite> {
    const requested = parseSuite(input);
    const familyId = family(this.owner, requested.name);
    const history = await this.store.manifests(this.owner, familyId);
    let version = 1;
    try {
      if (history.items.length > 100 || history.hasNextPage) {
        throw new SafeError('VERSION_HISTORY_LIMIT', 'This suite has reached the bounded version-history limit. Use a new suite name.');
      }
      const versions = new Set<number>();
      for (const row of history.items) {
        const previous = manifest(row, this.owner);
        if (family(this.owner, previous.name) !== familyId || versions.has(previous.version)) throw new Error();
        versions.add(previous.version);
        version = Math.max(version, previous.version + 1);
      }
    } catch (error) {
      if (error instanceof SafeError && error.code === 'VERSION_HISTORY_LIMIT') throw error;
      throw new SafeError('STORED_SUITE_INVALID', 'Persisted suite version metadata failed validation.');
    }
    const id = suiteId(this.owner, requested.name, version);
    const createdAt = new Date().toISOString();
    const cases = requested.cases.map((row, index) => ({ id: caseId(id, index), ...row }));
    const suite: Suite = { id, name: requested.name, version, createdAt, cases, hash: '' };
    suite.hash = suiteHash(suite);
    const payload = JSON.stringify({ id, name: suite.name, version, createdAt, caseIds: cases.map(row => row.id), hash: suite.hash });
    if (payload.length > 4000 || cases.some(row => encodeCase(row).length > 4000)) throw new SafeError('INVALID_INPUT', 'The normalized suite exceeds storage limits.');
    try {
      // Deterministic case PKs arbitrate concurrent same-version saves. No upsert, transaction claim, or retry.
      for (const row of cases) await this.store.create({
        id: row.id, owner_id: this.owner, kind: 'case', suiteId: id, createdAt: new Date(createdAt), payload: encodeCase(row),
      });
      // Visibility/commit marker last. Earlier failures can leave harmless, invisible orphan cases.
      await this.store.create({ id, owner_id: this.owner, kind: 'manifest', suiteId: familyId, createdAt: new Date(createdAt), payload });
    } catch {
      throw new SafeError('SAVE_UNCERTAIN', 'The save may be incomplete or conflicted with another save. Reload history before any manual retry; no automatic retry was performed.');
    }
    const stored = await this.store.record(this.owner, id);
    if (!stored) throw new SafeError('SAVE_UNCERTAIN', 'The save could not be confirmed. Reload history before any manual retry.');
    return this.load(stored);
  }
}

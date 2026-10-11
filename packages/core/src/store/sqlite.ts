import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { dirname } from 'pathe'
import { Artifact, Event, Run, Stage, type EventInput } from '../schemas/index.ts'
import { ensureDir } from '../paths.ts'
import type { RunStore } from './types.ts'

// Loaded through the runtime so bundlers leave it alone (esbuild rewrites `node:sqlite` to `sqlite`),
// with a plain message on Node versions where the module is still behind a flag.
const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined
if (!sqlite?.DatabaseSync) {
  throw new Error(
    `node:sqlite is not available on Node ${process.versions.node}; multiplat-factory needs Node 22.13 or newer`,
  )
}
const { DatabaseSync } = sqlite
type DatabaseSync = DatabaseSyncType

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  stage_id TEXT,
  type TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id, ord);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
`

type Row = Record<string, unknown>

export class SqliteRunStore implements RunStore {
  private db: DatabaseSync

  constructor(path: string) {
    if (path !== ':memory:') ensureDir(dirname(path))
    this.db = new DatabaseSync(path)
    // The daemon and a CLI driver open the same store: wait for a lock instead of failing at once
    // (Node's SQLite has no busy timeout by default), and never let the WAL switch, which needs
    // the file to itself for a moment, take the whole process down when another connection is in.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
    } catch (err) {
      if (!/locked|busy/i.test((err as Error).message)) throw err
    }
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
  }

  createRun(run: Run): void {
    const r = Run.parse(run)
    this.db
      .prepare('INSERT INTO runs (id, created_at, updated_at, status, json) VALUES (?, ?, ?, ?, ?)')
      .run(r.id, r.createdAt, r.updatedAt, r.status, JSON.stringify(r))
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT json FROM runs WHERE id = ?').get(id) as Row | undefined
    return row ? Run.parse(JSON.parse(row.json as string)) : undefined
  }

  listRuns(limit = 100): Run[] {
    const rows = this.db
      .prepare('SELECT json FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Row[]
    return rows.map((r) => Run.parse(JSON.parse(r.json as string)))
  }

  updateRun(run: Run): void {
    const r = Run.parse(run)
    this.db
      .prepare('UPDATE runs SET updated_at = ?, status = ?, json = ? WHERE id = ?')
      .run(r.updatedAt, r.status, JSON.stringify(r), r.id)
  }

  upsertStage(stage: Stage): void {
    const s = Stage.parse(stage)
    this.db
      .prepare(
        `INSERT INTO stages (id, run_id, ord, status, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id, id) DO UPDATE SET ord = excluded.ord, status = excluded.status, json = excluded.json`,
      )
      .run(s.id, s.runId, s.ord, s.status, JSON.stringify(s))
  }

  getStage(runId: string, stageId: string): Stage | undefined {
    const row = this.db
      .prepare('SELECT json FROM stages WHERE run_id = ? AND id = ?')
      .get(runId, stageId) as Row | undefined
    return row ? Stage.parse(JSON.parse(row.json as string)) : undefined
  }

  listStages(runId: string): Stage[] {
    const rows = this.db
      .prepare('SELECT json FROM stages WHERE run_id = ? ORDER BY ord ASC')
      .all(runId) as Row[]
    return rows.map((r) => Stage.parse(JSON.parse(r.json as string)))
  }

  appendEvent(event: EventInput): Event {
    const insert = this.db.prepare(
      'INSERT INTO events (run_id, seq, ts, stage_id, type, json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    const next = this.db.prepare(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE run_id = ?',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const { seq } = next.get(event.runId) as { seq: number }
      const full = Event.parse({ ...event, seq })
      insert.run(
        full.runId,
        full.seq,
        full.ts,
        full.stageId ?? null,
        full.type,
        JSON.stringify(full),
      )
      this.db.exec('COMMIT')
      return full
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  listEvents(runId: string, afterSeq = -1, limit = 5000): Event[] {
    const rows = this.db
      .prepare('SELECT json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(runId, afterSeq, limit) as Row[]
    return rows.map((r) => Event.parse(JSON.parse(r.json as string)))
  }

  addArtifact(artifact: Artifact): void {
    const a = Artifact.parse(artifact)
    this.db
      .prepare('INSERT INTO artifacts (id, run_id, stage_id, kind, json) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, a.runId, a.stageId, a.kind, JSON.stringify(a))
  }

  listArtifacts(runId: string): Artifact[] {
    const rows = this.db.prepare('SELECT json FROM artifacts WHERE run_id = ?').all(runId) as Row[]
    return rows.map((r) => Artifact.parse(JSON.parse(r.json as string)))
  }

  close(): void {
    this.db.close()
  }
}

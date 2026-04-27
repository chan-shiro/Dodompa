import path from 'path'
import { app } from 'electron'
import fs from 'fs'
import Module from 'module'

// Native modules must be loaded with node's require, not vite's bundler
const nativeRequire = Module.createRequire(import.meta.url || __filename)
const Database = nativeRequire('better-sqlite3')

type DatabaseInstance = ReturnType<typeof Database>

let db: DatabaseInstance

export function getDb(): DatabaseInstance {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.')
  }
  return db
}

export function initDb(): DatabaseInstance {
  const dbDir = path.join(app.getPath('userData'), 'db')
  fs.mkdirSync(dbDir, { recursive: true })
  const dbPath = path.join(dbDir, 'app.db')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)
  return db
}

function runMigrations(database: DatabaseInstance): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      variables TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS step_logs (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      step_description TEXT,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'failed')),
      started_at DATETIME NOT NULL,
      finished_at DATETIME,
      page_url TEXT,
      page_title TEXT,
      screenshot_before_path TEXT,
      screenshot_path TEXT,
      html_snapshot_path TEXT,
      shared_state TEXT,
      error TEXT,
      FOREIGN KEY (execution_id) REFERENCES execution_logs(id)
    );

    CREATE TABLE IF NOT EXISTS ai_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step_id TEXT,
      type TEXT NOT NULL CHECK(type IN ('generation', 'fix', 'edit')),
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_used INTEGER,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_info (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL,
      label TEXT,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );

    CREATE TABLE IF NOT EXISTS generation_step_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      execution_id TEXT,
      step_id TEXT,
      phase TEXT NOT NULL,
      message TEXT NOT NULL,
      detail TEXT,
      screenshot_path TEXT,
      created_at DATETIME NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_execution_logs_task_id ON execution_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_step_logs_execution_id ON step_logs(execution_id);
    CREATE INDEX IF NOT EXISTS idx_ai_logs_task_id ON ai_logs(task_id);
    CREATE INDEX IF NOT EXISTS idx_generation_step_logs_task_id ON generation_step_logs(task_id);
  `)

  // Migration: add columns to step_logs if they don't exist yet
  const cols = database.prepare("PRAGMA table_info('step_logs')").all() as Array<{ name: string }>
  const colNames = new Set(cols.map((c) => c.name))
  const additions: [string, string][] = [
    ['step_description', 'TEXT'],
    ['page_url', 'TEXT'],
    ['page_title', 'TEXT'],
    ['screenshot_before_path', 'TEXT'],
    ['shared_state', 'TEXT'],
  ]
  for (const [col, type] of additions) {
    if (!colNames.has(col)) {
      database.exec(`ALTER TABLE step_logs ADD COLUMN ${col} ${type}`)
    }
  }

  // Migration: ai_logs.type CHECK constraint used to be IN ('generation','fix')
  // but we now also store 'edit' rows from ai:editStep. SQLite can't alter a
  // CHECK constraint in place, so we detect the old constraint and rebuild the
  // table if needed.
  const aiLogsSchema = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_logs'")
    .get() as { sql?: string } | undefined
  // Migration: add message_code / message_params to generation_step_logs
  const genCols = database.prepare("PRAGMA table_info('generation_step_logs')").all() as Array<{ name: string }>
  const genColNames = new Set(genCols.map((c) => c.name))
  if (!genColNames.has('message_code')) {
    database.exec(`ALTER TABLE generation_step_logs ADD COLUMN message_code TEXT`)
  }
  if (!genColNames.has('message_params')) {
    database.exec(`ALTER TABLE generation_step_logs ADD COLUMN message_params TEXT`)
  }

  if (aiLogsSchema?.sql && !aiLogsSchema.sql.includes("'edit'")) {
    database.exec(`
      BEGIN;
      CREATE TABLE ai_logs_new (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        step_id TEXT,
        type TEXT NOT NULL CHECK(type IN ('generation', 'fix', 'edit')),
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_used INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at DATETIME NOT NULL
      );
      INSERT INTO ai_logs_new SELECT * FROM ai_logs;
      DROP TABLE ai_logs;
      ALTER TABLE ai_logs_new RENAME TO ai_logs;
      CREATE INDEX IF NOT EXISTS idx_ai_logs_task_id ON ai_logs(task_id);
      COMMIT;
    `)
  }
}

const Database = require('better-sqlite3');
const { dbPath } = require('../main/paths');

let db = null;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  app_name      TEXT NOT NULL,
  goal          TEXT NOT NULL,
  user_role     TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'active',
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT,
  step_count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  step_number   INTEGER NOT NULL,
  instruction   TEXT NOT NULL,
  annotation_json TEXT,
  screenshot_path TEXT,
  on_track      INTEGER NOT NULL DEFAULT 1,
  timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_app ON sessions(app_name);
`;

function initDatabase() {
  db = new Database(dbPath);
  const statements = SCHEMA_SQL.split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (const stmt of statements) {
    db.exec(stmt + ';');
  }
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { initDatabase, getDb, closeDatabase };

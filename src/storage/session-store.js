const { getDb } = require('./database');
const crypto = require('node:crypto');

function generateId() {
  return crypto.randomUUID();
}

function createSession(appName, goal, userRole = '') {
  const db = getDb();
  const id = generateId();
  db.prepare(`
    INSERT INTO sessions (id, app_name, goal, user_role, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(id, appName, goal, userRole);
  return id;
}

function completeSession(id) {
  const db = getDb();
  db.prepare(`
    UPDATE sessions
    SET status = 'completed', completed_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

function abandonSession(id) {
  const db = getDb();
  db.prepare(`
    UPDATE sessions
    SET status = 'abandoned', completed_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

function saveStep(sessionId, step) {
  const db = getDb();
  db.prepare(`
    INSERT INTO steps (session_id, step_number, instruction, annotation_json, screenshot_path, on_track)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    step.stepNumber,
    step.instruction,
    step.annotation ? JSON.stringify(step.annotation) : null,
    step.screenshotPath || null,
    step.onTrack ? 1 : 0
  );

  // Update step count
  db.prepare(`
    UPDATE sessions SET step_count = ? WHERE id = ?
  `).run(step.stepNumber, sessionId);
}

function getSession(id) {
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return null;

  const steps = db.prepare(
    'SELECT * FROM steps WHERE session_id = ? ORDER BY step_number ASC'
  ).all(id);

  return {
    ...session,
    steps: steps.map(s => ({
      ...s,
      annotation: s.annotation_json ? JSON.parse(s.annotation_json) : null,
      onTrack: !!s.on_track,
    })),
  };
}

function listSessions(limit = 50, offset = 0) {
  const db = getDb();
  return db.prepare(`
    SELECT id, app_name, goal, user_role, status, started_at, completed_at, step_count
    FROM sessions
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

function getSessionsByApp(appName) {
  const db = getDb();
  return db.prepare(`
    SELECT id, app_name, goal, user_role, status, started_at, completed_at, step_count
    FROM sessions
    WHERE app_name = ?
    ORDER BY started_at DESC
  `).all(appName);
}

function deleteSession(id) {
  const db = getDb();
  db.prepare('DELETE FROM steps WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

module.exports = {
  createSession,
  completeSession,
  abandonSession,
  saveStep,
  getSession,
  listSessions,
  getSessionsByApp,
  deleteSession,
};

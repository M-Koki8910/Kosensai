const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const DB_PATH = path.join(ROOT, 'stamp.db');

function parseNGRulesFromEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return null;
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const m = raw.match(/NG_RULES\s*=\s*(\[[\s\S]*?\])/m);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr : null;
  } catch (e) {
    console.error('Failed to parse NG_RULES from .env', e);
    return null;
  }
}

function applyNGRulesArray(db, arr) {
  if (!Array.isArray(arr) || arr.length === 0) return;
  const selectByPattern = db.prepare('SELECT id, enabled FROM ng_rules WHERE pattern = ?');
  const insertStmt = db.prepare(`
    INSERT INTO ng_rules (pattern, is_regex, risk_score, enabled, description, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now', '+9 hours'))
  `);
  const updateStmt = db.prepare(`
    UPDATE ng_rules
    SET pattern = ?, is_regex = ?, risk_score = ?, description = ?, enabled = ?
    WHERE id = ?
  `);

  let changed = false;
  for (const r of arr) {
    try {
      const pattern = String(r.pattern || '').trim();
      if (!pattern) continue;
      const is_regex = r.is_regex ? 1 : 0;
      const risk_score = typeof r.risk_score === 'number' ? r.risk_score : (parseInt(r.risk_score || '10', 10) || 10);
      const description = r.description !== undefined ? String(r.description) : null;
      const enabledFromFile = r.enabled === undefined ? undefined : (r.enabled ? 1 : 0);

      const existing = selectByPattern.get(pattern);
      if (existing) {
        const enabledToUse = enabledFromFile === undefined ? existing.enabled : enabledFromFile;
        updateStmt.run(pattern, is_regex, risk_score, description, enabledToUse, existing.id);
        changed = true;
      } else {
        const enabledToUse = enabledFromFile === undefined ? 1 : enabledFromFile;
        insertStmt.run(pattern, is_regex, risk_score, enabledToUse, description);
        changed = true;
      }
    } catch (e) {
      console.error('Error processing NG rule entry', e);
    }
  }

  if (changed) console.log('NGルールを同期しました (scripts/apply-env-ng-rules.js)');
}

function main() {
  const arr = parseNGRulesFromEnvFile();
  if (!arr) {
    console.log('No NG_RULES found in .env');
    return;
  }

  const db = new DatabaseSync(DB_PATH);
  applyNGRulesArray(db, arr);
}

main();

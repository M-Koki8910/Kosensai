const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;

const STATIC_ROOT = __dirname;
const ENV_PATH = path.join(__dirname, '.env');
const SESSION_COOKIE_NAME = 'session_id';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const BODY_LIMIT_BYTES = 64 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

// 1. ロール定義変更
const ALLOWED_ROLES = [
  'administrator',
  'executivestaff',
  'staff',
  'company'
];

// 8. ROLE_PERMISSIONS追加
const ROLE_PERMISSIONS = {
  administrator: [
    'analytics.read',
    'users.read',
    'logs.read',
    'announcement.create',
    'announcement.manage'
  ],
  executivestaff: [
    'analytics.read',
    'logs.read',
    'announcement.create',
    'announcement.manage'
  ],
  staff: [
    'announcement.create'
  ],
  company: [
    'analytics.read'
  ]
};

const DENIED_STATIC_NAMES = new Set([
  '.env',
  'stamp.db',
  'server.js',
  'server.hardened.js',
  'package-lock.json',
]);
const DENIED_STATIC_EXTENSIONS = new Set([
  '.db',
  '.sqlite',
  '.sqlite3',
  '.env',
  '.pem',
  '.key',
]);

const loginAttempts = new Map();

if (fs.existsSync(ENV_PATH)) {
  const envContents = fs.readFileSync(ENV_PATH, 'utf8');
  envContents.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) return;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

const DB_PATH = path.join(__dirname, 'stamp.db');

const SYSTEM_ADMIN_USERNAME =
 process.env.SYSTEM_ADMIN_USERNAME || 'Administrator';
const SYSTEM_ADMIN_PASSWORD = 
  process.env.SYSTEM_ADMIN_PASSWORD || 'admin@J2337';

const LOCATION_LABELS = {
  entrance: '正門',
  museum: '展示ホール',
  stage: 'ステージ',
  shop: '模擬店エリア',
};

const db = new DatabaseSync(DB_PATH);

// 各種テーブル初期化
db.exec(`
  CREATE TABLE IF NOT EXISTS stamp_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stamp_id TEXT NOT NULL,
    stamp_name TEXT NOT NULL,
    session_id TEXT,
    user_agent TEXT,
    page TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// 5. user_permissions テーブルの追加
db.exec(`
  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INTEGER NOT NULL,
    permission TEXT NOT NULL,
    PRIMARY KEY (user_id, permission)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stamp_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stamp_id TEXT NOT NULL,
    stamp_name TEXT NOT NULL,
    session_id TEXT,
    user_agent TEXT,
    page TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    scope TEXT NOT NULL DEFAULT 'all',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'visitor',
    scope TEXT NOT NULL DEFAULT 'all',
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    username TEXT,
    session_id TEXT,
    user_agent TEXT,
    page TEXT,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// カラム存在チェック兼動的追加関数
function ensureColumn(tableName, columnDefinition) {
  const info = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = info.some(column => column.name === columnDefinition.name);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition.sql}`);
  }
}

ensureColumn('users', { name: 'role', sql: 'role TEXT NOT NULL DEFAULT "staff"' });
ensureColumn('users', { name: 'scope', sql: 'scope TEXT NOT NULL DEFAULT "all"' });
ensureColumn('sessions', { name: 'user_id', sql: 'user_id INTEGER' });
ensureColumn('sessions', { name: 'role', sql: 'role TEXT NOT NULL DEFAULT "visitor"' });
ensureColumn('sessions', { name: 'scope', sql: 'scope TEXT NOT NULL DEFAULT "all"' });
ensureColumn('sessions', { name: 'expires_at', sql: 'expires_at TEXT' });

// ============================================================================
// 掲示板・アナウンス機能用テーブル
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    risk_score INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS ng_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    is_regex BOOLEAN DEFAULT 0,
    risk_score INTEGER NOT NULL DEFAULT 10,
    enabled BOOLEAN DEFAULT 1,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS post_aggregations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    representative_post_id INTEGER NOT NULL,
    aggregated_post_ids TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    similarity_score REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(representative_post_id) REFERENCES posts(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS moderation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    admin_username TEXT,
    action TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(post_id) REFERENCES posts(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    importance TEXT NOT NULL DEFAULT 'normal',
    published_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// デフォルトNGルール同期
const defaultNGRules = [
  { pattern: 'https?://[^\\s]+', is_regex: 1, risk_score: 30, description: 'URL' },
  { pattern: '[\\w\\.-]+@[\\w\\.-]+\\.\\w+', is_regex: 1, risk_score: 25, description: 'Email address' },
  { pattern: '\\d{3}[-.]?\\d{3,4}[-.]?\\d{4}', is_regex: 1, risk_score: 20, description: 'Phone number' },
  { pattern: '@[\\w]+', is_regex: 1, risk_score: 15, description: 'SNS mention' },
];

function syncNGRules() {
  const existingRules = db.prepare(`
    SELECT id, pattern, is_regex, risk_score, description
    FROM ng_rules
    WHERE description IN ('URL', 'Email address', 'Phone number', 'SNS mention')
    ORDER BY description
  `).all();

  const defaultRuleMap = Object.fromEntries(defaultNGRules.map(r => [r.description, r]));
  const existingRuleMap = Object.fromEntries(existingRules.map(r => [r.description, r]));

  let needsSync = false;

  for (const rule of defaultNGRules) {
    if (!existingRuleMap[rule.description]) {
      needsSync = true;
      db.prepare(`
        INSERT INTO ng_rules (pattern, is_regex, risk_score, enabled, description)
        VALUES (?, ?, ?, 1, ?)
      `).run(rule.pattern, rule.is_regex, rule.risk_score, rule.description);
    }
  }

  for (const existing of existingRules) {
    if (!defaultRuleMap[existing.description]) {
      needsSync = true;
      db.prepare(`DELETE FROM ng_rules WHERE id = ?`).run(existing.id);
    }
  }

  if (needsSync) {
    console.log('NG判定ルールを再同期しました');
  }
}
syncNGRules();

// 定期自動モデレーション処理 (30秒ごと)
const AUTO_JUDGE_INTERVAL_MS = 30 * 1000;
const BATCH_SIZE = 50;

function autoJudgePosts() {
  try {
    const pendingPosts = db.prepare(`
      SELECT id, content, risk_score
      FROM posts
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    `).all(BATCH_SIZE);

    if (pendingPosts.length === 0) return;

    for (const post of pendingPosts) {
      const ngCheck = checkNGRules(post.content);
      const newStatus = calculatePostStatus(ngCheck.riskScore);

      db.prepare(`
        UPDATE posts
        SET status = ?, risk_score = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(newStatus, ngCheck.riskScore, post.id);

      if (newStatus === 'published') {
        aggregateSimilarPosts(post.id, 0.75);
      }

      logEvent('post_auto_judged', {
        detail: JSON.stringify({
          postId: post.id,
          oldStatus: 'pending',
          newStatus: newStatus,
          riskScore: ngCheck.riskScore
        })
      });
    }
    console.log(`[自動判定] ${pendingPosts.length}件の投稿を処理しました`);
  } catch (e) {
    console.error('[自動判定エラー]', e);
  }
}

setInterval(() => {
  autoJudgePosts();
}, AUTO_JUDGE_INTERVAL_MS);

// ============================================================================
// パスワード暗号化関連
// ============================================================================
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function legacyHashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch (error) {
    return false;
  }
}

function verifyPassword(password, storedHash) {
  const stored = String(storedHash || '');
  if (stored.startsWith('scrypt$')) {
    const [, salt, expectedHash] = stored.split('$');
    if (!salt || !expectedHash) return false;
    const actualHash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return timingSafeEqualHex(actualHash, expectedHash);
  }
  return timingSafeEqualHex(legacyHashPassword(password), stored);
}

function needsPasswordRehash(storedHash) {
  return !String(storedHash || '').startsWith('scrypt$');
}

// デフォルト管理者アカウント自動作成 相違点２
if (SYSTEM_ADMIN_USERNAME && SYSTEM_ADMIN_PASSWORD) {
  const systemAdminExists = db.prepare(`SELECT id FROM users WHERE username = ?`).get(SYSTEM_ADMIN_USERNAME);
  if (!systemAdminExists) {
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, role, scope)
      VALUES (?, ?, 'administrator', 'all')
    `).run(SYSTEM_ADMIN_USERNAME, hashPassword(SYSTEM_ADMIN_PASSWORD));

    // 管理者アカウントにも全権限を明示的に user_permissions に紐付け
    const adminId = result.lastInsertRowid;
    const insertPerm = db.prepare(`INSERT OR IGNORE INTO user_permissions (user_id, permission) VALUES (?, ?)`);
    ROLE_PERMISSIONS.administrator.forEach(p => insertPerm.run(adminId, p));

    console.log('System administrator account created');
  }
}

// ============================================================================
// ヘルパー・ユーティリティ関数
// ============================================================================


function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(data));
}

function getFilePath(urlPath) {
  if (urlPath === '/' || urlPath === '') {
    return path.join(STATIC_ROOT, 'index.html');
  }
  let clean;
  try {
    clean = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch (error) {
    return null;
  }
  const resolved = path.resolve(STATIC_ROOT, clean);
  const relative = path.relative(STATIC_ROOT, resolved);
  const fileName = path.basename(resolved);
  const ext = path.extname(resolved).toLowerCase();

  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    DENIED_STATIC_NAMES.has(fileName) ||
    DENIED_STATIC_EXTENSIONS.has(ext) ||
    relative.split(path.sep).includes('.git')
  ) {
    return null;
  }
  return resolved;
}

function serveStatic(res, filePath) {
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    }[ext] || 'text/plain; charset=utf-8';

    const headers = {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    };
    const existingSetCookie = res.getHeader && res.getHeader('Set-Cookie');
    if (existingSetCookie) headers['Set-Cookie'] = existingSetCookie;

    res.writeHead(200, headers);
    res.end(data);
  });
}

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true;
}

function buildSessionCookie(req, sessionId, options = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId || ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  if (options.clear) {
    parts.push('Max-Age=0');
  } else if (options.maxAgeSeconds) {
    parts.push(`Max-Age=${options.maxAgeSeconds}`);
  }
  return parts.join('; ');
}

function setCookie(res, cookie) {
  const prev = res.getHeader && res.getHeader('Set-Cookie');
  if (prev) {
    const merged = Array.isArray(prev) ? prev.concat(cookie) : [prev, cookie];
    res.setHeader('Set-Cookie', merged);
    return;
  }
  res.setHeader('Set-Cookie', cookie);
}

function getExpiresAt(ttlMs = SESSION_TTL_MS) {
  return new Date(Date.now() + ttlMs).toISOString();
}

function isExpired(expiresAt) {
  return !!expiresAt && new Date(expiresAt).getTime() <= Date.now();
}

function getClientKey(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(key) {
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter(ts => now - ts < LOGIN_WINDOW_MS);
  recent.push(now);
  loginAttempts.set(key, recent);
  return recent.length > LOGIN_MAX_ATTEMPTS;
}

function clearRateLimit(key) {
  loginAttempts.delete(key);
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const expected = new URL(`http://${req.headers.host || 'localhost'}`);
    const actual = new URL(origin);
    return actual.host === expected.host;
  } catch (error) {
    return false;
  }
}

function rejectCrossOriginWrite(req, res) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return false;
  if (isSameOrigin(req)) return false;
  sendJson(res, 403, { ok: false, error: 'Forbidden origin' });
  return true;
}

// 3. normalizeScope()をall対応にする
//相違点３
function normalizeScope(scope) {
  if (String(scope).trim().toLowerCase() === 'all') {
    return 'all';
  }
  const raw = Array.isArray(scope) ? scope : String(scope || '').split(',');
  const allowed = raw
    .map(item => String(item).trim())
    .filter(item => Object.prototype.hasOwnProperty.call(LOCATION_LABELS, item));

  return allowed.length ? Array.from(new Set(allowed)).join(',') : 'all'; // 2. デフォルトをallへ
}

function createVisitorSession(req, res) {
  try {
    const sessionId = crypto.randomUUID();
    const expiresAt = getExpiresAt();

    db.prepare(`
      INSERT INTO sessions (id, user_id, username, role, scope, expires_at)
      VALUES (?, NULL, 'anonymous', 'visitor', 'all', ?)
    `).run(sessionId, expiresAt);

    try {
      setCookie(res, buildSessionCookie(req, sessionId, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000)
      }));
    } catch (e) { /* ignore header error */ }

    return sessionId;
  } catch (e) {
    console.error('Visitor session creation failed', e);
    return null;
  }
}

function parseBody(req, callback) {
  let body = '';
  let size = 0;
  let tooLarge = false;

  req.on('data', chunk => {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    body += chunk.toString();
  });

  req.on('error', () => {
    callback(new Error(tooLarge ? 'Request body too large' : 'Request error'));
  });

  req.on('end', () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (error) {
      callback(error);
    }
  });
}

function getCookies(req) {
  const cookieHeader = req.headers.cookie || '';
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map(item => {
        const [key, ...rest] = item.trim().split('=');
        return [key, rest.join('=')];
      })
      .filter(([key]) => key)
  );
}

function getSessionUser(req) {
  const cookies = getCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const row = db.prepare(`
    SELECT user_id, username, role, scope, expires_at
    FROM sessions
    WHERE id = ?
  `).get(sessionId);

  if (row && isExpired(row.expires_at)) {
    db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return null;
  }
  return row || null;
}

function isAnonymousUser(user) {
  return user && user.username === 'anonymous' && user.role === 'visitor';
}

function logEvent(type, data = {}) {
  try {
    db.prepare(`
      INSERT INTO logs (type, username, session_id, user_agent, page, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(type),
      data.username || null,
      data.sessionId || null,
      data.userAgent || null,
      data.page || null,
      data.detail || null
    );
  } catch (e) {
    console.error('ログの記録に失敗しました', e);
  }
}
//相違点４
function requireSession(req, res, next) {
  const user = getSessionUser(req);
  if (!user || isAnonymousUser(user)) {
    return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
  }
  next(user);
}

function requireRole(req, res, role, next) {
  requireSession(req, res, (user) => {
    if (user.role !== role) {
      return sendJson(res, 403, { ok: false, error: 'Forbidden' });
    }
    next(user);
  });
}
//相違点５
// 7. 権限取得関数追加
function getUserPermissions(userId) {
  if (!userId) return [];
  return db.prepare(`
    SELECT permission
    FROM user_permissions
    WHERE user_id = ?
  `)
  .all(userId)
  .map(row => row.permission);
}

// 9. hasPermission追加 (ハイブリッド判定)
function hasPermission(user, permission) {
  const permissions = new Set(ROLE_PERMISSIONS[user.role] || []);
  
  // セッションに保持されている user_id を使って個別追加権限をマージ
  getUserPermissions(user.user_id).forEach(p => permissions.add(p));

  return permissions.has(permission);
}

function checkNGRules(content) {
  const rules = db.prepare(`
    SELECT id, pattern, is_regex, risk_score
    FROM ng_rules
    WHERE enabled = 1
    ORDER BY risk_score DESC
  `).all();

  let totalRiskScore = 0;
  const detectedRules = [];

  for (const rule of rules) {
    try {
      let isMatch = false;
      if (rule.is_regex) {
        try {
          isMatch = new RegExp(rule.pattern, 'i').test(content);
        } catch (e) {
          console.error(`Invalid regex pattern: ${rule.pattern}`, e);
        }
      } else {
        isMatch = content.toLowerCase().includes(rule.pattern.toLowerCase());
      }

      if (isMatch) {
        totalRiskScore += rule.risk_score;
        detectedRules.push(rule.id);
      }
    } catch (e) {
      console.error(`Error checking NG rule ${rule.id}`, e);
    }
  }
  return { riskScore: totalRiskScore, detectedRuleIds: detectedRules };
}

function calculatePostStatus(riskScore) {
  if (riskScore <= 0) return 'published';
  if (riskScore < 50) return 'published';
  if (riskScore < 100) return 'review';
  return 'rejected';
}

//相違点６
// 4. getScopeList()を全範囲対応にする
function getScopeList(scope) {
  if (!scope || scope === 'all') {
    return null;
  }
  return String(scope)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function aggregateSimilarPosts(newPostId, similarity = 0.7) {
  const newPost = db.prepare(`SELECT content FROM posts WHERE id = ?`).get(newPostId);
  if (!newPost) return;

  const recentPosts = db.prepare(`
    SELECT id, content FROM posts
    WHERE status = 'published'
    AND id < ?
    AND datetime(created_at) > datetime('now', '-1 hour')
    LIMIT 50
  `).all(newPostId);

  for (const post of recentPosts) {
    const sim = calculateSimilarity(newPost.content, post.content);
    if (sim >= similarity) {
      db.prepare(`
        INSERT OR IGNORE INTO post_aggregations
        (representative_post_id, aggregated_post_ids, count, similarity_score)
        VALUES (?, ?, 1, ?)
      `).run(post.id, JSON.stringify([newPostId]), sim);
      break;
    }
  }
}

function calculateSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  if (s1 === s2) return 1.0;

  const words1 = new Set(s1.split(/\s+/));
  const words2 = new Set(s2.split(/\s+/));
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

// スタンプID の正規化（LOCATION_LABELS に存在する値のみ許可）
function normalizeStampId(stampId) {
  const value = String(stampId || '').trim();
  return Object.prototype.hasOwnProperty.call(LOCATION_LABELS, value) ? value : null;
}

// ページパスの正規化（制御文字の除去・256文字に切り詰め）
function normalizePage(page) {
  return String(page || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 256);
}

// analytics.read 権限チェックミドルウェア
function requirePermission(req, res, permission, next) {
  requireSession(req, res, (user) => {
    if (!hasPermission(user, permission)) {
      return sendJson(res, 403, { ok: false, error: 'Forbidden' });
    }
    next(user);
  });
}

// サマリーデータ集計（scope フィルタリング対応）
function getSummary(user) {
  const scopeList = getScopeList(user && user.scope);

  const visits = db.prepare(`
    SELECT stamp_id, COUNT(*) AS count
    FROM stamp_visits
    GROUP BY stamp_id
  `).all();

  const clicks = db.prepare(`
    SELECT stamp_id, COUNT(*) AS count
    FROM stamp_clicks
    GROUP BY stamp_id
  `).all();

  const filteredVisits = scopeList
    ? visits.filter(item => scopeList.includes(item.stamp_id))
    : visits;

  const filteredClicks = scopeList
    ? clicks.filter(item => scopeList.includes(item.stamp_id))
    : clicks;

  const visitMap = Object.fromEntries(
    filteredVisits.map(item => [item.stamp_id, item.count])
  );
  const clickMap = Object.fromEntries(
    filteredClicks.map(item => [item.stamp_id, item.count])
  );

  return {
    locations: Object.keys(LOCATION_LABELS).map(stampId => ({
      stamp_id: stampId,
      stamp_name: LOCATION_LABELS[stampId],
      visits: visitMap[stampId] || 0,
      clicks: clickMap[stampId] || 0,
    })),
    totals: {
      visits: filteredVisits.reduce((sum, item) => sum + item.count, 0),
      clicks: filteredClicks.reduce((sum, item) => sum + item.count, 0),
    },
  };
}

// 投稿一覧クエリサブルーチン
function getPostsSub(filters = {}) {
  let query = `
    SELECT id, content, status, risk_score, created_at, updated_at
    FROM posts
    WHERE 1=1
  `;
  const params = [];

  if (filters.status) {
    query += ` AND status = ?`;
    params.push(filters.status);
  }

  if (filters.search) {
    query += ` AND content LIKE ?`;
    params.push(`%${filters.search}%`);
  }

  query += ` ORDER BY created_at DESC`;

  if (filters.limit) {
    query += ` LIMIT ?`;
    params.push(filters.limit);
  }

  return db.prepare(query).all(...params);
}

// 公開中アナウンス一覧取得サブルーチン
function getAnnouncementsSub() {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT id, title, content, importance, published_at, expires_at, created_at
    FROM announcements
    WHERE published_at <= ?
    AND expires_at > ?
    ORDER BY importance DESC, published_at DESC
  `).all(now, now);
}

// モデレーションログ記録
function logModerationAction(postId, admin, action, oldStatus, newStatus, reason = null) {
  db.prepare(`
    INSERT INTO moderation_logs
    (post_id, admin_username, action, old_status, new_status, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(postId, admin, action, oldStatus, newStatus, reason);
}

// ============================================================================
// HTTP サーバーコア・ルーティングルーチン
// ============================================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (rejectCrossOriginWrite(req, res)) return;

  // ログイン時以外の不要なセッションの蓄積を防ぐため、静的ファイル読み込み時のみ匿名を発行
  if (req.method === 'GET' && !pathname.startsWith('/api')) {
    const cookies = getCookies(req);
    if (!cookies[SESSION_COOKIE_NAME]) {
      createVisitorSession(req, res);
    }
  }

  // API: ログイン
  if (pathname === '/api/login' && req.method === 'POST') {
    const rateLimitKey = `login:${getClientKey(req)}`;
    if (isRateLimited(rateLimitKey)) {
      return sendJson(res, 429, { ok: false, error: 'Too many login attempts' });
    }

    parseBody(req, (error, payload) => {
      if (error) {
        return sendJson(res, 400, {
          ok: false,
          error: error.message === 'Request body too large' ? 'Request body too large' : 'Invalid JSON'
        });
      }

      const username = String(payload.username || '').trim();
      const password = String(payload.password || '');

      const user = db.prepare(`
        SELECT id, username, password_hash, role, scope
        FROM users
        WHERE username = ?
      `).get(username);

      if (!user || !verifyPassword(password, user.password_hash)) {
        logEvent('login_failed', {
          username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: 'invalid_credentials'
        });
        return sendJson(res, 401, { ok: false, error: 'Invalid credentials' });
      }

      if (user.role === 'staff') {
        logEvent('login_blocked_staff', {
          username: user.username,
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
      });

  return sendJson(res, 403, {
    ok: false,
    error: 'Staff users cannot log in'
  });
}

      clearRateLimit(rateLimitKey);

      if (needsPasswordRehash(user.password_hash)) {
        db.prepare(`
          UPDATE users
          SET password_hash = ?
          WHERE username = ?
        `).run(hashPassword(password), user.username);
      }

      const sessionId = crypto.randomUUID();
      const expiresAt = getExpiresAt();

      db.prepare(`
        INSERT INTO sessions (id, user_id, username, role, scope, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        user.id,
        user.username,
        user.role,
        user.scope || 'all',
        expiresAt
      );

      logEvent('login', {
        username: user.username,
        sessionId,
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'login_success'
      });

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Set-Cookie': buildSessionCookie(req, sessionId, {
          maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000)
        }),
      });

      res.end(JSON.stringify({
        ok: true,
        username: user.username,
        role: user.role,
        scope: user.scope,
        // ★ここから追加
        permissions: (() => {
          const rolePerms = ROLE_PERMISSIONS[user.role] || [];
          const userPerms = getUserPermissions(user.id);
          return [...new Set([...rolePerms, ...userPerms])];
        })()
        }));
    });
    return;
  }

  // API: ログアウト
  if (pathname === '/api/logout' && req.method === 'POST') {
    const sessionId = getCookies(req)[SESSION_COOKIE_NAME];
    const row = sessionId ? db.prepare(`SELECT username FROM sessions WHERE id = ?`).get(sessionId) : null;

    if (sessionId) {
      db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    }

    logEvent('logout', {
      username: row && row.username,
      sessionId,
      userAgent: req.headers['user-agent'] || '',
      page: pathname,
      detail: 'logout'
    });

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Set-Cookie': buildSessionCookie(req, '', { clear: true }),
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // API: 認証状態取得 (me)
  if (pathname === '/api/auth/me') {
    const user = getSessionUser(req);
    const isAuthenticated = user && !isAnonymousUser(user);

    sendJson(res, isAuthenticated ? 200 : 401, {
      ok: !!isAuthenticated,
      username: isAuthenticated && user.username,
      role: isAuthenticated && user.role,
      scope: isAuthenticated && user.scope,
      permissions: isAuthenticated ? getUserPermissions(user.user_id) : []//相違点６
    });
    return;
  }

  // API: ユーザー一覧取得 (GET)
  if (pathname === '/api/auth/users' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const users = db.prepare(`
        SELECT id, username, role, scope, created_at
        FROM users
        ORDER BY id
      `).all();

      // 各ユーザーに個別の権限配列をマージしてフロントへ返す相違点７
      const usersWithPermissions = users.map(u => ({
        ...u,
        permissions: getUserPermissions(u.id)
      }));


      logEvent('admin_access', {
        username: user && user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_users'
      });

      sendJson(res, 200, { ok: true, users: usersWithPermissions });
    });
    return;
  }

  // API: ユーザー作成 (POST)
  if (pathname === '/api/auth/users' && req.method === 'POST') {
    requireRole(req, res, 'administrator', (user) => {
      parseBody(req, (error, payload) => {
        if (error) {
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
        }

        // 1 & 6. ロール定義変更、デフォルトの決定　相違点８
        const newUsername = String(payload.username || '').trim();
        const password = String(payload.password || '');
        const role = String(payload.role || 'staff').toLowerCase();
        const scope = normalizeScope(payload.scope || 'all');

        // 6. 権限アレイの担保
        const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];

        if (!newUsername || !password) {
          return sendJson(res, 400, { ok: false, error: 'username and password are required' });
        }
        if (!/^[A-Za-z0-9_.-]{3,64}$/.test(newUsername)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid username' });
        }
        if (password.length < 4) {
          return sendJson(res, 400, { ok: false, error: 'Password must be at least 4 characters' });
        }
        if (!ALLOWED_ROLES.includes(role)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid role assignment' });
        }

        // 10. companyのみscopeを使い、それ以外はallとする
        const finalScope = (role === 'company') ? scope : 'all';

        try {
          const insertUser = db.prepare(`
            INSERT INTO users (username, password_hash, role, scope)
            VALUES (?, ?, ?, ?)
          `);
          //相違点９
          const result = insertUser.run(
            newUsername,
            hashPassword(password),
            role,
            finalScope
          );

          // 6. ユーザーINSERT直後の独自 Permission 保存対応
          const userId = result.lastInsertRowid;
          const insertPermission = db.prepare(`
            INSERT OR IGNORE INTO user_permissions (user_id, permission)
            VALUES (?, ?)
          `);

          for (const permission of permissions) {
            insertPermission.run(userId, permission);
          }

          logEvent('user_created', {
            username: user.username,
            sessionId: getCookies(req)[SESSION_COOKIE_NAME],
            userAgent: req.headers['user-agent'] || '',
            page: pathname,
            detail: `created_user:${newUsername}`
          });

          sendJson(res, 200, { ok: true, userId });
        } catch (e) {//相違点１０
          if (e.message && e.message.includes('UNIQUE constraint failed')) {
            return sendJson(res, 400, { ok: false, error: 'Username already exists' });
          }
          console.error(e);
          sendJson(res, 500, { ok: false, error: 'Internal server error' });
        }
      });
    });
    return;
  }
  //ここ以降ない

  if (pathname.startsWith('/api/auth/users/') && req.method === 'DELETE') {
    requireRole(req, res, 'administrator', (user) => {
      const targetUsername = decodeURIComponent(
        pathname.split('/').filter(Boolean).pop() || ''
      );

      if (!targetUsername) {
        return sendJson(res, 400, { ok: false, error: 'username is required' });
      }

      if (targetUsername === SYSTEM_ADMIN_USERNAME) {
        return sendJson(res, 403, { ok: false, error: '固定管理者アカウントは削除できません' });
      }

      // セッションを先に削除（参照整合性の確保）
      db.prepare(`DELETE FROM sessions WHERE username = ?`).run(targetUsername);

      // user_permissions も削除（変更後スクリプトで追加されたテーブル）
      const target = db.prepare(`SELECT id FROM users WHERE username = ?`).get(targetUsername);
      if (target) {
        db.prepare(`DELETE FROM user_permissions WHERE user_id = ?`).run(target.id);
      }

      const info = db.prepare(`DELETE FROM users WHERE username = ?`).run(targetUsername);

      if (info.changes === 0) {
        return sendJson(res, 404, { ok: false, error: 'User not found' });
      }

      logEvent('user_deleted', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ target: targetUsername })
      });

      sendJson(res, 200, { ok: true, username: targetUsername });
    });
    return;
  }

  // POST /api/auth/change-password
  // パスワード変更（ログイン済みユーザー本人）
  if (pathname === '/api/auth/change-password' && req.method === 'POST') {
    requireSession(req, res, (user) => {
      parseBody(req, (error, payload) => {
        if (error) {
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
        }

        const current = String(payload.current_password || '');
        const next = String(payload.new_password || '');

        if (!current || !next) {
          return sendJson(res, 400, {
            ok: false,
            error: 'current_password and new_password are required'
          });
        }

        const row = db.prepare(`
          SELECT password_hash FROM users WHERE username = ?
        `).get(user.username);

        if (!row) {
          return sendJson(res, 404, { ok: false, error: 'User not found' });
        }

        if (!verifyPassword(current, row.password_hash)) {
          return sendJson(res, 403, { ok: false, error: 'Current password is incorrect' });
        }

        if (next.length < 12) {
          return sendJson(res, 400, {
            ok: false,
            error: 'New password must be at least 12 characters'
          });
        }

        db.prepare(`
          UPDATE users SET password_hash = ? WHERE username = ?
        `).run(hashPassword(next), user.username);

        // パスワード変更後は他のセッションを無効化（現在のセッションは維持）
        const currentSessionId = getCookies(req)[SESSION_COOKIE_NAME];
        db.prepare(`
          DELETE FROM sessions WHERE username = ? AND id <> ?
        `).run(user.username, currentSessionId || '');

        logEvent('password_change', {
          username: user.username,
          sessionId: currentSessionId,
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: 'password_changed'
        });

        sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // スタンプ
  // ─────────────────────────────────────────────────────────────────────────

  // POST /api/stamp-event
  // スタンプイベント記録（visit / click / jump）
  // 注: 変更後スクリプトでは静的GETリクエスト時のみ匿名セッションを発行するため、
  //     issuedSessionId は削除し、Cookie セッションのみ参照する。
  if (pathname === '/api/stamp-event' && req.method === 'POST') {
    parseBody(req, (error, payload) => {
      if (error) {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
      }

      const type = String(payload.type || '').toLowerCase();
      const stampId = normalizeStampId(payload.stampId);

      if (!stampId) {
        return sendJson(res, 400, { ok: false, error: 'Invalid stampId' });
      }

      const sessionId = String(getCookies(req)[SESSION_COOKIE_NAME] || '');
      const page = normalizePage(payload.page);
      const userAgent = String(req.headers['user-agent'] || '').slice(0, 512);
      const stampName = LOCATION_LABELS[stampId];

      if (type === 'visit') {
        db.prepare(`
          INSERT INTO stamp_visits (stamp_id, stamp_name, session_id, user_agent, page)
          VALUES (?, ?, ?, ?, ?)
        `).run(stampId, stampName, sessionId || null, userAgent, page || null);

        logEvent('stamp_visit', {
          sessionId,
          userAgent,
          page,
          detail: JSON.stringify({ stampId, stampName })
        });

        return sendJson(res, 200, { ok: true });
      }

      // click / jump はどちらも stamp_clicks に記録（後方互換）
      if (type === 'click' || type === 'jump') {
        db.prepare(`
          INSERT INTO stamp_clicks (stamp_id, stamp_name, session_id, user_agent, page)
          VALUES (?, ?, ?, ?, ?)
        `).run(stampId, stampName, sessionId || null, userAgent, page || null);

        logEvent(`stamp_${type}`, {
          sessionId,
          userAgent,
          page,
          detail: JSON.stringify({ stampId, stampName })
        });

        return sendJson(res, 200, { ok: true });
      }

      sendJson(res, 400, { ok: false, error: 'Unknown type' });
    });
    return;
  }

  // GET /api/stamp-history
  // スタンプ履歴取得
  // ・管理者: 全件
  // ・認証済みユーザー: 自分のセッション分のみ
  // ・未認証: Cookie セッション分のみ
  if (pathname === '/api/stamp-history' && req.method === 'GET') {
    const targetSessionId = getCookies(req)[SESSION_COOKIE_NAME] || null;
    const authUser = getSessionUser(req);

    if (authUser && !isAnonymousUser(authUser) && authUser.role === 'administrator') {
      const visits = db.prepare(`
        SELECT sv.*, s.username
        FROM stamp_visits sv
        LEFT JOIN sessions s ON sv.session_id = s.id
        ORDER BY sv.id DESC LIMIT 1000
      `).all();
      const clicks = db.prepare(`
        SELECT sc.*, s.username
        FROM stamp_clicks sc
        LEFT JOIN sessions s ON sc.session_id = s.id
        ORDER BY sc.id DESC LIMIT 1000
      `).all();
      return sendJson(res, 200, { ok: true, visits, clicks });
    }

    if (authUser && !isAnonymousUser(authUser)) {
      const sessions = db.prepare(`SELECT id FROM sessions WHERE username = ?`)
        .all(authUser.username).map(r => r.id);

      if (!sessions.length) {
        return sendJson(res, 200, { ok: true, visits: [], clicks: [] });
      }

      const placeholders = sessions.map(() => '?').join(',');
      const visits = db.prepare(`
        SELECT sv.*, s.username FROM stamp_visits sv
        LEFT JOIN sessions s ON sv.session_id = s.id
        WHERE sv.session_id IN (${placeholders})
        ORDER BY sv.id DESC LIMIT 1000
      `).all(...sessions);
      const clicks = db.prepare(`
        SELECT sc.*, s.username FROM stamp_clicks sc
        LEFT JOIN sessions s ON sc.session_id = s.id
        WHERE sc.session_id IN (${placeholders})
        ORDER BY sc.id DESC LIMIT 1000
      `).all(...sessions);

      return sendJson(res, 200, { ok: true, visits, clicks });
    }

    if (!targetSessionId) {
      return sendJson(res, 400, { ok: false, error: 'sessionId is required' });
    }

    const visits = db.prepare(`
      SELECT sv.*, s.username FROM stamp_visits sv
      LEFT JOIN sessions s ON sv.session_id = s.id
      WHERE sv.session_id = ?
      ORDER BY sv.id DESC LIMIT 1000
    `).all(targetSessionId);
    const clicks = db.prepare(`
      SELECT sc.*, s.username FROM stamp_clicks sc
      LEFT JOIN sessions s ON sc.session_id = s.id
      WHERE sc.session_id = ?
      ORDER BY sc.id DESC LIMIT 1000
    `).all(targetSessionId);

    return sendJson(res, 200, { ok: true, visits, clicks });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 管理 API（サマリー・イベント・ログ）
  // ─────────────────────────────────────────────────────────────────────────

  // GET /api/admin/summary
  // analytics.read 権限で参照可能（administrator / executivestaff / company）
  if (pathname === '/api/admin/summary' && req.method === 'GET') {
    requirePermission(req, res, 'analytics.read', (user) => {
      logEvent('admin_access', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_summary'
      });

      sendJson(res, 200, getSummary(user));
    });
    return;
  }

  // GET /api/admin/events
  // analytics.read 権限で参照可能。
  // 注: sessions.demographic カラムは変更後スクリプトで ensureColumn が削除されたため、
  //     JOIN クエリから除去している。
  if (pathname === '/api/admin/events' && req.method === 'GET') {
    requirePermission(req, res, 'analytics.read', (user) => {
      const scopeList = getScopeList(user.scope);

      if (user.role === 'administrator') {
        const visits = db.prepare(`
          SELECT sv.*, s.username
          FROM stamp_visits sv
          LEFT JOIN sessions s ON sv.session_id = s.id
          ORDER BY sv.id DESC LIMIT 100
        `).all();
        const clicks = db.prepare(`
          SELECT sc.*, s.username
          FROM stamp_clicks sc
          LEFT JOIN sessions s ON sc.session_id = s.id
          ORDER BY sc.id DESC LIMIT 100
        `).all();

        logEvent('admin_access', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: 'view_events'
        });

        return sendJson(res, 200, { visits, clicks });
      }

      // 非管理者は scope で絞る
      const visitsAll = db.prepare(`
        SELECT sv.*, s.username
        FROM stamp_visits sv
        LEFT JOIN sessions s ON sv.session_id = s.id
        ORDER BY sv.id DESC LIMIT 1000
      `).all();
      const clicksAll = db.prepare(`
        SELECT sc.*, s.username
        FROM stamp_clicks sc
        LEFT JOIN sessions s ON sc.session_id = s.id
        ORDER BY sc.id DESC LIMIT 1000
      `).all();

      const visits = visitsAll.filter(item => !scopeList || scopeList.includes(item.stamp_id));
      const clicks = clicksAll.filter(item => !scopeList || scopeList.includes(item.stamp_id));

      logEvent('admin_access', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_events'
      });

      sendJson(res, 200, { visits, clicks });
    });
    return;
  }

  // DELETE /api/admin/events
  // イベント削除（管理者のみ）
  if (pathname === '/api/admin/events' && req.method === 'DELETE') {
    requireRole(req, res, 'administrator', (user) => {
      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const target = String((payload && payload.target) || 'all');

        if (target === 'visits') {
          db.prepare(`DELETE FROM stamp_visits`).run();
        } else if (target === 'clicks') {
          db.prepare(`DELETE FROM stamp_clicks`).run();
        } else {
          db.prepare(`DELETE FROM stamp_visits`).run();
          db.prepare(`DELETE FROM stamp_clicks`).run();
        }

        logEvent('admin_delete_events', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ target })
        });

        sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // GET /api/admin/logs
  // logs.read 権限で参照可能（administrator / executivestaff）
  if (pathname === '/api/admin/logs' && req.method === 'GET') {
    requirePermission(req, res, 'logs.read', (user) => {
      const logs = db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT 500`).all();
      sendJson(res, 200, { ok: true, logs });
    });
    return;
  }

  // DELETE /api/admin/logs
  // ログ削除（管理者のみ）
  if (pathname === '/api/admin/logs' && req.method === 'DELETE') {
    requireRole(req, res, 'administrator', (user) => {
      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        if (payload && payload.before) {
          db.prepare(`DELETE FROM logs WHERE created_at < ?`).run(payload.before);
        } else {
          db.prepare(`DELETE FROM logs`).run();
        }

        logEvent('admin_delete_logs', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ before: (payload && payload.before) || null })
        });

        sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 掲示板 API
  // ─────────────────────────────────────────────────────────────────────────

  // POST /api/posts
  // 投稿作成（匿名可）
  if (pathname === '/api/posts' && req.method === 'POST') {
    parseBody(req, (err, payload) => {
      if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

      const content = String(payload.content || '').trim();
      if (!content) {
        return sendJson(res, 400, { ok: false, error: 'Content is required' });
      }
      if (content.length > 500) {
        return sendJson(res, 400, { ok: false, error: 'Content is too long (max 500 chars)' });
      }

      const ngCheck = checkNGRules(content);
      const status = calculatePostStatus(ngCheck.riskScore);

      const result = db.prepare(`
        INSERT INTO posts (content, status, risk_score) VALUES (?, ?, ?)
      `).run(content, status, ngCheck.riskScore);

      logEvent('post_created', {
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ postId: result.lastInsertRowid, status })
      });

      return sendJson(res, 201, {
        ok: true,
        message: '投稿を受け付けました',
        postId: result.lastInsertRowid,
        status
      });
    });
    return;
  }

  // GET /api/posts
  // 投稿一覧（公開済みのみ・認証不要）
  if (pathname === '/api/posts' && req.method === 'GET') {
    const status = url.searchParams.get('status') || 'published';
    const search = url.searchParams.get('search') || '';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const posts = getPostsSub({
      status: status === 'all' ? null : status,
      search,
      limit
    });

    return sendJson(res, 200, { ok: true, posts });
  }

  // PATCH /api/admin/posts/:id/status
  // 投稿ステータス変更（announcement.manage 権限）
  if (pathname.match(/^\/api\/admin\/posts\/(\d+)\/status$/) && req.method === 'PATCH') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const match = pathname.match(/^\/api\/admin\/posts\/(\d+)\/status$/);
      const postId = parseInt(match[1], 10);

      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const newStatus = String(payload.status || '').toLowerCase();
        if (!['published', 'review', 'rejected', 'hidden'].includes(newStatus)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid status' });
        }

        const post = db.prepare(`SELECT status FROM posts WHERE id = ?`).get(postId);
        if (!post) {
          return sendJson(res, 404, { ok: false, error: 'Post not found' });
        }

        db.prepare(`
          UPDATE posts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `).run(newStatus, postId);

        logModerationAction(postId, user.username, 'status_change', post.status, newStatus, payload.reason);

        logEvent('post_status_changed', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ postId, oldStatus: post.status, newStatus })
        });

        return sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // GET /api/admin/posts
  // 投稿一覧（全ステータス・announcement.manage 権限）
  if (pathname === '/api/admin/posts' && req.method === 'GET') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const status = url.searchParams.get('status') || '';
      const search = url.searchParams.get('search') || '';
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);

      let query = `
        SELECT id, content, status, risk_score, created_at, updated_at
        FROM posts WHERE 1=1
      `;
      const params = [];

      if (status) { query += ` AND status = ?`; params.push(status); }
      if (search) { query += ` AND content LIKE ?`; params.push(`%${search}%`); }

      query += ` ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      const posts = db.prepare(query).all(...params);

      logEvent('admin_access', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_posts'
      });

      return sendJson(res, 200, { ok: true, posts });
    });
    return;
  }

  // GET /api/admin/moderation-logs
  // モデレーションログ参照（announcement.manage 権限）
  if (pathname === '/api/admin/moderation-logs' && req.method === 'GET') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const postId = url.searchParams.get('postId');
      let query = `SELECT * FROM moderation_logs WHERE 1=1`;
      const params = [];

      if (postId) {
        query += ` AND post_id = ?`;
        params.push(parseInt(postId, 10));
      }

      query += ` ORDER BY created_at DESC LIMIT 200`;
      const logs = db.prepare(query).all(...params);

      return sendJson(res, 200, { ok: true, logs });
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // アナウンス API
  // ─────────────────────────────────────────────────────────────────────────

  // GET /api/announcements
  // 公開中アナウンス一覧（認証不要）
  if (pathname === '/api/announcements' && req.method === 'GET') {
    const announcements = getAnnouncementsSub();
    return sendJson(res, 200, { ok: true, announcements });
  }

  // POST /api/announcements
  // アナウンス作成。
  // 変更後スクリプトで announcement_users テーブルが廃止されたため、
  // announcement.create パーミッションを持つセッションユーザーのみ投稿可能。
  if (pathname === '/api/announcements' && req.method === 'POST') {
    requirePermission(req, res, 'announcement.create', (user) => {
      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const title = String(payload.title || '').trim();
        const content = String(payload.content || '').trim();
        const importance = String(payload.importance || 'normal').toLowerCase();
        const publishedAt = String(payload.published_at || '');
        const expiresAt = String(payload.expires_at || '');

        if (!title || !content || !publishedAt || !expiresAt) {
          return sendJson(res, 400, { ok: false, error: 'Missing required fields' });
        }

        if (!['normal', 'important', 'urgent'].includes(importance)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid importance value' });
        }

        const result = db.prepare(`
          INSERT INTO announcements (title, content, importance, published_at, expires_at, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(title, content, importance, publishedAt, expiresAt, user.username);

        logEvent('announcement_created', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ announcementId: result.lastInsertRowid })
        });

        return sendJson(res, 201, { ok: true, announcementId: result.lastInsertRowid });
      });
    });
    return;
  }

  // GET /api/admin/announcements
  // 全アナウンス一覧（announcement.manage 権限）
  if (pathname === '/api/admin/announcements' && req.method === 'GET') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const announcements = db.prepare(`
        SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100
      `).all();

      return sendJson(res, 200, { ok: true, announcements });
    });
    return;
  }

  // PATCH /api/admin/announcements/:id
  // アナウンス編集（announcement.manage 権限）
  if (pathname.match(/^\/api\/admin\/announcements\/(\d+)$/) && req.method === 'PATCH') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const match = pathname.match(/^\/api\/admin\/announcements\/(\d+)$/);
      const id = parseInt(match[1], 10);

      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const announcement = db.prepare(`SELECT * FROM announcements WHERE id = ?`).get(id);
        if (!announcement) {
          return sendJson(res, 404, { ok: false, error: 'Announcement not found' });
        }

        const title = payload.title !== undefined ? String(payload.title) : announcement.title;
        const content = payload.content !== undefined ? String(payload.content) : announcement.content;
        const importance = payload.importance !== undefined ? String(payload.importance) : announcement.importance;
        const expiresAt = payload.expires_at !== undefined ? String(payload.expires_at) : announcement.expires_at;

        db.prepare(`
          UPDATE announcements
          SET title = ?, content = ?, importance = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(title, content, importance, expiresAt, id);

        logEvent('announcement_updated', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ announcementId: id })
        });

        return sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // DELETE /api/admin/announcements/:id
  // アナウンス削除（announcement.manage 権限）
  if (pathname.match(/^\/api\/admin\/announcements\/(\d+)$/) && req.method === 'DELETE') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const match = pathname.match(/^\/api\/admin\/announcements\/(\d+)$/);
      const id = parseInt(match[1], 10);

      const announcement = db.prepare(`SELECT * FROM announcements WHERE id = ?`).get(id);
      if (!announcement) {
        return sendJson(res, 404, { ok: false, error: 'Announcement not found' });
      }

      db.prepare(`DELETE FROM announcements WHERE id = ?`).run(id);

      logEvent('announcement_deleted', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ announcementId: id })
      });

      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NGルール管理 API（管理者のみ）
  // ─────────────────────────────────────────────────────────────────────────

  // GET /api/admin/ng-rules - ルール一覧
  if (pathname === '/api/admin/ng-rules' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const rules = db.prepare(`
        SELECT id, pattern, is_regex, risk_score, enabled, description, created_at
        FROM ng_rules
        ORDER BY risk_score DESC, created_at DESC
      `).all();

      return sendJson(res, 200, { ok: true, rules });
    });
    return;
  }

  // POST /api/admin/ng-rules/test - NG判定テスト（個別ルートより先に定義）
  if (pathname === '/api/admin/ng-rules/test' && req.method === 'POST') {
    requireRole(req, res, 'administrator', (user) => {
      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const content = String(payload.content || '').trim();
        if (!content) {
          return sendJson(res, 400, { ok: false, error: 'Content is required' });
        }

        const rules = db.prepare(`
          SELECT id, pattern, is_regex, risk_score, description
          FROM ng_rules WHERE enabled = 1
          ORDER BY risk_score DESC
        `).all();

        const matches = [];
        let totalRiskScore = 0;

        for (const rule of rules) {
          try {
            let isMatch = false;
            if (rule.is_regex) {
              try { isMatch = new RegExp(rule.pattern, 'i').test(content); }
              catch (e) { console.error(`Invalid regex pattern: ${rule.pattern}`, e); }
            } else {
              isMatch = content.toLowerCase().includes(rule.pattern.toLowerCase());
            }

            if (isMatch) {
              matches.push({
                id: rule.id,
                pattern: rule.pattern,
                is_regex: rule.is_regex,
                risk_score: rule.risk_score,
                description: rule.description
              });
              totalRiskScore += rule.risk_score;
            }
          } catch (e) {
            console.error(`Error checking NG rule ${rule.id}`, e);
          }
        }

        const status = calculatePostStatus(totalRiskScore);

        return sendJson(res, 200, {
          ok: true,
          matches,
          totalRiskScore,
          status,
          preview: `ステータス: ${status} (危険度スコア: ${totalRiskScore})`
        });
      });
    });
    return;
  }

  // GET /api/admin/ng-rules/:id - ルール詳細
  if (pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/) && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/);
      const id = parseInt(match[1], 10);

      const rule = db.prepare(`
        SELECT id, pattern, is_regex, risk_score, enabled, description, created_at
        FROM ng_rules WHERE id = ?
      `).get(id);

      if (!rule) return sendJson(res, 404, { ok: false, error: 'Rule not found' });

      return sendJson(res, 200, { ok: true, rule });
    });
    return;
  }

  // POST /api/admin/ng-rules - ルール追加
  if (pathname === '/api/admin/ng-rules' && req.method === 'POST') {
    requireRole(req, res, 'administrator', (user) => {
      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const pattern = String(payload.pattern || '').trim();
        const isRegex = payload.is_regex ? 1 : 0;
        const riskScore = parseInt(payload.risk_score || 0, 10);
        const description = String(payload.description || '').trim();

        if (!pattern) {
          return sendJson(res, 400, { ok: false, error: 'Pattern is required' });
        }
        if (riskScore < 0 || riskScore > 100) {
          return sendJson(res, 400, { ok: false, error: 'Risk score must be between 0 and 100' });
        }
        if (isRegex) {
          try { new RegExp(pattern); }
          catch (e) { return sendJson(res, 400, { ok: false, error: 'Invalid regex pattern' }); }
        }

        const result = db.prepare(`
          INSERT INTO ng_rules (pattern, is_regex, risk_score, enabled, description)
          VALUES (?, ?, ?, 1, ?)
        `).run(pattern, isRegex, riskScore, description);

        logEvent('ng_rule_created', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ ruleId: result.lastInsertRowid, pattern })
        });

        return sendJson(res, 201, { ok: true, ruleId: result.lastInsertRowid });
      });
    });
    return;
  }

  // PATCH /api/admin/ng-rules/:id - ルール編集
  if (pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/) && req.method === 'PATCH') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/);
      const id = parseInt(match[1], 10);

      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const rule = db.prepare(`SELECT * FROM ng_rules WHERE id = ?`).get(id);
        if (!rule) return sendJson(res, 404, { ok: false, error: 'Rule not found' });

        const pattern = payload.pattern !== undefined ? String(payload.pattern).trim() : rule.pattern;
        const isRegex = payload.is_regex !== undefined ? (payload.is_regex ? 1 : 0) : rule.is_regex;
        const riskScore = payload.risk_score !== undefined ? parseInt(payload.risk_score, 10) : rule.risk_score;
        const description = payload.description !== undefined ? String(payload.description).trim() : rule.description;

        if (!pattern) {
          return sendJson(res, 400, { ok: false, error: 'Pattern cannot be empty' });
        }
        if (riskScore < 0 || riskScore > 100) {
          return sendJson(res, 400, { ok: false, error: 'Risk score must be between 0 and 100' });
        }
        if (isRegex) {
          try { new RegExp(pattern); }
          catch (e) { return sendJson(res, 400, { ok: false, error: 'Invalid regex pattern' }); }
        }

        db.prepare(`
          UPDATE ng_rules
          SET pattern = ?, is_regex = ?, risk_score = ?, description = ?
          WHERE id = ?
        `).run(pattern, isRegex, riskScore, description, id);

        logEvent('ng_rule_updated', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ ruleId: id })
        });

        return sendJson(res, 200, { ok: true });
      });
    });
    return;
  }

  // DELETE /api/admin/ng-rules/:id - ルール削除
  if (pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/) && req.method === 'DELETE') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/);
      const id = parseInt(match[1], 10);

      const rule = db.prepare(`SELECT * FROM ng_rules WHERE id = ?`).get(id);
      if (!rule) return sendJson(res, 404, { ok: false, error: 'Rule not found' });

      db.prepare(`DELETE FROM ng_rules WHERE id = ?`).run(id);

      logEvent('ng_rule_deleted', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ ruleId: id, pattern: rule.pattern })
      });

      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  // POST /api/admin/ng-rules/:id/toggle - 有効/無効切り替え
  if (pathname.match(/^\/api\/admin\/ng-rules\/(\d+)\/toggle$/) && req.method === 'POST') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/ng-rules\/(\d+)\/toggle$/);
      const id = parseInt(match[1], 10);

      const rule = db.prepare(`SELECT * FROM ng_rules WHERE id = ?`).get(id);
      if (!rule) return sendJson(res, 404, { ok: false, error: 'Rule not found' });

      const newEnabled = rule.enabled ? 0 : 1;
      db.prepare(`UPDATE ng_rules SET enabled = ? WHERE id = ?`).run(newEnabled, id);

      logEvent('ng_rule_toggled', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ ruleId: id, newEnabled })
      });

      return sendJson(res, 200, { ok: true, enabled: newEnabled });
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 静的ファイルアクセスのログ記録
  // （直後に serveStatic を配置すること）
  // ─────────────────────────────────────────────────────────────────────────
  try {
    if (req.method === 'GET' && !pathname.startsWith('/api')) {
      const session = getSessionUser(req);
      logEvent('site_access', {
        username: session && session.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: null
      });
    }
  } catch (e) {
    /* logging errors は無視 */
  }

  // 静的ファイル配信
  serveStatic(res, getFilePath(pathname));
});

// サーバー起動
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});
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
const ALLOWED_ROLES = ['administrator', 'senior'];
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

// ルートに置かれた stamp.db を参照する。
const DB_PATH = path.join(__dirname, 'stamp.db');

const SYSTEM_ADMIN_USERNAME =
  process.env.SYSTEM_ADMIN_USERNAME /*|| 'Administrator'*/;
const SYSTEM_ADMIN_PASSWORD =
  process.env.SYSTEM_ADMIN_PASSWORD /*|| 'admin@J2337'*/;

const LOCATION_LABELS = {
  entrance: '正門',
  museum: '展示ホール',
  stage: 'ステージ',
  shop: '模擬店エリア',
};

const db = new DatabaseSync(DB_PATH);

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
    role TEXT NOT NULL DEFAULT 'senior',
    scope TEXT NOT NULL DEFAULT 'entrance,museum',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'senior',
    scope TEXT NOT NULL DEFAULT 'entrance,museum',
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

function ensureColumn(tableName, columnDefinition) {

  const info =
    db.prepare(`PRAGMA table_info(${tableName})`)
      .all();

  const exists =
    info.some(column =>
      column.name === columnDefinition.name
    );

  if (!exists) {

    db.exec(`
      ALTER TABLE ${tableName}
      ADD COLUMN ${columnDefinition.sql}
    `);
  }
}

ensureColumn('users', {
  name: 'role',
  sql: 'role TEXT NOT NULL DEFAULT "senior"'
});

ensureColumn('users', {
  name: 'scope',
  sql: 'scope TEXT NOT NULL DEFAULT "entrance,museum"'
});

ensureColumn('sessions', {
  name: 'role',
  sql: 'role TEXT NOT NULL DEFAULT "senior"'
});

ensureColumn('sessions', {
  name: 'scope',
  sql: 'scope TEXT NOT NULL DEFAULT "entrance,museum"'
});

ensureColumn('sessions', {
  name: 'demographic',
  sql: 'demographic TEXT'
});

ensureColumn('sessions', {
  name: 'expires_at',
  sql: 'expires_at TEXT'
});

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

db.exec(`
  CREATE TABLE IF NOT EXISTS announcement_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// ============================================================================
// NG判定ルール初期化
// ============================================================================

// デフォルトルールを設定（サーバー再起動時に同期）
const defaultNGRules = [
  // URL検出
  { pattern: 'https?://[^\\s]+', is_regex: 1, risk_score: 30, description: 'URL' },
  // メールアドレス検出
  { pattern: '[\\w\\.-]+@[\\w\\.-]+\\.\\w+', is_regex: 1, risk_score: 25, description: 'Email address' },
  // 電話番号検出
  { pattern: '\\d{3}[-.]?\\d{3,4}[-.]?\\d{4}', is_regex: 1, risk_score: 20, description: 'Phone number' },
  // Twitter/SNS表記
  { pattern: '@[\\w]+', is_regex: 1, risk_score: 15, description: 'SNS mention' },
];

function syncNGRules() {
  const existingRules = db.prepare(`
    SELECT id, pattern, is_regex, risk_score, description
    FROM ng_rules
    WHERE description IN ('URL', 'Email address', 'Phone number', 'SNS mention')
    ORDER BY description
  `).all();

  const defaultRuleMap = Object.fromEntries(
    defaultNGRules.map(r => [r.description, r])
  );
  const existingRuleMap = Object.fromEntries(
    existingRules.map(r => [r.description, r])
  );

  let needsSync = false;

  // 新しいデフォルトルールの追加
  for (const rule of defaultNGRules) {
    if (!existingRuleMap[rule.description]) {
      needsSync = true;
      db.prepare(`
        INSERT INTO ng_rules (pattern, is_regex, risk_score, enabled, description)
        VALUES (?, ?, ?, 1, ?)
      `).run(rule.pattern, rule.is_regex, rule.risk_score, rule.description);
    }
  }

  // 削除されたデフォルトルールの削除
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

// ============================================================================
// 掲示板定期自動判定処理
// ============================================================================

const AUTO_JUDGE_INTERVAL_MS = 30 * 1000; // 30秒ごと
const BATCH_SIZE = 50; // 1回の処理で最大50件

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

      // 投稿集約を実行
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

// 定期自動判定を開始
const autoJudgeInterval = setInterval(() => {
  autoJudgePosts();
}, AUTO_JUDGE_INTERVAL_MS);

// ============================================================================

function hashPassword(password) {

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(password), salt, 64)
    .toString('hex');

  return `scrypt$${salt}$${hash}`;
}

function legacyHashPassword(password) {
  return crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');
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

    const actualHash = crypto
      .scryptSync(String(password), salt, 64)
      .toString('hex');

    return timingSafeEqualHex(actualHash, expectedHash);
  }

  return timingSafeEqualHex(legacyHashPassword(password), stored);
}

function needsPasswordRehash(storedHash) {
  return !String(storedHash || '').startsWith('scrypt$');
}

if (SYSTEM_ADMIN_USERNAME && SYSTEM_ADMIN_PASSWORD) {
  const systemAdminExists = db.prepare(`
    SELECT id
    FROM users
    WHERE username = ?
  `).get(SYSTEM_ADMIN_USERNAME);

  if (!systemAdminExists) {

    db.prepare(`
      INSERT INTO users (
        username,
        password_hash,
        role,
        scope
      )
      VALUES (?, ?, ?, ?)
    `).run(
      SYSTEM_ADMIN_USERNAME,
      hashPassword(SYSTEM_ADMIN_PASSWORD),
      'administrator',
      'all'
    );

    console.log('System administrator account created');
  }
} else {
  console.warn('SYSTEM_ADMIN_USERNAME and SYSTEM_ADMIN_PASSWORD must be set to auto-create the administrator account.');
}

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
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end('Not found');
    return;
  }

  fs.readFile(filePath, (error, data) => {

    if (error) {

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });

      res.end('Not found');

      return;
    }

    const ext =
      path.extname(filePath).toLowerCase();

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

    // 保持されているヘッダー（例: Set-Cookie）があればマージして送信する。
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
  return req.headers['x-forwarded-proto'] === 'https' ||
    req.socket.encrypted === true;
}

function buildSessionCookie(req, sessionId, options = {}) {
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId || ''}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (isSecureRequest(req)) {
    parts.push('Secure');
  }

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

  if (!origin) {
    return true;
  }

  try {
    const expected = new URL(`http://${req.headers.host || 'localhost'}`);
    const actual = new URL(origin);
    return actual.host === expected.host;
  } catch (error) {
    return false;
  }
}

function rejectCrossOriginWrite(req, res) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return false;
  }

  if (isSameOrigin(req)) {
    return false;
  }

  sendJson(res, 403, {
    ok: false,
    error: 'Forbidden origin'
  });

  return true;
}

function normalizeStampId(stampId) {
  const value = String(stampId || '').trim();
  return Object.prototype.hasOwnProperty.call(LOCATION_LABELS, value) ? value : null;
}

function normalizePage(page) {
  return String(page || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 256);
}

function normalizeScope(scope) {
  if (scope === 'all') {
    return 'all';
  }

  const raw = Array.isArray(scope)
    ? scope
    : String(scope || '').split(',');

  const allowed = raw
    .map(item => String(item).trim())
    .filter(item => Object.prototype.hasOwnProperty.call(LOCATION_LABELS, item));

  return allowed.length ? Array.from(new Set(allowed)).join(',') : 'entrance,museum';
}

function createVisitorSession(req, res) {
  try {
    const sessionId = crypto.randomUUID();
    const expiresAt = getExpiresAt();

    db.prepare(`
      INSERT INTO sessions (id, username, role, scope, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, 'anonymous', 'visitor', 'entrance,museum', expiresAt);

    // クライアントへ Cookie を送る。既存ヘッダーがあれば追加する。
    // note: serveStatic 側で既存 Set-Cookie を維持する実装を行っている。
    try {
      setCookie(res, buildSessionCookie(req, sessionId, {
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000)
      }));
    } catch (e) {
      // header 設定失敗は無視する。
    }

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

      callback(
        null,
        body ? JSON.parse(body) : {}
      );

    } catch (error) {

      callback(error);
    }
  });
}

function getCookies(req) {

  const cookieHeader =
    req.headers.cookie || '';

  return Object.fromEntries(

    cookieHeader
      .split(';')
      .map(item => {

        const [key, ...rest] =
          item.trim().split('=');

        return [key, rest.join('=')];
      })
      .filter(([key]) => key)
  );
}

function getSessionUser(req) {

  const cookies = getCookies(req);

  const sessionId =
    cookies[SESSION_COOKIE_NAME];

  if (!sessionId) {
    return null;
  }

  const row = db.prepare(`
    SELECT username, role, scope, expires_at
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
  return user &&
    user.username === 'anonymous' &&
    user.role === 'visitor';
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

function requireSession(req, res, next) {

  const user = getSessionUser(req);

  if (!user || isAnonymousUser(user)) {

    sendJson(res, 401, {
      ok: false,
      error: 'Unauthorized'
    });

    return;
  }

  next(user);
}

function requireRole(req, res, role, next) {

  requireSession(req, res, (user) => {

    if (user.role !== role) {

      sendJson(res, 403, {
        ok: false,
        error: 'Forbidden'
      });

      return;
    }

    next(user);
  });
}

// ============================================================================
// 掲示板・アナウンス関連のヘルパー関数
// ============================================================================

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

  return {
    riskScore: totalRiskScore,
    detectedRuleIds: detectedRules
  };
}

function calculatePostStatus(riskScore) {
  if (riskScore <= 0) {
    return 'published';
  }
  if (riskScore < 50) {
    return 'published';
  }
  if (riskScore < 100) {
    return 'review';
  }
  return 'rejected';
}

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

function logModerationAction(postId, admin, action, oldStatus, newStatus, reason = null) {
  db.prepare(`
    INSERT INTO moderation_logs
    (post_id, admin_username, action, old_status, new_status, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(postId, admin, action, oldStatus, newStatus, reason);
}

function getScopeList(scope) {

  if (!scope || scope === 'all') {
    return null;
  }

  return String(scope)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getSummary(user) {

  const scopeList =
    getScopeList(user && user.scope);

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

  const filteredVisits =
    scopeList
      ? visits.filter(item =>
          scopeList.includes(item.stamp_id)
        )
      : visits;

  const filteredClicks =
    scopeList
      ? clicks.filter(item =>
          scopeList.includes(item.stamp_id)
        )
      : clicks;

  const visitMap =
    Object.fromEntries(
      filteredVisits.map(item => [
        item.stamp_id,
        item.count
      ])
    );

  const clickMap =
    Object.fromEntries(
      filteredClicks.map(item => [
        item.stamp_id,
        item.count
      ])
    );

  return {

    locations:

      Object.keys(LOCATION_LABELS)
        .map(stampId => ({

          stamp_id: stampId,

          stamp_name:
            LOCATION_LABELS[stampId],

          visits:
            visitMap[stampId] || 0,

          clicks:
            clickMap[stampId] || 0,
        })),

    totals: {

      visits:
        filteredVisits.reduce(
          (sum, item) => sum + item.count,
          0
        ),

      clicks:
        filteredClicks.reduce(
          (sum, item) => sum + item.count,
          0
        ),
    },
  };
}

const server = http.createServer((req, res) => {

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  const pathname = url.pathname;

  if (rejectCrossOriginWrite(req, res)) {
    return;
  }

  // リクエストごとに匿名セッションを発行して Cookie を返す。
  // クライアント側での自己生成 sessionId を廃止する方針に合わせる。
  let issuedSessionId = null;
  try {
    const cookies = getCookies(req);
    if (!cookies[SESSION_COOKIE_NAME]) {
      issuedSessionId = createVisitorSession(req, res);
    }
  } catch (e) {
    // 無視する。
  }

  if (
    pathname === '/api/login' &&
    req.method === 'POST'
  ) {

    const rateLimitKey = `login:${getClientKey(req)}`;

    if (isRateLimited(rateLimitKey)) {
      return sendJson(res, 429, {
        ok: false,
        error: 'Too many login attempts'
      });
    }

    parseBody(req, (error, payload) => {

      if (error) {

        return sendJson(res, 400, {
          ok: false,
          error: error.message === 'Request body too large' ? 'Request body too large' : 'Invalid JSON'
        });
      }

      const username =
        String(payload.username || '')
          .trim();

      const password = String(payload.password || '');

      const user = db.prepare(`
        SELECT username, password_hash, role, scope
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

        return sendJson(res, 401, {
          ok: false,
          error: 'Invalid credentials'
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
        INSERT INTO sessions (
          id,
          username,
          role,
          scope,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(
        sessionId,
        user.username,
        user.role,
        user.scope || 'entrance,museum',
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
      }));
    });

    return;
  }
  if (
    pathname === '/api/logout' &&
    req.method === 'POST'
  ) {

    const sessionId = getCookies(req)[SESSION_COOKIE_NAME];

    const row = sessionId
      ? db.prepare(`SELECT username FROM sessions WHERE id = ?`).get(sessionId)
      : null;

    if (sessionId) {
      db.prepare(`
        DELETE FROM sessions
        WHERE id = ?
      `).run(sessionId);
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

  if (pathname === '/api/auth/me') {

    const user = getSessionUser(req);
    const isAuthenticated = user && !isAnonymousUser(user);

    sendJson(
      res,
      isAuthenticated ? 200 : 401,
      {
        ok: !!isAuthenticated,
        username:
          isAuthenticated && user.username,

        role:
          isAuthenticated && user.role,

        scope:
          isAuthenticated && user.scope
      }
    );

    return;
  }

  if (
    pathname === '/api/auth/users' &&
    req.method === 'GET'
  ) {

    requireRole(req, res, 'administrator', (user) => {

      const users = db.prepare(`
        SELECT
          username,
          role,
          scope,
          created_at
        FROM users
        ORDER BY id
      `).all();

      logEvent('admin_access', {
        username: user && user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_users'
      });

      sendJson(res, 200, {
        ok: true,
        users
      });
    });

    return;
  }

  if (
    pathname === '/api/auth/users' &&
    req.method === 'POST'
  ) {
    requireRole(req, res, 'administrator', (user) => {

      parseBody(req, (error, payload) => {

        if (error) {
          return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
        }

        const newUsername = String(payload.username || '').trim();
        const password = String(payload.password || '');
        const role = String(payload.role || 'senior').toLowerCase();
        const scope = normalizeScope(payload.scope || 'entrance,museum');

        if (!newUsername || !password) {
          return sendJson(res, 400, { ok: false, error: 'username and password are required' });
        }

        if (!/^[A-Za-z0-9_.-]{3,64}$/.test(newUsername)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid username' });
        }

        if (password.length < 12) {
          return sendJson(res, 400, { ok: false, error: 'Password must be at least 12 characters' });
        }

        if (!ALLOWED_ROLES.includes(role)) {
          return sendJson(res, 400, { ok: false, error: 'Invalid role' });
        }

        try {
          db.prepare(`
            INSERT INTO users (
              username,
              password_hash,
              role,
              scope
            )
            VALUES (?, ?, ?, ?)
          `).run(newUsername, hashPassword(password), role, scope);

          logEvent('user_created', {
            username: user && user.username,
            sessionId: getCookies(req)[SESSION_COOKIE_NAME],
            userAgent: req.headers['user-agent'] || '',
            page: pathname,
            detail: JSON.stringify({ target: newUsername, role, scope })
          });

          sendJson(res, 200, { ok: true, username: newUsername, role, scope, hashFunction: 'scrypt' });

        } catch (error) {
          sendJson(res, 409, { ok: false, error: 'User already exists' });
        }
      });
    });

    return;
  }

  if (
    pathname.startsWith('/api/auth/users/') &&
    req.method === 'DELETE'
  ) {

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

      db.prepare(`DELETE FROM sessions WHERE username = ?`).run(targetUsername);

      const info = db.prepare(`DELETE FROM users WHERE username = ?`).run(targetUsername);

      if (info.changes === 0) {
        return sendJson(res, 404, { ok: false, error: 'User not found' });
      }

      logEvent('user_deleted', {
        username: user && user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ target: targetUsername })
      });

      sendJson(res, 200, { ok: true, username: targetUsername });
    });

    return;
  }

  if (
    pathname === '/api/auth/change-password' &&
    req.method === 'POST'
  ) {

    requireSession(req, res, (user) => {

      parseBody(req, (error, payload) => {

        if (error) {

          return sendJson(res, 400, {
            ok: false,
            error: 'Invalid JSON'
          });
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
          SELECT password_hash
          FROM users
          WHERE username = ?
        `).get(user.username);

        if (!row) {

          return sendJson(res, 404, {
            ok: false,
            error: 'User not found'
          });
        }

        if (!verifyPassword(current, row.password_hash)) {

          return sendJson(res, 403, {
            ok: false,
            error: 'Current password is incorrect'
          });
        }

        if (next.length < 12) {
          return sendJson(res, 400, {
            ok: false,
            error: 'New password must be at least 12 characters'
          });
        }

        db.prepare(`
          UPDATE users
          SET password_hash = ?
          WHERE username = ?
        `).run(
          hashPassword(next),
          user.username
        );

        const currentSessionId = getCookies(req)[SESSION_COOKIE_NAME];
        db.prepare(`
          DELETE FROM sessions
          WHERE username = ?
          AND id <> ?
        `).run(user.username, currentSessionId || '');

        logEvent('password_change', {
          username: user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: 'password_changed'
        });

        sendJson(res, 200, { ok: true });
      });
    });

    return;
  }
  
  // stamp event ingestion endpoint (visit / click)
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

      // クライアントからの sessionId は廃止。Cookie または当リクエストで発行したセッションを使う。
      const sessionId = String(getCookies(req)[SESSION_COOKIE_NAME] || issuedSessionId || '');
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

      if (type === 'click') {
        db.prepare(`
          INSERT INTO stamp_clicks (stamp_id, stamp_name, session_id, user_agent, page)
          VALUES (?, ?, ?, ?, ?)
        `).run(stampId, stampName, sessionId || null, userAgent, page || null);

        logEvent('stamp_click', {
          sessionId,
          userAgent,
          page,
          detail: JSON.stringify({ stampId, stampName })
        });

        return sendJson(res, 200, { ok: true });
      }

      // クライアントで 'jump' を送る実装があるため、互換性のためにクリック扱いで保存する。
      if (type === 'jump') {
        db.prepare(`
          INSERT INTO stamp_clicks (stamp_id, stamp_name, session_id, user_agent, page)
          VALUES (?, ?, ?, ?, ?)
        `).run(stampId, stampName, sessionId || null, userAgent, page || null);

        logEvent('stamp_jump', {
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

  // 訪問履歴と遷移（クリック/jump）履歴取得。
  if (pathname === '/api/stamp-history' && req.method === 'GET') {
    const targetSessionId = getCookies(req)[SESSION_COOKIE_NAME] || null;
    const authUser = getSessionUser(req);

    // 管理者は全件取得。
    if (authUser && !isAnonymousUser(authUser) && authUser.role === 'administrator') {
      const visits = db.prepare(`SELECT sv.*, s.username FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id ORDER BY sv.id DESC LIMIT 1000`).all();
      const clicks = db.prepare(`SELECT sc.*, s.username FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id ORDER BY sc.id DESC LIMIT 1000`).all();
      return sendJson(res, 200, { ok: true, visits, clicks });
    }

    // 認証済みユーザは自分のセッションのみ取得。
    if (authUser && !isAnonymousUser(authUser)) {
      const sessions = db.prepare(`SELECT id FROM sessions WHERE username = ?`).all(authUser.username).map(r => r.id);
      if (!sessions.length) return sendJson(res, 200, { ok: true, visits: [], clicks: [] });

      const placeholders = sessions.map(() => '?').join(',');
      const visits = db.prepare(`SELECT sv.*, s.username FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id WHERE sv.session_id IN (${placeholders}) ORDER BY sv.id DESC LIMIT 1000`).all(...sessions);
      const clicks = db.prepare(`SELECT sc.*, s.username FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id WHERE sc.session_id IN (${placeholders}) ORDER BY sc.id DESC LIMIT 1000`).all(...sessions);

      return sendJson(res, 200, { ok: true, visits, clicks });
    }

    // 未認証は自分の Cookie セッションのみ取得。
    if (!targetSessionId) return sendJson(res, 400, { ok: false, error: 'sessionId is required' });

    const visits = db.prepare(`SELECT sv.*, s.username FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id WHERE sv.session_id = ? ORDER BY sv.id DESC LIMIT 1000`).all(targetSessionId);
    const clicks = db.prepare(`SELECT sc.*, s.username FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id WHERE sc.session_id = ? ORDER BY sc.id DESC LIMIT 1000`).all(targetSessionId);

    return sendJson(res, 200, { ok: true, visits, clicks });
  }
  if (pathname === '/api/admin/summary' && req.method === 'GET') {

    requireSession(req, res, (user) => {
      logEvent('admin_access', {
        username: user && user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_summary'
      });

      sendJson(res, 200, getSummary(user));
    });

    return;
  }

  if (pathname === '/api/admin/events' && req.method === 'GET') {

    requireSession(req, res, (user) => {
      const scopeList = getScopeList(user.scope);

      if (user.role === 'administrator') {
        const visits = db.prepare(`SELECT sv.*, s.username, s.demographic FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id ORDER BY sv.id DESC LIMIT 100`).all();
        const clicks = db.prepare(`SELECT sc.*, s.username, s.demographic FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id ORDER BY sc.id DESC LIMIT 100`).all();

        logEvent('admin_access', {
          username: user && user.username,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: 'view_events'
        });

        return sendJson(res, 200, { visits, clicks });
      }

      // 非管理者は scope に基づいて絞る。
      const visitsAll = db.prepare(`SELECT sv.*, s.username, s.demographic FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id ORDER BY sv.id DESC LIMIT 1000`).all();
      const clicksAll = db.prepare(`SELECT sc.*, s.username, s.demographic FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id ORDER BY sc.id DESC LIMIT 1000`).all();

      const visits = visitsAll.filter(item => !scopeList || scopeList.includes(item.stamp_id));
      const clicks = clicksAll.filter(item => !scopeList || scopeList.includes(item.stamp_id));

      logEvent('admin_access', {
        username: user && user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_events'
      });

      sendJson(res, 200, { visits, clicks });
    });

    return;
  }

  // 管理者によるイベント削除（訪問・遷移）。
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
          username: user && user.username,
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

  if (pathname === '/api/admin/logs') {
    if (req.method === 'GET') {
      requireRole(req, res, 'administrator', (user) => {
        const logs = db.prepare(`SELECT * FROM logs ORDER BY id DESC LIMIT 500`).all();

        sendJson(res, 200, { ok: true, logs });
      });

      return;
    }

    if (req.method === 'DELETE') {
      requireRole(req, res, 'administrator', (user) => {
        // サポートする JSON ボディ: { before: 'YYYY-MM-DDTHH:MM:SS' }
        parseBody(req, (err, payload) => {
          if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

          if (payload && payload.before) {
            db.prepare(`DELETE FROM logs WHERE created_at < ?`).run(payload.before);
          } else {
            db.prepare(`DELETE FROM logs`).run();
          }

          logEvent('admin_delete_logs', {
            username: user && user.username,
            sessionId: getCookies(req)[SESSION_COOKIE_NAME],
            userAgent: req.headers['user-agent'] || '',
            page: pathname,
            detail: JSON.stringify({ before: payload && payload.before || null })
          });

          sendJson(res, 200, { ok: true });
        });
      });

      return;
    }
  }

  // ============================================================================
  // 掲示板API
  // ============================================================================

  // POST /api/posts - 新規投稿（匿名）
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

      const insertStmt = db.prepare(`
        INSERT INTO posts (content, status, risk_score)
        VALUES (?, ?, ?)
      `);
      const result = insertStmt.run(content, status, ngCheck.riskScore);

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
        status: status
      });
    });
    return;
  }

  // GET /api/posts - 投稿一覧（公開済みのみ）
  if (pathname === '/api/posts' && req.method === 'GET') {
    const status = url.searchParams.get('status') || 'published';
    const search = url.searchParams.get('search') || '';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const posts = getPostsSub({
      status: status === 'all' ? null : status,
      search: search,
      limit: limit
    });

    return sendJson(res, 200, { ok: true, posts });
  }

  // PATCH /api/posts/:id/status - 投稿状態変更（管理者のみ）
  if (pathname.match(/^\/api\/admin\/posts\/(\d+)\/status$/) && req.method === 'PATCH') {
    requireRole(req, res, 'administrator', (user) => {
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
          UPDATE posts
          SET status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
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

  // GET /api/admin/posts - 投稿一覧（管理者向け・全状態表示）
  if (pathname === '/api/admin/posts' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const status = url.searchParams.get('status') || '';
      const search = url.searchParams.get('search') || '';
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);

      let query = `
        SELECT id, content, status, risk_score, created_at, updated_at
        FROM posts
        WHERE 1=1
      `;
      const params = [];

      if (status) {
        query += ` AND status = ?`;
        params.push(status);
      }

      if (search) {
        query += ` AND content LIKE ?`;
        params.push(`%${search}%`);
      }

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

  // GET /api/admin/moderation-logs - 管理ログ
  if (pathname === '/api/admin/moderation-logs' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
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

  // ============================================================================
  // アナウンスAPI
  // ============================================================================

  // GET /api/announcements - 公開中のアナウンス一覧
  if (pathname === '/api/announcements' && req.method === 'GET') {
    const announcements = getAnnouncementsSub();
    return sendJson(res, 200, { ok: true, announcements });
  }

  // POST /api/announcements - アナウンス作成（アナウンス認証）
  if (pathname === '/api/announcements' && req.method === 'POST') {
    // パスワード認証（Application/JSON のみ）
    parseBody(req, (err, payload) => {
      if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

      const username = String(payload.username || '').trim();
      const password = String(payload.password || '').trim();
      const title = String(payload.title || '').trim();
      const content = String(payload.content || '').trim();
      const importance = String(payload.importance || 'normal').toLowerCase();
      const publishedAt = String(payload.published_at || '');
      const expiresAt = String(payload.expires_at || '');

      if (!username || !password || !title || !content) {
        return sendJson(res, 400, { ok: false, error: 'Missing required fields' });
      }

      const announcer = db.prepare(`
        SELECT password_hash FROM announcement_users WHERE username = ?
      `).get(username);

      if (!announcer || !verifyPassword(password, announcer.password_hash)) {
        return sendJson(res, 401, { ok: false, error: 'Invalid credentials' });
      }

      const result = db.prepare(`
        INSERT INTO announcements (title, content, importance, published_at, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(title, content, importance, publishedAt, expiresAt, username);

      logEvent('announcement_created', {
        username: username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ announcementId: result.lastInsertRowid })
      });

      return sendJson(res, 201, { ok: true, announcementId: result.lastInsertRowid });
    });
    return;
  }

  // ============================================================================
  // アナウンス管理API（管理者のみ）
  // ============================================================================

  // GET /api/admin/announcements - 全アナウンス表示（管理者向け）
  if (pathname === '/api/admin/announcements' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const announcements = db.prepare(`
        SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100
      `).all();

      return sendJson(res, 200, { ok: true, announcements });
    });
    return;
  }

  // PATCH /api/admin/announcements/:id - アナウンス編集（管理者のみ）
  if (pathname.match(/^\/api\/admin\/announcements\/(\d+)$/) && req.method === 'PATCH') {
    requireRole(req, res, 'administrator', (user) => {
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

  // DELETE /api/admin/announcements/:id - アナウンス削除（管理者のみ）
  if (pathname.match(/^\/api\/admin\/announcements\/(\d+)$/) && req.method === 'DELETE') {
    requireRole(req, res, 'administrator', (user) => {
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

  // ============================================================================
  // アナウンス投稿者ユーザー管理（管理者のみ）
  // ============================================================================

  // GET /api/admin/announcement-users - ユーザー一覧
  if (pathname === '/api/admin/announcement-users' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const users = db.prepare(`
        SELECT id, username, created_at FROM announcement_users ORDER BY created_at DESC
      `).all();

      return sendJson(res, 200, { ok: true, users });
    });
    return;
  }

  // POST /api/admin/announcement-users - ユーザー追加
  if (pathname === '/api/admin/announcement-users' && req.method === 'POST') {
    requireRole(req, res, 'administrator', (user) => {
      parseBody(req, (err, payload) => {
        if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

        const username = String(payload.username || '').trim();
        const password = String(payload.password || '').trim();

        if (!username || !password) {
          return sendJson(res, 400, { ok: false, error: 'Username and password are required' });
        }

        if (password.length < 8) {
          return sendJson(res, 400, { ok: false, error: 'Password must be at least 8 characters' });
        }

        try {
          db.prepare(`
            INSERT INTO announcement_users (username, password_hash)
            VALUES (?, ?)
          `).run(username, hashPassword(password));

          logEvent('announcement_user_created', {
            username: user.username,
            sessionId: getCookies(req)[SESSION_COOKIE_NAME],
            userAgent: req.headers['user-agent'] || '',
            page: pathname,
            detail: JSON.stringify({ newUsername: username })
          });

          return sendJson(res, 201, { ok: true });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: 'Username already exists' });
        }
      });
    });
    return;
  }

  // DELETE /api/admin/announcement-users/:id - ユーザー削除
  if (pathname.match(/^\/api\/admin\/announcement-users\/(\d+)$/) && req.method === 'DELETE') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/announcement-users\/(\d+)$/);
      const id = parseInt(match[1], 10);

      const announceUser = db.prepare(`SELECT * FROM announcement_users WHERE id = ?`).get(id);
      if (!announceUser) {
        return sendJson(res, 404, { ok: false, error: 'User not found' });
      }

      db.prepare(`DELETE FROM announcement_users WHERE id = ?`).run(id);

      logEvent('announcement_user_deleted', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ deletedUsername: announceUser.username })
      });

      return sendJson(res, 200, { ok: true });
    });
    return;
  }

  // ============================================================================
  // NG判定ルール管理API（管理者のみ）
  // ============================================================================

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

  // GET /api/admin/ng-rules/:id - ルール詳細
  if (pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/) && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/ng-rules\/(\d+)$/);
      const id = parseInt(match[1], 10);

      const rule = db.prepare(`
        SELECT id, pattern, is_regex, risk_score, enabled, description, created_at
        FROM ng_rules
        WHERE id = ?
      `).get(id);

      if (!rule) {
        return sendJson(res, 404, { ok: false, error: 'Rule not found' });
      }

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

        // 正規表現の検証
        if (isRegex) {
          try {
            new RegExp(pattern);
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: 'Invalid regex pattern' });
          }
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
        if (!rule) {
          return sendJson(res, 404, { ok: false, error: 'Rule not found' });
        }

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

        // 正規表現の検証
        if (isRegex) {
          try {
            new RegExp(pattern);
          } catch (e) {
            return sendJson(res, 400, { ok: false, error: 'Invalid regex pattern' });
          }
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
      if (!rule) {
        return sendJson(res, 404, { ok: false, error: 'Rule not found' });
      }

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

  // POST /api/admin/ng-rules/:id/toggle - ルール有効/無効切り替え
  if (pathname.match(/^\/api\/admin\/ng-rules\/(\d+)\/toggle$/) && req.method === 'POST') {
    requireRole(req, res, 'administrator', (user) => {
      const match = pathname.match(/^\/api\/admin\/ng-rules\/(\d+)\/toggle$/);
      const id = parseInt(match[1], 10);

      const rule = db.prepare(`SELECT * FROM ng_rules WHERE id = ?`).get(id);
      if (!rule) {
        return sendJson(res, 404, { ok: false, error: 'Rule not found' });
      }

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

  // POST /api/admin/ng-rules/test - NG判定テスト
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
          FROM ng_rules
          WHERE enabled = 1
          ORDER BY risk_score DESC
        `).all();

        const matches = [];
        let totalRiskScore = 0;

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

  // サイト（静的ファイル）への通常アクセスはログに残す。
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
    /* ignore logging errors */
  }

  serveStatic(res, getFilePath(pathname));
});

server.listen(PORT, () => {

  console.log(
    `Server running at https://localhost:${PORT}`
  );
}); 

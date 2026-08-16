process.env.TZ = 'Asia/Tokyo';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;

const STATIC_ROOT = path.join(__dirname, 'public');
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
    'announcement.manage',
    'control'
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

function loadConfig() {
  try {
    const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
    return config;
  } catch (e) {
    // config が壊れている、または存在しない場合は初期化
    const PAGE_LIST = [
      'index',
      'about',
      'guest',
      'shop',
      'event',
      'stamp-rally',
        'lottery-entry',
        'lottery-guide',
        'lottery-prizes',
      'schedule',
      'company',
      'map',
      'announcements',
      'bulletin',
      'access'
    ];
 
    const defaultConfig = {
      pages: Object.fromEntries(PAGE_LIST.map(p => [p, true])),
      siteWidePublished: true
    };
 
    try {
      fs.writeFileSync('./config.json', JSON.stringify(defaultConfig, null, 2));
    } catch (writeErr) {
      console.error('Failed to write config.json:', writeErr);
    }
 
    return defaultConfig;
  }
}

const DEFAULT_COMPANY_MASTER = [
  {
    id: 'company-a',
    name: '企業A',
    note: '企業Aのブース前のQRコードを読み取る',
    linkText: '企業紹介へ',
    href: '/company.html',
    image: '/header_ed.jpg'
  },
  {
    id: 'company-b',
    name: '企業B',
    note: '企業Bのブース前のQRコードを読み取る',
    linkText: '企業紹介へ',
    href: '/company.html',
    image: '/about.jpg'
  },
  {
    id: 'company-c',
    name: '企業C',
    note: '企業Cのブース前のQRコードを読み取る',
    linkText: '企業紹介へ',
    href: '/company.html',
    image: '/event.jpg'
  },
  {
    id: 'company-d',
    name: '企業D',
    note: '企業Dのブース前のQRコードを読み取る',
    linkText: '企業紹介へ',
    href: '/company.html',
    image: '/shop.jpg'
  }
];

function loadCompanyMaster() {
  const masterPath = path.join(__dirname, 'public','scripts','companies.json');
  try {
    if (!fs.existsSync(masterPath)) {
      return DEFAULT_COMPANY_MASTER;
    }

    const parsed = JSON.parse(fs.readFileSync(masterPath, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_COMPANY_MASTER;
    }

    return parsed.map((item, index) => ({
      id: String(item.id || `company-${String.fromCharCode(97 + index)}`),
      name: String(item.name || `企業${String.fromCharCode(65 + index)}`),
      note: String(item.note || `${String(item.name || `企業${String.fromCharCode(65 + index)}`)}のブース前のQRコードを読み取る`),
      linkText: String(item.linkText || '企業紹介へ'),
      href: String(item.href || '/company.html'),
      image: String(item.image || '/header_ed.jpg')
    }));
  } catch (error) {
    console.error('Failed to load company master, falling back to defaults', error);
    return DEFAULT_COMPANY_MASTER;
  }
}

const COMPANY_MASTER = loadCompanyMaster();
const LOCATION_LABELS = Object.fromEntries(
  COMPANY_MASTER.map(item => [item.id, item.name])
);

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

const db = new DatabaseSync(DB_PATH);

// 各種テーブル初期化
// ──────────────────────────────────────────────────────────────
// 訪問者識別・スタンプラリー・抽選連携テーブル
// ──────────────────────────────────────────────────────────────

// 訪問者管理テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS visitors (
    visitor_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    last_seen TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
`);

// スタンプ履歴テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS stamp_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    FOREIGN KEY (visitor_id) REFERENCES visitors(visitor_id),
    UNIQUE(visitor_id, company_id)
  );
`);

// 抽選管理テーブル
db.exec(`
  CREATE TABLE IF NOT EXISTS lottery (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    lottery_number TEXT NOT NULL UNIQUE,
    weight REAL NOT NULL,
    entry_time TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    FOREIGN KEY (visitor_id) REFERENCES visitors(visitor_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS stamp_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stamp_id TEXT NOT NULL,
    stamp_name TEXT NOT NULL,
    session_id TEXT,
    user_agent TEXT,
    page TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
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
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    scope TEXT NOT NULL DEFAULT 'all',
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER,
    username TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'visitor',
    scope TEXT NOT NULL DEFAULT 'all',
    profile_attributes TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
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
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
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
ensureColumn('sessions', { name: 'profile_attributes', sql: 'profile_attributes TEXT' });
ensureColumn('sessions', { name: 'expires_at', sql: 'expires_at TEXT' });
ensureColumn('stamp_visits', { name: 'survey_age', sql: 'survey_age TEXT' });
ensureColumn('stamp_visits', { name: 'survey_discovery', sql: 'survey_discovery TEXT' });
ensureColumn('stamp_visits', { name: 'survey_area', sql: 'survey_area TEXT' });
ensureColumn('stamp_visits', { name: 'visitor_id', sql: 'visitor_id TEXT' });
ensureColumn('stamp_visits', { name: 'company_id', sql: 'company_id TEXT' });
ensureColumn('stamp_clicks', { name: 'survey_age', sql: 'survey_age TEXT' });
ensureColumn('stamp_clicks', { name: 'survey_discovery', sql: 'survey_discovery TEXT' });
ensureColumn('stamp_clicks', { name: 'survey_area', sql: 'survey_area TEXT' });

// ============================================================================
// 掲示板・アナウンス機能用テーブル
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    risk_score INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS post_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    reaction_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    UNIQUE(post_id, session_id, reaction_type)
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
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS post_aggregations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    representative_post_id INTEGER NOT NULL,
    aggregated_post_ids TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    similarity_score REAL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
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
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
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
    created_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
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
        INSERT INTO ng_rules (pattern, is_regex, risk_score, enabled, description, created_at)
        VALUES (?, ?, ?, 1, ?, datetime('now', '+9 hours'))
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

// 配列を受け取り ng_rules テーブルへ同期するユーティリティ
function applyNGRulesArray(arr) {
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

  if (changed) console.log('NGルールを同期しました (配列入力)');
}

// 外部ファイルから NG ルールを読み込み、配列として適用する
function loadExternalNGRules(filePath) {
  if (!filePath) return;
  try {
    const resolved = path.resolve(__dirname, filePath);
    if (!fs.existsSync(resolved)) {
      console.log(`NG rules file not found: ${resolved}`);
      return;
    }
    const content = fs.readFileSync(resolved, 'utf8');
    const arr = JSON.parse(content);
    if (!Array.isArray(arr)) {
      console.error('NG rules file must contain an array');
      return;
    }
    applyNGRulesArray(arr);
    console.log('External NGルールを同期しました:', resolved);
  } catch (e) {
    console.error('NG rules file load error', e);
  }
}

// .env 内に NG_RULES がある場合、それを抽出してパースする
function parseNGRulesFromEnvFile() {
  try {
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
  } catch (e) {
    console.error('Failed reading .env for NG_RULES', e);
    return null;
  }
}

function parseNGRulesJsonSafely(rawValue) {
  if (!rawValue) return null;
  try {
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

// 起動時の同期順序:
// 1. process.env.NG_RULES (文字列 JSON) を優先
// 2. .env 内の NG_RULES ブロックをパース
// 3. 環境変数 NG_RULES_FILE または ./scripts/ng-rules.json を試す
const envVarRules = parseNGRulesJsonSafely(process.env.NG_RULES);
  if (envVarRules) {
    applyNGRulesArray(envVarRules);
  }  else {
    const envArr = parseNGRulesFromEnvFile();
    if (envArr) {
      applyNGRulesArray(envArr);
    } else {
      loadExternalNGRules(process.env.NG_RULES_FILE || './scripts/ng-rules.json');
    }
}



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
        SET status = ?, risk_score = ?, updated_at = datetime('now', '+9 hours')
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
      INSERT INTO users (username, password_hash, role, scope, created_at)
      VALUES (?, ?, 'administrator', 'all', datetime('now', '+9 hours'))
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

function formatLotteryNumberFromId(id) {
  return String(id).padStart(4, '0');
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
  //if (!filePath) {
    //res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    //res.end('Not found');
    //return;
  //}
   if (!filePath) {
  const notFoundPath = path.join(STATIC_ROOT, '404notfound.html');

  fs.readFile(notFoundPath, (error, data) => {
    if (error) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });
      res.end('Not found');
      return;
    }

    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8'
    });
    res.end(data);
  });

  return;
}
  // const filePath = path.join(__dirname, 'public', req.url);

  fs.readFile(filePath, (error, data) => {
    //if (error) {
     //res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
     //res.end('Not found');
      //return;
    //}

    if (error) {
  const notFoundPath = path.join(STATIC_ROOT, '404notfound.html');

  fs.readFile(notFoundPath, (err404, data404) => {
    if (err404) {
      // 404.html自体が読めない場合
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end('Not found');
      return;
    }

    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    });

    res.end(data404);
  });

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
      INSERT INTO sessions (id, user_id, username, role, scope, expires_at, created_at)
      VALUES (?, NULL, 'anonymous', 'visitor', 'all', ?, datetime('now', '+9 hours'))
    `).run(sessionId, expiresAt);

    ensureVisitorRecord(sessionId, req);

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

function ensureVisitorRecord(visitorId, req) {
  const normalizedVisitorId = String(visitorId || '').trim();

  if (!normalizedVisitorId) {
    return false;
  }

  const result = db.prepare(`
    INSERT OR IGNORE INTO visitors (visitor_id, created_at, last_seen)
    VALUES (?, datetime('now', '+9 hours'), datetime('now', '+9 hours'))
  `).run(normalizedVisitorId);

  if (result.changes > 0) {
    logEvent('visitor_registered', {
      username: null,
      sessionId: normalizedVisitorId,
      userAgent: req && req.headers ? req.headers['user-agent'] || '' : '',
      page: req && req.url ? req.url : '',
      detail: JSON.stringify({ visitor_id: normalizedVisitorId })
    });
    return true;
  }

  return false;
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
      INSERT INTO logs (type, username, session_id, user_agent, page, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
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
        (representative_post_id, aggregated_post_ids, count, similarity_score, created_at)
        VALUES (?, ?, 1, ?, datetime('now', '+9 hours'))
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

  const visibleStampIds = scopeList
    ? COMPANY_MASTER.filter(item => scopeList.includes(item.id)).map(item => item.id)
    : COMPANY_MASTER.map(item => item.id);

  return {
    locations: visibleStampIds.map(stampId => ({
      stamp_id: stampId,
      stamp_name: LOCATION_LABELS[stampId],
      visits: visitMap[stampId] || 0,
      clicks: clickMap[stampId] || 0,
    })),
    totals: {
      visits: filteredVisits.reduce((sum, item) => sum + item.count, 0),
      clicks: filteredClicks.reduce((sum, item) => sum + item.count, 0),
      companyCount: visibleStampIds.length,
    },
  };
}

// 投稿一覧クエリサブルーチン
function getPostsSub(filters = {}) {
  let query = `
    SELECT
      p.id,
      p.content,
      p.status,
      p.risk_score,
      p.created_at,
      p.updated_at,
      COALESCE((
        SELECT COUNT(*)
        FROM post_reactions pr
        WHERE pr.post_id = p.id AND pr.reaction_type = 'thumbs_up'
      ), 0) AS thumbs_up_count,
      COALESCE((
        SELECT COUNT(*)
        FROM post_reactions pr
        WHERE pr.post_id = p.id AND pr.reaction_type = 'heart'
      ), 0) AS heart_count
  `;
  const params = [];

  if (filters.sessionId) {
    query += `,
      CASE WHEN EXISTS(
        SELECT 1
        FROM post_reactions pr
        WHERE pr.post_id = p.id AND pr.session_id = ? AND pr.reaction_type = 'thumbs_up'
      ) THEN 1 ELSE 0 END AS reacted_thumbs_up,
      CASE WHEN EXISTS(
        SELECT 1
        FROM post_reactions pr
        WHERE pr.post_id = p.id AND pr.session_id = ? AND pr.reaction_type = 'heart'
      ) THEN 1 ELSE 0 END AS reacted_heart
    `;
    params.push(filters.sessionId, filters.sessionId);
  } else {
    query += `, 0 AS reacted_thumbs_up, 0 AS reacted_heart `;
  }

  query += `
    FROM posts p
    WHERE 1=1
  `;

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

function getPostReactionSummary(postId, sessionId = null) {
  const counts = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN reaction_type = 'thumbs_up' THEN 1 ELSE 0 END), 0) AS thumbs_up_count,
      COALESCE(SUM(CASE WHEN reaction_type = 'heart' THEN 1 ELSE 0 END), 0) AS heart_count
    FROM post_reactions
    WHERE post_id = ?
  `).get(postId) || { thumbs_up_count: 0, heart_count: 0 };

  const reacted = sessionId ? db.prepare(`
    SELECT reaction_type
    FROM post_reactions
    WHERE post_id = ? AND session_id = ?
  `).all(postId, sessionId) : [];

  return {
    thumbs_up_count: counts.thumbs_up_count || 0,
    heart_count: counts.heart_count || 0,
    reacted_reaction_type: reacted[0] ? reacted[0].reaction_type : null,
    reacted_thumbs_up: reacted.some(item => item.reaction_type === 'thumbs_up') ? 1 : 0,
    reacted_heart: reacted.some(item => item.reaction_type === 'heart') ? 1 : 0,
  };
}

// 公開中アナウンス一覧取得サブルーチン
function getAnnouncementsSub() {
  const now = new Date().toISOString();
  return db.prepare(`
    SELECT id, title, content, importance, published_at, expires_at, created_at
    FROM announcements
    ORDER BY
      CASE importance
        WHEN 'urgent' THEN 3
        WHEN 'important' THEN 2
        ELSE 1
      END DESC,
      created_at DESC
  `).all();
}
/* WHERE published_at <= ?
    AND expires_at > ?
    ORDER BY importance DESC, published_at DESC */

// モデレーションログ記録
function logModerationAction(postId, admin, action, oldStatus, newStatus, reason = null) {
  db.prepare(`
    INSERT INTO moderation_logs
    (post_id, admin_username, action, old_status, new_status, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
  `).run(postId, admin, action, oldStatus, newStatus, reason);
}



function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    res.writeHead(200);
    res.end(data);
  });
}

/*function serveStatic(req, res) {
  const filePath = path.join(__dirname, 'public', req.url);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(200);
    res.end(data);
  });
}*/

// ============================================================================
// HTTP サーバーコア・ルーティングルーチン
// ============================================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

 const config = loadConfig();
 
// ===== 公開制御 =====
//const page = pathname.replace(/\.html$/, '').replace(/^\//, '');
 
let page = pathname
    .replace(/^\/+/, '')                     // 先頭のスラッシュを除去
    .replace(/\.html$/, '')                  // 末尾の .html を除去
    .toLowerCase();                          // 小文字に統一
  
  if (!page) page = 'index';                 // 空なら 'index' に設定
 
  const isApi = pathname.startsWith('/api/');
  const isStatic =
    pathname.startsWith('/css/') ||
    pathname.startsWith('/js/') ||
    pathname.startsWith('/img/') ||
    pathname.startsWith('/assets/');
 
  // ===== 公開制御チェック =====
  if (!isApi && !isStatic) {
    // closed.html と unpublished.html へのアクセスはリダイレクト対象外
    const isErrorPage = page === 'closed' || page === 'unpublished' || page === 'login';
    
    if (!isErrorPage) {
      // 【修正】サイト全体非公開チェックを先に実行
      if (config.siteWidePublished === false) {
        res.writeHead(302, {
          Location: '/closed.html'
        });
        res.end();
        return;
      }
 
      // 【修正】個別ページ非公開チェック（page 名が正規化されているので一致するはず）
      if (config.pages?.[page] === false) {
        res.writeHead(302, {
          Location: '/unpublished.html'
        });
        res.end();
        return;
      }
    }
  }

  
  if (rejectCrossOriginWrite(req, res)) return;

  // ログイン時以外の不要なセッションの蓄積を防ぐため、静的ファイル読み込み時のみ匿名を発行
  if (req.method === 'GET' && !pathname.startsWith('/api')) {
    const cookies = getCookies(req);
    let visitorId = String(cookies[SESSION_COOKIE_NAME] || '').trim();

    if (!visitorId) {
      visitorId = createVisitorSession(req, res) || '';
    } else {
      const sessionRow = db.prepare(`
        SELECT id, expires_at
        FROM sessions
        WHERE id = ?
      `).get(visitorId);

      if (!sessionRow || isExpired(sessionRow.expires_at)) {
        visitorId = createVisitorSession(req, res) || visitorId;
      }
    }

    ensureVisitorRecord(visitorId, req);
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
      const purpose = String(payload.purpose || '');

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

      if (purpose === 'admin' && user.role === 'staff') {

    logEvent('login_blocked_staff', {
        username: user.username,
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
    });

    return sendJson(res, 403, {
        ok: false,
        error: 'Staff users cannot access admin panel'
    });

}

     /*  if (user.role === 'staff') {
        logEvent('login_blocked_staff', {
          username: user.username,
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
      });

  return sendJson(res, 403, {
    ok: false,
    error: 'Staff users cannot log in'
  });
} */

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
        INSERT INTO sessions (id, user_id, username, role, scope, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
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

  //アナウンス認証状態
  if (
    pathname === "/api/auth/check-announcement-access" &&
    req.method === "GET"
) {
    requirePermission(req, res, "announcement.create", (user) => {

        return sendJson(res, 200, {
            ok: true,
            username: user.username,
            role: user.role
        });

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
            INSERT INTO users (username, password_hash, role, scope, created_at)
            VALUES (?, ?, ?, ?, datetime('now', '+9 hours'))
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

      // アンケート属性を抽出
      const attributes = (payload && typeof payload.attributes === 'object') ? payload.attributes : {};
      const surveyAge = String(attributes.age || '').trim() || null;
      const surveyDiscovery = String(attributes.discovery || '').trim() || null;
      const surveyArea = String(attributes.area || '').trim() || null;

      if (type === 'visit') {
        db.prepare(`
          INSERT INTO stamp_visits (stamp_id, stamp_name, session_id, user_agent, page, survey_age, survey_discovery, survey_area, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
        `).run(stampId, stampName, sessionId || null, userAgent, page || null, surveyAge, surveyDiscovery, surveyArea);

        logEvent('stamp_visit', {
          sessionId,
          userAgent,
          page,
          detail: JSON.stringify({ stampId, stampName, attributes: { surveyAge, surveyDiscovery, surveyArea } })
        });

        return sendJson(res, 200, { ok: true });
      }

      // click / jump はどちらも stamp_clicks に記録（後方互換）
      if (type === 'click' || type === 'jump') {
        db.prepare(`
          INSERT INTO stamp_clicks (stamp_id, stamp_name, session_id, user_agent, page, survey_age, survey_discovery, survey_area, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
        `).run(stampId, stampName, sessionId || null, userAgent, page || null, surveyAge, surveyDiscovery, surveyArea);

        logEvent(`stamp_${type}`, {
          sessionId,
          userAgent,
          page,
          detail: JSON.stringify({ stampId, stampName, attributes: { surveyAge, surveyDiscovery, surveyArea } })
        });

        return sendJson(res, 200, { ok: true });
      }

      sendJson(res, 400, { ok: false, error: 'Unknown type' });
    });
    return;
  }

  // POST /api/stamp-survey
  // スタンプラリー開始前の任意アンケートをセッションに保存
  if (pathname === '/api/stamp-survey' && req.method === 'POST') {
    parseBody(req, (error, payload) => {
      if (error) {
        return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });
      }

      let sessionId = String(getCookies(req)[SESSION_COOKIE_NAME] || '');

      if (!sessionId) {
        sessionId = createVisitorSession(req, res) || '';
      }

      if (!sessionId) {
        return sendJson(res, 500, { ok: false, error: 'Failed to create session' });
      }

      const rawAttributes = payload && payload.attributes && typeof payload.attributes === 'object'
        ? payload.attributes
        : null;

      const normalizedAttributes = rawAttributes
        ? Object.fromEntries(
            Object.entries(rawAttributes)
              .map(([key, value]) => [String(key).trim(), String(value || '').trim()])
              .filter(([key, value]) => key && value)
          )
        : null;

      const attributesJson = normalizedAttributes && Object.keys(normalizedAttributes).length
        ? JSON.stringify(normalizedAttributes)
        : null;

      const existingSession = db.prepare(`
        SELECT id FROM sessions WHERE id = ?
      `).get(sessionId);

      if (!existingSession) {
        db.prepare(`
          INSERT INTO sessions (id, user_id, username, role, scope, expires_at, created_at)
          VALUES (?, NULL, 'anonymous', 'visitor', 'all', ?, datetime('now', '+9 hours'))
        `).run(sessionId, getExpiresAt());
      }

      db.prepare(`
        UPDATE sessions
        SET profile_attributes = ?
        WHERE id = ?
      `).run(attributesJson, sessionId);

      logEvent('stamp_survey', {
        sessionId,
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: attributesJson || 'null'
      });

      return sendJson(res, 200, {
        ok: true,
        attributes: normalizedAttributes || null
      });
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
  if (pathname === '/api/admin/events' && req.method === 'GET') {
    requirePermission(req, res, 'analytics.read', (user) => {
      const scopeList = getScopeList(user.scope);
      const activeStampIds = new Set(COMPANY_MASTER.map(item => item.id));

      const filterByCompanyMaster = (rows) => rows.filter(item => activeStampIds.has(item.stamp_id));

      if (user.role === 'administrator') {
        const visits = filterByCompanyMaster(db.prepare(`
          SELECT sv.*, s.username, s.profile_attributes AS attributes
          FROM stamp_visits sv
          LEFT JOIN sessions s ON sv.session_id = s.id
          ORDER BY sv.id DESC LIMIT 100
        `).all());
        const clicks = filterByCompanyMaster(db.prepare(`
          SELECT sc.*, s.username, s.profile_attributes AS attributes
          FROM stamp_clicks sc
          LEFT JOIN sessions s ON sc.session_id = s.id
          ORDER BY sc.id DESC LIMIT 100
        `).all());

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
      const visitsAll = filterByCompanyMaster(db.prepare(`
        SELECT sv.*, s.username, s.profile_attributes AS attributes
        FROM stamp_visits sv
        LEFT JOIN sessions s ON sv.session_id = s.id
        ORDER BY sv.id DESC LIMIT 1000
      `).all());
      const clicksAll = filterByCompanyMaster(db.prepare(`
        SELECT sc.*, s.username, s.profile_attributes AS attributes
        FROM stamp_clicks sc
        LEFT JOIN sessions s ON sc.session_id = s.id
        ORDER BY sc.id DESC LIMIT 1000
      `).all());

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
        INSERT INTO posts (content, status, risk_score, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+9 hours'), datetime('now', '+9 hours'))
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

  // POST /api/posts/:id/reactions
  // 投稿へのリアクション追加（匿名可・Cookieセッション単位で各種1回まで）
  if (pathname.match(/^\/api\/posts\/(\d+)\/reactions$/) && req.method === 'POST') {
    const match = pathname.match(/^\/api\/posts\/(\d+)\/reactions$/);
    const postId = parseInt(match[1], 10);

    parseBody(req, (err, payload) => {
      if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

      const reactionType = String(payload.reaction_type || payload.reactionType || '').toLowerCase();
      if (!['thumbs_up', 'heart'].includes(reactionType)) {
        return sendJson(res, 400, { ok: false, error: 'Invalid reaction type' });
      }

      let sessionId = String(getCookies(req)[SESSION_COOKIE_NAME] || '').trim();
      if (!sessionId) {
        sessionId = createVisitorSession(req, res) || '';
      }

      if (!sessionId) {
        return sendJson(res, 500, { ok: false, error: 'Failed to create session' });
      }

      const post = db.prepare(`SELECT id, status FROM posts WHERE id = ?`).get(postId);
      if (!post || post.status !== 'published') {
        return sendJson(res, 404, { ok: false, error: 'Post not found' });
      }

      const existingReaction = db.prepare(`
        SELECT reaction_type
        FROM post_reactions
        WHERE post_id = ? AND session_id = ?
      `).get(postId, sessionId);

      if (existingReaction) {
        if (existingReaction.reaction_type === reactionType) {
          const summary = getPostReactionSummary(postId, sessionId);
          return sendJson(res, 200, {
            ok: true,
            added: false,
            alreadyReacted: true,
            reaction_type: reactionType,
            ...summary
          });
        }

        return sendJson(res, 409, {
          ok: false,
          error: 'Already reacted',
          reaction_type: existingReaction.reaction_type
        });
      }

      const result = db.prepare(`
        INSERT OR IGNORE INTO post_reactions
        (post_id, session_id, reaction_type, created_at, updated_at)
        VALUES (?, ?, ?, datetime('now', '+9 hours'), datetime('now', '+9 hours'))
      `).run(postId, sessionId, reactionType);

      const summary = getPostReactionSummary(postId, sessionId);

      return sendJson(res, 200, {
        ok: true,
        added: result.changes > 0,
        alreadyReacted: result.changes === 0,
        reaction_type: reactionType,
        ...summary
      });
    });
    return;
  }

  // GET /api/posts
  // 投稿一覧（公開済みのみ・認証不要）
  if (pathname === '/api/posts' && req.method === 'GET') {
    const sessionId = String(getCookies(req)[SESSION_COOKIE_NAME] || '').trim() || null;
    const status = url.searchParams.get('status') || 'published';
    const search = url.searchParams.get('search') || '';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const posts = getPostsSub({
      status: status === 'all' ? null : status,
      search,
      limit,
      sessionId
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
          UPDATE posts SET status = ?, updated_at = datetime('now', '+9 hours') WHERE id = ?
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

      const posts = getPostsSub({
        status: status || null,
        search,
        limit
      });

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

  // DELETE /api/admin/posts/:id
  // 投稿の物理削除（announcement.manage 権限）
  if (pathname.match(/^\/api\/admin\/posts\/(\d+)$/) && req.method === 'DELETE') {
    requirePermission(req, res, 'announcement.manage', (user) => {
      const match = pathname.match(/^\/api\/admin\/posts\/(\d+)$/);
      const postId = parseInt(match[1], 10);

      const post = db.prepare(`SELECT id, status FROM posts WHERE id = ?`).get(postId);
      if (!post) {
        return sendJson(res, 404, { ok: false, error: 'Post not found' });
      }

      db.prepare(`DELETE FROM post_reactions WHERE post_id = ?`).run(postId);
      db.prepare(`DELETE FROM moderation_logs WHERE post_id = ?`).run(postId);
      db.prepare(`DELETE FROM post_aggregations WHERE representative_post_id = ?`).run(postId);
      db.prepare(`DELETE FROM posts WHERE id = ?`).run(postId);

      logEvent('post_deleted', {
        username: user.username,
        sessionId: getCookies(req)[SESSION_COOKIE_NAME],
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: JSON.stringify({ postId, oldStatus: post.status })
      });

      return sendJson(res, 200, { ok: true });
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
          INSERT INTO announcements (title, content, importance, published_at, expires_at, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'), datetime('now', '+9 hours'))
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
          SET title = ?, content = ?, importance = ?, expires_at = ?, updated_at = datetime('now', '+9 hours')
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
          INSERT INTO ng_rules (pattern, is_regex, risk_score, enabled, description, created_at)
          VALUES (?, ?, ?, 1, ?, datetime('now', '+9 hours'))
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

 // GET /api/admin/publish - ページ公開状態取得（管理者のみ）
  if (req.url === '/api/admin/publish' && req.method === 'GET') {
    const user = getSessionUser(req);
    if (!user || !hasPermission(user, 'control')) {
      return sendJson(res, 403, { ok: false, error: 'Forbidden' });
    }
 
    const config = loadConfig();
    return sendJson(res, 200, {
      ok: true,
      pages: config.pages || {},
      siteWidePublished: config.siteWidePublished !== false
    });
  }
 
  // POST /api/admin/publish - ページ公開状態更新（管理者のみ）
   if (req.url === '/api/admin/publish' && req.method === 'POST') {
    const user = getSessionUser(req);
    if (!user || !hasPermission(user, 'control')) {
      return sendJson(res, 403, { ok: false, error: 'Forbidden' });
    }
 
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > BODY_LIMIT_BYTES) {
        req.destroy();
      }
    });
 
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const config = loadConfig();
 
        // 【修正】page 名を小文字に正規化してから保存
        if (data.page !== undefined) {
          const normalizedPage = String(data.page).toLowerCase().trim();
          
          if (!normalizedPage) {
            return sendJson(res, 400, { ok: false, error: 'Invalid page name' });
          }
          
          config.pages = config.pages || {};
          config.pages[normalizedPage] = Boolean(data.published);
          
          console.log(`[Publish] Page '${data.page}' normalized to '${normalizedPage}', published: ${config.pages[normalizedPage]}`);
          
          logEvent('page_published_toggled', {
            username: user.username,
            sessionId: getCookies(req)[SESSION_COOKIE_NAME],
            userAgent: req.headers['user-agent'] || '',
            page: '/api/admin/publish',
            detail: JSON.stringify({ 
              originalPage: data.page,
              normalizedPage: normalizedPage, 
              published: config.pages[normalizedPage] 
            })
          });
        }
 
        // サイト全体非公開フラグの更新
        if (data.siteWidePublished !== undefined) {
          config.siteWidePublished = Boolean(data.siteWidePublished);
          
          console.log(`[Publish] Site-wide published: ${config.siteWidePublished}`);
          
          logEvent('site_published_toggled', {
            username: user.username,
            sessionId: getCookies(req)[SESSION_COOKIE_NAME],
            userAgent: req.headers['user-agent'] || '',
            page: '/api/admin/publish',
            detail: JSON.stringify({ siteWidePublished: config.siteWidePublished })
          });
        }
 
        // 【修正】ファイル書き込みエラーハンドリング
        try {
          fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        } catch (writeErr) {
          console.error('[Error] Failed to write config.json:', writeErr);
          return sendJson(res, 500, { 
            ok: false, 
            error: 'Failed to save configuration' 
          });
        }
 
        return sendJson(res, 200, { 
          ok: true,
          message: 'Configuration updated successfully',
          config: {
            pages: config.pages,
            siteWidePublished: config.siteWidePublished
          }
        });
      } catch (e) {
        console.error('[Error] Error updating publish config:', e);
        return sendJson(res, 400, { ok: false, error: 'Invalid request' });
      }
    });
 
    req.on('error', (e) => {
      console.error('[Error] Request error:', e);
      return sendJson(res, 500, { ok: false, error: 'Internal server error' });
    });
 
    return;
  }
 
 

  // ──────────────────────────────────────────────────────────────────────────
  // 訪問者識別・スタンプラリー・抽選連携 API
  // ──────────────────────────────────────────────────────────────────────────

  // POST /api/visitor/register - 訪問者を登録または更新（UUID をサーバー側で管理）
  if (req.url === '/api/visitor/register' && req.method === 'POST') {
    parseBody(req, (err, payload) => {
      if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

      let visitorId = String(payload.visitor_id || getCookies(req)[SESSION_COOKIE_NAME] || '').trim();
      if (!visitorId) {
        visitorId = createVisitorSession(req, res) || '';
      }

      if (!visitorId) {
        return sendJson(res, 400, { ok: false, error: 'visitor_id is required' });
      }

      try {
        const isNew = ensureVisitorRecord(visitorId, req);

        return sendJson(res, isNew ? 201 : 200, {
          ok: true,
          message: isNew ? 'Visitor registered' : 'Visitor already registered',
          visitor_id: visitorId,
          is_new: isNew
        });
      } catch (e) {
        console.error('Error registering visitor:', e);
        return sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
    });
    return;
  }

  // POST /api/stamp/acquire - スタンプを取得
  if (req.url === '/api/stamp/acquire' && req.method === 'POST') {
    parseBody(req, (err, payload) => {
      if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

      let visitorId = String(payload.visitor_id || getCookies(req)[SESSION_COOKIE_NAME] || '').trim();
      const companyId = String(payload.company_id || '').trim();

      if (!visitorId) {
        visitorId = createVisitorSession(req, res) || '';
      }

      if (!visitorId) {
        return sendJson(res, 400, { ok: false, error: 'visitor_id is required' });
      }
      if (!companyId) {
        return sendJson(res, 400, { ok: false, error: 'company_id is required' });
      }

      try {
        ensureVisitorRecord(visitorId, req);

        // セッションからアンケート属性を取得
        const session = db.prepare('SELECT profile_attributes FROM sessions WHERE id = ?').get(visitorId);
        let surveyAge = null;
        let surveyDiscovery = null;
        let surveyArea = null;

        if (session && session.profile_attributes) {
          try {
            const attributes = JSON.parse(session.profile_attributes);
            surveyAge = attributes.age || null;
            surveyDiscovery = attributes.discovery || null;
            surveyArea = attributes.area || null;
          } catch (e) {
            // JSON パース失敗時は無視
          }
        }

        // スタンプが既に取得されているか確認
        const existingStamp = db.prepare(
          'SELECT * FROM stamp_visits WHERE visitor_id = ? AND company_id = ?'
        ).get(visitorId, companyId);

        if (existingStamp) {
          return sendJson(res, 400, { 
            ok: false, 
            error: 'Stamp already acquired for this company',
            stamp: existingStamp
          });
        }

        // スタンプを記録
        const result = db.prepare(`
          INSERT INTO stamp_visits (stamp_id, stamp_name, session_id, visitor_id, company_id, survey_age, survey_discovery, survey_area, user_agent, page, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+9 hours'))
        `).run(
          companyId,
          LOCATION_LABELS[companyId] || companyId,
          visitorId,
          visitorId,
          companyId,
          surveyAge,
          surveyDiscovery,
          surveyArea,
          req.headers['user-agent'] || '',
          req.url
        );

        logEvent('stamp_acquired', {
          username: null,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ 
            visitor_id: visitorId, 
            company_id: companyId,
            survey_age: surveyAge,
            survey_discovery: surveyDiscovery,
            survey_area: surveyArea
          })
        });

        return sendJson(res, 201, { 
          ok: true, 
          message: 'Stamp acquired',
          stamp_id: result.lastInsertRowid,
          visitor_id: visitorId,
          company_id: companyId
        });
      } catch (e) {
        console.error('Error acquiring stamp:', e);
        return sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
    });
    return;
  }

  // GET /api/stamp/status/:visitorId - スタンプ取得状況を確認
  if (pathname.match(/^\/api\/stamp\/status\/(.+)$/) && req.method === 'GET') {
    const match = pathname.match(/^\/api\/stamp\/status\/(.+)$/);
    const visitorId = decodeURIComponent(match[1]);

    try {
      const visitor = db.prepare('SELECT * FROM visitors WHERE visitor_id = ?').get(visitorId);
      if (!visitor) {
        return sendJson(res, 404, { ok: false, error: 'Visitor not found' });
      }

      const stamps = db.prepare(
        'SELECT * FROM stamp_visits WHERE visitor_id = ? AND company_id IS NOT NULL ORDER BY created_at ASC'
      ).all(visitorId);

      const totalCompanies = COMPANY_MASTER.length;
      const acquiredCount = stamps.length;
      const achievementRate = totalCompanies > 0 ? (acquiredCount / totalCompanies) * 100 : 0;

      return sendJson(res, 200, {
        ok: true,
        visitor_id: visitorId,
        stamps: stamps,
        acquired_count: acquiredCount,
        total_companies: totalCompanies,
        achievement_rate: achievementRate.toFixed(2),
        created_at: visitor.created_at,
        last_seen: visitor.last_seen
      });
    } catch (e) {
      console.error('Error fetching stamp status:', e);
      return sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  }
  if (pathname.match(/^\/api\/stamp\/status\/(.+)$/) && req.method === 'GET') return;

  // POST /api/lottery/entry - 抽選にエントリー
  if (req.url === '/api/lottery/entry' && req.method === 'POST') {
    parseBody(req, (err, payload) => {
      if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

      const visitorId = String(payload.visitor_id || '').trim();
      if (!visitorId) {
        return sendJson(res, 400, { ok: false, error: 'visitor_id is required' });
      }

      try {
        // 訪問者が存在するか確認
        const visitor = db.prepare('SELECT * FROM visitors WHERE visitor_id = ?').get(visitorId);
        if (!visitor) {
          return sendJson(res, 404, { ok: false, error: 'Visitor not found' });
        }

        const existingEntry = db.prepare(
          'SELECT * FROM lottery WHERE visitor_id = ? ORDER BY entry_time DESC LIMIT 1'
        ).get(visitorId);

        if (existingEntry) {
          return sendJson(res, 200, {
            ok: true,
            message: 'Lottery entry already exists',
            lottery_id: existingEntry.id,
            visitor_id: visitorId,
            lottery_number: existingEntry.lottery_number,
            weight: parseFloat(Number(existingEntry.weight).toFixed(4)),
            acquired_stamps: db.prepare(
              'SELECT COUNT(*) as count FROM stamp_visits WHERE visitor_id = ? AND company_id IS NOT NULL'
            ).get(visitorId).count,
            total_companies: COMPANY_MASTER.length,
            existing: true
          });
        }

        // スタンプ取得履歴を取得
        const stamps = db.prepare(
          'SELECT COUNT(*) as count FROM stamp_visits WHERE visitor_id = ? AND company_id IS NOT NULL'
        ).get(visitorId);

        const acquiredCount = stamps.count;
        const totalCompanies = COMPANY_MASTER.length;

        // 重みづけを算出: 1 + (獲得数 / 全ブース数)
        const weight = 1 + (acquiredCount / totalCompanies);

        const createLotteryEntry = (entryVisitorId, entryWeight) => {
          db.exec('BEGIN IMMEDIATE TRANSACTION');

          try {
            const insertResult = db.prepare(`
              INSERT INTO lottery (visitor_id, lottery_number, weight, entry_time)
              VALUES (?, ?, ?, datetime('now', '+9 hours'))
            `).run(entryVisitorId, `pending-${crypto.randomUUID()}`, entryWeight);

            const lotteryId = Number(insertResult.lastInsertRowid);
            const lotteryNumber = formatLotteryNumberFromId(lotteryId);

            db.prepare(`
              UPDATE lottery
              SET lottery_number = ?
              WHERE id = ?
            `).run(lotteryNumber, lotteryId);

            db.exec('COMMIT');
            return { lotteryId, lotteryNumber };
          } catch (error) {
            try {
              db.exec('ROLLBACK');
            } catch (rollbackError) {
              console.error('Failed to rollback lottery insert', rollbackError);
            }
            throw error;
          }
        };

        const createdEntry = createLotteryEntry(visitorId, weight);
        const lotteryNumber = createdEntry.lotteryNumber;

        logEvent('lottery_entry', {
          username: null,
          sessionId: getCookies(req)[SESSION_COOKIE_NAME],
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: JSON.stringify({ 
            visitor_id: visitorId, 
            lottery_number: lotteryNumber,
            weight: weight,
            acquired_count: acquiredCount,
            total_companies: totalCompanies
          })
        });

        return sendJson(res, 201, {
          ok: true,
          message: 'Lottery entry successful',
          lottery_id: createdEntry.lotteryId,
          visitor_id: visitorId,
          lottery_number: lotteryNumber,
          weight: parseFloat(weight.toFixed(4)),
          acquired_stamps: acquiredCount,
          total_companies: totalCompanies
        });
      } catch (e) {
        console.error('Error entering lottery:', e);
        return sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
    });
    return;
  }

  // GET /api/lottery/entry/:visitorId - 訪問者の抽選エントリー状況を確認
  if (pathname.match(/^\/api\/lottery\/entry\/(.+)$/) && req.method === 'GET') {
    const match = pathname.match(/^\/api\/lottery\/entry\/(.+)$/);
    const visitorId = decodeURIComponent(match[1]);

    try {
      const entries = db.prepare(
        'SELECT * FROM lottery WHERE visitor_id = ? ORDER BY entry_time DESC'
      ).all(visitorId);

      return sendJson(res, 200, {
        ok: true,
        visitor_id: visitorId,
        entries: entries,
        entry_count: entries.length
      });
    } catch (e) {
      console.error('Error fetching lottery entries:', e);
      return sendJson(res, 500, { ok: false, error: 'Internal server error' });
    }
  }
  if (pathname.match(/^\/api\/lottery\/entry\/(.+)$/) && req.method === 'GET') return;

  // GET /api/admin/visitors - 訪問者一覧（管理者のみ）
  if (req.url === '/api/admin/visitors' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      try {
        const visitors = db.prepare(
          'SELECT COUNT(*) as total_visitors FROM visitors'
        ).get();

        const visitorList = db.prepare(
          'SELECT * FROM visitors ORDER BY last_seen DESC LIMIT 100'
        ).all();

        return sendJson(res, 200, {
          ok: true,
          total_visitors: visitors.total_visitors,
          visitors: visitorList
        });
      } catch (e) {
        console.error('Error fetching visitors:', e);
        return sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
    });
    return;
  }

  // GET /api/admin/lottery-list - 抽選エントリー一覧（管理者のみ）
  if (req.url === '/api/admin/lottery-list' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      try {
        const entries = db.prepare(`
          SELECT l.*, v.created_at as visitor_created_at
          FROM lottery l
          JOIN visitors v ON l.visitor_id = v.visitor_id
          ORDER BY l.entry_time DESC
        `).all();

        const totalEntries = entries.length;
        const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);

        return sendJson(res, 200, {
          ok: true,
          total_entries: totalEntries,
          total_weight: parseFloat(totalWeight.toFixed(4)),
          entries: entries
        });
      } catch (e) {
        console.error('Error fetching lottery entries:', e);
        return sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
    });
    return;
  }

  // GET /api/admin/stamp-analytics - スタンプ取得状況の分析（管理者のみ）
  if (req.url === '/api/admin/stamp-analytics' && req.method === 'GET') {
    requireRole(req, res, 'administrator', (user) => {
      try {
        // 各ブースのスタンプ取得数
        const companyStats = db.prepare(`
          SELECT company_id, COUNT(*) as stamp_count
          FROM stamp_visits
          WHERE company_id IS NOT NULL
          GROUP BY company_id
          ORDER BY stamp_count DESC
        `).all();

        // 訪問者別のスタンプ取得状況
        const visitorStats = db.prepare(`
          SELECT 
            v.visitor_id,
            v.created_at,
            v.last_seen,
            COUNT(sv.id) as stamps_acquired
          FROM visitors v
          LEFT JOIN stamp_visits sv ON v.visitor_id = sv.visitor_id AND sv.company_id IS NOT NULL
          GROUP BY v.visitor_id
          ORDER BY stamps_acquired DESC, v.last_seen DESC
        `).all();

        const totalVisitors = visitorStats.length;
        const totalStamps = companyStats.reduce((sum, stat) => sum + stat.stamp_count, 0);
        const averageStamps = totalVisitors > 0 ? (totalStamps / totalVisitors).toFixed(2) : 0;

        return sendJson(res, 200, {
          ok: true,
          total_visitors: totalVisitors,
          total_stamps_issued: totalStamps,
          average_stamps_per_visitor: parseFloat(averageStamps),
          total_companies: COMPANY_MASTER.length,
          company_stats: companyStats,
          visitor_stats: visitorStats.slice(0, 100) // 最初の100件
        });
      } catch (e) {
        console.error('Error fetching stamp analytics:', e);
        return sendJson(res, 500, { ok: false, error: 'Internal server error' });
      }
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
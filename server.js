const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;

const STATIC_ROOT = __dirname;
const ENV_PATH = path.join(__dirname, '.env');

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

// ルートに置かれた stamp.db を参照する
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

function hashPassword(password) {

  return crypto
    .createHash('sha256')
    .update(String(password))
    .digest('hex');
}

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

  console.log('固定管理者アカウントを作成しました');
}

function sendJson(res, statusCode, data) {

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });

  res.end(JSON.stringify(data));
}

function getFilePath(urlPath) {

  if (urlPath === '/' || urlPath === '') {

    return path.join(STATIC_ROOT, 'index.html');
  }

  const clean =
    decodeURIComponent(urlPath)
      .replace(/^\//, '');

  return path.join(STATIC_ROOT, clean);
}

function serveStatic(res, filePath) {

  fs.readFile(filePath, (error, data) => {

    if (error) {

      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
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

    // 保持されているヘッダー（例: Set-Cookie）があればマージして送信する
    const headers = { 'Content-Type': contentType };
    const existingSetCookie = res.getHeader && res.getHeader('Set-Cookie');
    if (existingSetCookie) headers['Set-Cookie'] = existingSetCookie;

    res.writeHead(200, headers);

    res.end(data);
  });
}

function createVisitorSession(res) {
  try {
    const sessionId = crypto.randomUUID();

    db.prepare(`
      INSERT INTO sessions (id, username, role, scope)
      VALUES (?, ?, ?, ?)
    `).run(sessionId, 'anonymous', 'visitor', 'entrance,museum');

    // クライアントに Cookie を送る（既存のヘッダーがあっても setHeader で追加）
    // note: serveStatic 側で既存 Set-Cookie を維持する実装を行っている
    try {
      const cookie = `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`;
      const prev = res.getHeader && res.getHeader('Set-Cookie');
      if (prev) {
        // 既存が配列か文字列に対応
        const merged = Array.isArray(prev) ? prev.concat(cookie) : [prev, cookie];
        res.setHeader('Set-Cookie', merged);
      } else {
        res.setHeader('Set-Cookie', cookie);
      }
    } catch (e) {
      // header 設定失敗は無視
    }

    return sessionId;
  } catch (e) {
    console.error('Visitor session creation failed', e);
    return null;
  }
}

function parseBody(req, callback) {

  let body = '';

  req.on('data', chunk => {
    body += chunk.toString();
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
    cookies.session_id;

  if (!sessionId) {
    return null;
  }

  const row = db.prepare(`
    SELECT username, role, scope
    FROM sessions
    WHERE id = ?
  `).get(sessionId);

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

  // リクエストごとに匿名セッションを発行してCookieを返す（クライアント側の自前 sessionId を廃止する方針に合わせる）
  let issuedSessionId = null;
  try {
    const cookies = getCookies(req);
    if (!cookies.session_id) {
      issuedSessionId = createVisitorSession(res);
    }
  } catch (e) {
    // 無視
  }

  if (
    pathname === '/api/login' &&
    req.method === 'POST'
  ) {

    parseBody(req, (error, payload) => {

      if (error) {

        return sendJson(res, 400, {
          ok: false,
          error: 'Invalid JSON'
        });
      }

      const username =
        String(payload.username || '')
          .trim();

      const passwordHash =
        hashPassword(
          String(payload.password || '')
        );

      const user = db.prepare(`
        SELECT username, role, scope
        FROM users
        WHERE username = ?
        AND password_hash = ?
      `).get(username, passwordHash);

      if (!user) {

        return sendJson(res, 401, {
          ok: false,
          error: 'Invalid credentials'
        });
      }

      const sessionId =
        crypto.randomUUID();

      db.prepare(`
        INSERT INTO sessions (
          id,
          username,
          role,
          scope
        )
        VALUES (?, ?, ?, ?)
      `).run(
        sessionId,
        user.username,
        user.role,
        user.scope || 'entrance,museum'
      );

      logEvent('login', {
        username: user.username,
        sessionId,
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'login_success'
      });

      res.writeHead(200, {

        'Content-Type':
          'application/json; charset=utf-8',

        'Set-Cookie':
          `session_id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
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

    const sessionId = getCookies(req).session_id;

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
      'Set-Cookie': 'session_id=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
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
        sessionId: getCookies(req).session_id,
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
        const scope = String(payload.scope || 'entrance,museum');

        if (!newUsername || !password) {
          return sendJson(res, 400, { ok: false, error: 'username and password are required' });
        }

        const allowedRoles = ['administrator', 'senior'];

        if (!allowedRoles.includes(role)) {
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
            sessionId: getCookies(req).session_id,
            userAgent: req.headers['user-agent'] || '',
            page: pathname,
            detail: JSON.stringify({ target: newUsername, role, scope })
          });

          sendJson(res, 200, { ok: true, username: newUsername, role, scope, hashFunction: 'SHA-256' });

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
        sessionId: getCookies(req).session_id,
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

        if (row.password_hash !== hashPassword(current)) {

          return sendJson(res, 403, {
            ok: false,
            error: 'Current password is incorrect'
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

        logEvent('password_change', {
          username: user.username,
          sessionId: getCookies(req).session_id,
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
      const stampId = String(payload.stampId || '');
      // クライアントからの sessionId は廃止。Cookie または当リクエストで発行したセッションを使う
      const sessionId = String(getCookies(req).session_id || issuedSessionId || '');
      const page = String(payload.page || '');
      const userAgent = req.headers['user-agent'] || '';
      const stampName = LOCATION_LABELS[stampId] || stampId;

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

      // クライアントで 'jump' を送る実装があるため、互換性のために 'jump' をクリック扱いで保存する
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

  // 訪問履歴と遷移（クリック/jump）履歴取得
  if (pathname === '/api/stamp-history' && req.method === 'GET') {
    const querySessionId = url.searchParams.get('sessionId');
    const targetSessionId = querySessionId || getCookies(req).session_id || null;
    const authUser = getSessionUser(req);

    // 管理者は全件取得
    if (authUser && authUser.role === 'administrator') {
      const visits = db.prepare(`SELECT sv.*, s.username FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id ORDER BY sv.id DESC LIMIT 1000`).all();
      const clicks = db.prepare(`SELECT sc.*, s.username FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id ORDER BY sc.id DESC LIMIT 1000`).all();
      return sendJson(res, 200, { ok: true, visits, clicks });
    }

    // 認証済みユーザーは自分のセッション全て
    if (authUser) {
      const sessions = db.prepare(`SELECT id FROM sessions WHERE username = ?`).all(authUser.username).map(r => r.id);
      if (!sessions.length) return sendJson(res, 200, { ok: true, visits: [], clicks: [] });

      const placeholders = sessions.map(() => '?').join(',');
      const visits = db.prepare(`SELECT sv.*, s.username FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id WHERE sv.session_id IN (${placeholders}) ORDER BY sv.id DESC LIMIT 1000`).all(...sessions);
      const clicks = db.prepare(`SELECT sc.*, s.username FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id WHERE sc.session_id IN (${placeholders}) ORDER BY sc.id DESC LIMIT 1000`).all(...sessions);

      return sendJson(res, 200, { ok: true, visits, clicks });
    }

    // 非認証は sessionId 必須
    if (!targetSessionId) return sendJson(res, 400, { ok: false, error: 'sessionId is required' });

    const visits = db.prepare(`SELECT sv.*, s.username FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id WHERE sv.session_id = ? ORDER BY sv.id DESC LIMIT 1000`).all(targetSessionId);
    const clicks = db.prepare(`SELECT sc.*, s.username FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id WHERE sc.session_id = ? ORDER BY sc.id DESC LIMIT 1000`).all(targetSessionId);

    return sendJson(res, 200, { ok: true, visits, clicks });
  }
  if (pathname === '/api/admin/summary') {

    requireSession(req, res, (user) => {
      logEvent('admin_access', {
        username: user && user.username,
        sessionId: getCookies(req).session_id,
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_summary'
      });

      sendJson(res, 200, getSummary(user));
    });

    return;
  }

  if (pathname === '/api/admin/events') {

    requireSession(req, res, (user) => {
      const scopeList = getScopeList(user.scope);

      if (user.role === 'administrator') {
        const visits = db.prepare(`SELECT sv.*, s.username, s.demographic FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id ORDER BY sv.id DESC LIMIT 100`).all();
        const clicks = db.prepare(`SELECT sc.*, s.username, s.demographic FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id ORDER BY sc.id DESC LIMIT 100`).all();

        logEvent('admin_access', {
          username: user && user.username,
          sessionId: getCookies(req).session_id,
          userAgent: req.headers['user-agent'] || '',
          page: pathname,
          detail: 'view_events'
        });

        return sendJson(res, 200, { visits, clicks });
      }

      // 非管理者は scope に基づいて絞る
      const visitsAll = db.prepare(`SELECT sv.*, s.username, s.demographic FROM stamp_visits sv LEFT JOIN sessions s ON sv.session_id = s.id ORDER BY sv.id DESC LIMIT 1000`).all();
      const clicksAll = db.prepare(`SELECT sc.*, s.username, s.demographic FROM stamp_clicks sc LEFT JOIN sessions s ON sc.session_id = s.id ORDER BY sc.id DESC LIMIT 1000`).all();

      const visits = visitsAll.filter(item => !scopeList || scopeList.includes(item.stamp_id));
      const clicks = clicksAll.filter(item => !scopeList || scopeList.includes(item.stamp_id));

      logEvent('admin_access', {
        username: user && user.username,
        sessionId: getCookies(req).session_id,
        userAgent: req.headers['user-agent'] || '',
        page: pathname,
        detail: 'view_events'
      });

      sendJson(res, 200, { visits, clicks });
    });

    return;
  }

  // 管理者によるイベント削除（訪問/遷移）
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
          sessionId: getCookies(req).session_id,
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
        // サポート: JSON ボディ { before: 'YYYY-MM-DDTHH:MM:SS' } を受け付ける
        parseBody(req, (err, payload) => {
          if (err) return sendJson(res, 400, { ok: false, error: 'Invalid JSON' });

          if (payload && payload.before) {
            db.prepare(`DELETE FROM logs WHERE created_at < ?`).run(payload.before);
          } else {
            db.prepare(`DELETE FROM logs`).run();
          }

          logEvent('admin_delete_logs', {
            username: user && user.username,
            sessionId: getCookies(req).session_id,
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

  // サイト（静的ファイル）への通常アクセスはログに残す
  try {
    if (req.method === 'GET' && !pathname.startsWith('/api')) {
      const session = getSessionUser(req);
      logEvent('site_access', {
        username: session && session.username,
        sessionId: getCookies(req).session_id,
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
    `Server running at http://localhost:${PORT}`
  );
}); 

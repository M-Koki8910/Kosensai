#!/usr/bin/env node

/**
 * JSON ファイルからユーザを一括追加するスクリプト
 * 使用方法: node scripts/load-users-from-json.js [users.json ファイルパス]
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ========================
// 設定
// ========================

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../stamp.db');
const USERS_FILE = process.argv[2] || path.join(__dirname, './users.json');

const ALLOWED_ROLES = ['administrator', 'executivestaff', 'staff', 'company'];

// ========================
// ハッシュ関数
// ========================

function hashPassword(password) {
  const hash = crypto.createHash('sha256');
  hash.update(password, 'utf8');
  return hash.digest('hex');
}

function normalizeScope(scope) {
  if (String(scope).trim().toLowerCase() === 'all') {
    return 'all';
  }

  const raw = Array.isArray(scope) ? scope : String(scope || '').split(',');
  const allowed = raw
    .map(item => String(item).trim())
    .filter(item => item.length > 0);

  return allowed.length ? allowed.join(',') : 'all';
}

// ========================
// メイン処理
// ========================

function main() {
  console.log(`\n📝 ユーザ一括追加スクリプト\n`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Users JSON: ${USERS_FILE}\n`);

  // ファイルの存在確認
  if (!fs.existsSync(USERS_FILE)) {
    console.error(`❌ エラー: ${USERS_FILE} が見つかりません`);
    process.exit(1);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`❌ エラー: ${DB_PATH} が見つかりません`);
    process.exit(1);
  }

  // JSON ファイルを読み込む
  let usersData;
  try {
    const fileContent = fs.readFileSync(USERS_FILE, 'utf-8');
    usersData = JSON.parse(fileContent);
  } catch (e) {
    console.error(`❌ JSON パースエラー: ${e.message}`);
    process.exit(1);
  }

  // users 配列を取得
  const users = Array.isArray(usersData) ? usersData : usersData.users || [];

  if (users.length === 0) {
    console.error(`❌ エラー: JSON に users がありません`);
    process.exit(1);
  }

  console.log(`📦 ${users.length} 件のユーザを読み込みました\n`);

  // DB を開く
  const db = new DatabaseSync(DB_PATH);

  const results = {
    success: [],
    error: [],
    skipped: []
  };

  // 各ユーザを処理
  for (const userPayload of users) {
    try {
      const result = addUser(db, userPayload);
      if (result.ok) {
        results.success.push({
          username: userPayload.username,
          role: userPayload.role,
          message: result.message
        });
      } else {
        results.error.push({
          username: userPayload.username,
          message: result.message
        });
      }
    } catch (e) {
      results.error.push({
        username: userPayload.username,
        message: `例外: ${e.message}`
      });
    }
  }

  // 結果を表示
  console.log(`\n📊 結果\n`);
  console.log(`✅ 成功: ${results.success.length} 件`);
  if (results.success.length > 0) {
    results.success.forEach(r => {
      console.log(`   - ${r.username} (${r.role})`);
    });
  }

  console.log(`\n❌ エラー: ${results.error.length} 件`);
  if (results.error.length > 0) {
    results.error.forEach(r => {
      console.log(`   - ${r.username}: ${r.message}`);
    });
  }

  console.log(`\n⏭️  スキップ: ${results.skipped.length} 件\n`);

  // DB を閉じる
  db.close();

  // 終了コード
  process.exit(results.error.length > 0 ? 1 : 0);
}

/**
 * ユーザを DB に追加
 */
function addUser(db, payload) {
  // バリデーション
  const newUsername = String(payload.username || '').trim();
  const password = String(payload.password_hash || '').trim();
  const role = String(payload.role || 'staff').toLowerCase();
  const scope = normalizeScope(payload.scope || 'all');
  const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];

  if (!newUsername) {
    return { ok: false, message: 'ユーザ名が空です' };
  }

  if (!password) {
    return { ok: false, message: 'パスワードが空です' };
  }

  if (newUsername.length < 3) {
    return { ok: false, message: 'ユーザ名は 3 文字以上である必要があります' };
  }

  if (!ALLOWED_ROLES.includes(role)) {
    return { ok: false, message: `無効なロール: ${role}` };
  }

  // 既存ユーザの確認
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(newUsername);
  if (existing) {
    return { ok: false, message: '既に存在します' };
  }

  // ロール別の scope 正規化
  const finalScope = (role === 'company') ? scope : 'all';

  // ユーザ挿入
  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, role, scope)
    VALUES (?, ?, ?, ?)
  `);

  try {
    const result = insertUser.run(
      newUsername,
      hashPassword(password),
      role,
      finalScope
    );

    const userId = result.lastInsertRowid;

    // 個別権限を登録
    const insertPermission = db.prepare(`
      INSERT OR IGNORE INTO user_permissions (user_id, permission)
      VALUES (?, ?)
    `);

    for (const permission of permissions) {
      insertPermission.run(userId, permission);
    }

    return {
      ok: true,
      message: `✅ 追加完了 (role: ${role}, scope: ${finalScope})`
    };
  } catch (e) {
    return { ok: false, message: `DB エラー: ${e.message}` };
  }
}

// 実行
main();
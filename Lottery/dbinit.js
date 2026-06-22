/**
 * db-init-standalone.js
 * 
 * better-sqlite3 用DB初期化スクリプト
 * 
 * 実行方法:
 *   node db-init-standalone.js
 */

const { Database } = require('node:sqlite');
//const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DATABASE_PATH || './data/lottery.db';
const dbDir = path.dirname(DB_PATH);

// ディレクトリ作成
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  console.log(`📁 Created directory: ${dbDir}`);
}

// DB接続
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('✅ Database connected:', DB_PATH);

try {
  console.log('\n📋 Creating tables...\n');

  // 1. participants テーブル
  db.exec(`
    DROP TABLE IF EXISTS participants
  `);
  db.exec(`
    CREATE TABLE participants (
      ticket_no        INTEGER PRIMARY KEY AUTOINCREMENT,
      token            TEXT UNIQUE NOT NULL,
      stamp_count      INTEGER DEFAULT 0,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Created table: participants');

  // 2. prizes テーブル
  db.exec(`
    DROP TABLE IF EXISTS prizes
  `);
  db.exec(`
    CREATE TABLE prizes (
      prize_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      description      TEXT,
      stock            INTEGER NOT NULL,
      allocated        INTEGER DEFAULT 0,
      rank             INTEGER,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Created table: prizes');

  // 3. lottery_results テーブル
  db.exec(`
    DROP TABLE IF EXISTS lottery_results
  `);
  db.exec(`
    CREATE TABLE lottery_results (
      ticket_no        INTEGER PRIMARY KEY,
      prize_id         INTEGER,
      win_flag         BOOLEAN DEFAULT 0,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_no) REFERENCES participants(ticket_no),
      FOREIGN KEY (prize_id) REFERENCES prizes(prize_id)
    )
  `);
  console.log('✅ Created table: lottery_results');

  // 4. claims テーブル
  db.exec(`
    DROP TABLE IF EXISTS claims
  `);
  db.exec(`
    CREATE TABLE claims (
      claim_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token            TEXT UNIQUE NOT NULL,
      ticket_no        INTEGER NOT NULL,
      used_flag        BOOLEAN DEFAULT 0,
      used_at          DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_no) REFERENCES participants(ticket_no),
      FOREIGN KEY (token) REFERENCES participants(token)
    )
  `);
  console.log('✅ Created table: claims');

  // 5. snapshots テーブル
  db.exec(`
    DROP TABLE IF EXISTS snapshots
  `);
  db.exec(`
    CREATE TABLE snapshots (
      snapshot_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no        INTEGER NOT NULL,
      stamp_count      INTEGER,
      prize_id         INTEGER,
      prize_name       TEXT,
      result           TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (ticket_no) REFERENCES participants(ticket_no),
      FOREIGN KEY (prize_id) REFERENCES prizes(prize_id)
    )
  `);
  console.log('✅ Created table: snapshots');

  // 6. system_state テーブル
  db.exec(`
    DROP TABLE IF EXISTS system_state
  `);
  db.exec(`
    CREATE TABLE system_state (
      key              TEXT PRIMARY KEY,
      value            TEXT NOT NULL,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Created table: system_state');

  // ============================================================
  // テストデータ挿入
  // ============================================================

  console.log('\n📦 Inserting test data...\n');

  // システム状態初期化
  db.prepare(
    'INSERT INTO system_state (key, value) VALUES (?, ?)'
  ).run('status', 'OPEN');
  console.log('✅ Initialized system_state');

  // 景品マスタ（テスト用）
  const prizes = [
    { name: 'MacBook Pro 14"', description: 'Apple MacBook Pro', stock: 1, rank: 1 },
    { name: 'iPad Pro 11"', description: 'Apple iPad Pro', stock: 2, rank: 2 },
    { name: 'AirPods Pro', description: 'Apple AirPods Pro', stock: 5, rank: 3 },
    { name: 'Apple Watch SE', description: 'Apple Watch SE', stock: 10, rank: 4 },
    { name: 'Amazon Gift Card 10000円', description: 'Amazonギフトカード', stock: 20, rank: 5 }
  ];

  const insertPrize = db.prepare(`
    INSERT INTO prizes (name, description, stock, rank)
    VALUES (?, ?, ?, ?)
  `);

  prizes.forEach(prize => {
    insertPrize.run(prize.name, prize.description, prize.stock, prize.rank);
  });
  console.log('✅ Inserted prize data');

  // テスト用参加者（10名）
  const insertParticipant = db.prepare(`
    INSERT INTO participants (token, stamp_count)
    VALUES (?, ?)
  `);

  for (let i = 1; i <= 10; i++) {
    const token = `test-token-${i}`;
    const stampCount = Math.floor(Math.random() * 5);
    insertParticipant.run(token, stampCount);
  }
  console.log('✅ Inserted sample participant data (10 entries)');

  // ============================================================
  // インデックス作成
  // ============================================================

  console.log('\n🔍 Creating indexes...\n');

  db.exec(`CREATE INDEX IF NOT EXISTS idx_participants_token ON participants(token)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lottery_results_ticket ON lottery_results(ticket_no)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_token ON claims(token)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_used ON claims(used_flag)`);

  console.log('✅ Created indexes');

  // ============================================================
  // 確認情報表示
  // ============================================================

  console.log('\n' + '='.repeat(50));
  console.log('✅ Database Initialization Complete');
  console.log('='.repeat(50));
  console.log('\n📊 Database Info:');
  console.log(`   Path: ${DB_PATH}`);
  console.log(`   Tables: 6`);
  console.log(`   Test Participants: 10`);
  console.log(`   Prizes: 5`);
  console.log('\n💡 Test tokens:');
  for (let i = 1; i <= 10; i++) {
    console.log(`   test-token-${i}`);
  }
  console.log('\n');

  db.close();
  process.exit(0);

} catch (err) {
  console.error('❌ Initialization Error:', err.message);
  db.close();
  process.exit(1);
}
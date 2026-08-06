#!/usr/bin/env node

/**
 * パスワードをハッシュ化するスクリプト
 * 使用方法: node scripts/hash-password.js [password]
 * または、対話型: node scripts/hash-password.js
 */

const crypto = require('node:crypto');
const readline = require('node:readline');

// パスワードをハッシュ化
function hashPassword(password) {
  const hash = crypto.createHash('sha256');
  hash.update(password, 'utf8');
  return hash.digest('hex');
}

// メイン処理
async function main() {
  let password;

  // コマンドライン引数でパスワードが指定されている場合
  if (process.argv[2]) {
    password = process.argv[2];
    console.log(`\n🔐 パスワードハッシュ化\n`);
    console.log(`入力: ${password}`);
    console.log(`ハッシュ: ${hashPassword(password)}\n`);
    return;
  }

  // 対話型モード
  console.log(`\n🔐 パスワードハッシュ化ツール\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('パスワードを入力してください: ', (input) => {
    password = input.trim();
    
    if (!password) {
      console.log('\n❌ パスワードが空です\n');
      rl.close();
      process.exit(1);
    }

    console.log(`\n✅ ハッシュ値:\n`);
    console.log(`${hashPassword(password)}\n`);
    console.log(`📋 このハッシュ値を users.json の "password" フィールドにコピーしてください\n`);

    rl.close();
  });
}

main();
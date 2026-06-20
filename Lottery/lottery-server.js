const http = require("http");
const crypto = require("crypto");
const url = require("url");

// ===== 仮メモリDB =====
const db = {
  users: [],      // {token, ticket_no, stamp_count}
  results: [],    // {ticket_no, prize_id}
  prizes: [
    { id: 1, name: "A賞", stock: 2 },
    { id: 2, name: "B賞", stock: 5 },
    { id: 3, name: "C賞", stock: 10 }
  ],
  state: "OPEN"
};

// ===== util =====
function send(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function generateToken() {
  return crypto.randomUUID();
}

// ===== サーバー本体 =====
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const method = req.method;

  // -------------------------
  // 参加登録
  // -------------------------
  if (path === "/api/register" && method === "POST") {
    if (db.state !== "OPEN") {
      return send(res, { ok: false, msg: "受付終了" }, 403);
    }

    const token = generateToken();
    const ticket_no = db.users.length + 1;

    db.users.push({ token, ticket_no, stamp_count: 0 });

    return send(res, { ok: true, token, ticket_no });
  }

  // -------------------------
  // スタンプ追加
  // -------------------------
  if (path === "/api/stamp" && method === "POST") {
    const body = await parseBody(req);

    const user = db.users.find(u => u.token === body.token);
    if (!user) return send(res, { ok: false }, 404);

    user.stamp_count++;
    return send(res, { ok: true, stamp: user.stamp_count });
  }

  // -------------------------
  // 抽選実行
  // -------------------------
  if (path === "/api/run" && method === "POST") {
    if (db.state !== "OPEN") {
      return send(res, { ok: false }, 403);
    }

    db.state = "FROZEN";

    // ---- 重み付き ----
    const pool = [];
    for (const u of db.users) {
      const weight = 1 + u.stamp_count;
      for (let i = 0; i < weight; i++) {
        pool.push(u.ticket_no);
      }
    }

    pool.sort(() => Math.random() - 0.5);

    const prizes = [];
    for (const p of db.prizes) {
      for (let i = 0; i < p.stock; i++) {
        prizes.push(p.id);
      }
    }

    prizes.sort(() => Math.random() - 0.5);

    db.results = [];

    for (let i = 0; i < Math.min(pool.length, prizes.length); i++) {
      db.results.push({
        ticket_no: pool[i],
        prize_id: prizes[i]
      });
    }

    db.state = "FINISHED";

    return send(res, { ok: true });
  }

  // -------------------------
  // 結果取得
  // -------------------------
  if (path.startsWith("/api/result/") && method === "GET") {
    const token = path.split("/").pop();

    const user = db.users.find(u => u.token === token);
    if (!user) return send(res, { ok: false }, 404);

    const result = db.results.find(r => r.ticket_no === user.ticket_no);

    if (!result) {
      return send(res, { ok: true, win: false });
    }

    const prize = db.prizes.find(p => p.id === result.prize_id);

    return send(res, {
      ok: true,
      win: true,
      prize: prize.name
    });
  }

  // -------------------------
  // 404
  // -------------------------
  send(res, { ok: false, msg: "not found" }, 404);
});

server.listen(3000, () => {
  console.log("Lottery server running on http://localhost:3000");
});
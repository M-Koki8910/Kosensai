const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {DatabaseSync} = require("node:sqlite");

const PORT = 3001;

const DB_PATH = path.join(__dirname, 'lottery.db');

// =====================================================
// DB初期化
// =====================================================

if (!fs.existsSync("./data")) {
    fs.mkdirSync("./data");
}

//const db = new Database("./data/lottery.db");
const db = new DatabaseSync(DB_PATH);
initializeDatabase();

function initializeDatabase() {

    db.exec(`

    CREATE TABLE IF NOT EXISTS system_state (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS participants (
        ticket_no INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT UNIQUE,
        stamp_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prizes (
        prize_id INTEGER PRIMARY KEY,
        name TEXT,
        rank TEXT,
        stock INTEGER
    );

    CREATE TABLE IF NOT EXISTS lottery_results (
        ticket_no INTEGER PRIMARY KEY,
        prize_id INTEGER,
        win_flag INTEGER,
        claim_token TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS claims (
        claim_token TEXT PRIMARY KEY,
        ticket_no INTEGER,
        used_flag INTEGER DEFAULT 0,
        used_at DATETIME
    );

    `);

    const exists = db
        .prepare(
            "SELECT value FROM system_state WHERE key='status'"
        )
        .get();

    if (!exists) {

        db.prepare(`
            INSERT INTO system_state
            (key,value)
            VALUES
            ('status','OPEN')
        `).run();

    }

    console.log("DB initialized");
}

// =====================================================
// Content-Type
// =====================================================

function getContentType(filePath) {

    const ext = path.extname(filePath);

    switch (ext) {

        case ".html":
            return "text/html";

        case ".css":
            return "text/css";

        case ".js":
            return "application/javascript";

        case ".json":
            return "application/json";

        default:
            return "text/plain";
    }
}

// =====================================================
// 静的ファイル配信
// =====================================================

function serveFile(res, filePath) {

      console.log("request:", filePath);

    if (!fs.existsSync(filePath)) {

        res.writeHead(404);

        res.end("404 Not Found");

        return;
    }

    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
        "Content-Type": getContentType(filePath)
    });

    res.end(content);
}

// =====================================================
// HTTP
// =====================================================

const server = http.createServer((req, res) => {

    let requestPath = req.url;

    if (requestPath === "/") {
        requestPath = "lottery.html";
    }

    const filePath =
        path.join(
            __dirname,
            requestPath
        );

    serveFile(res, filePath);

});

// =====================================================
// Start
// =====================================================

server.listen(PORT, () => {

    console.log(
        `Lottery Server Running`
    );

    console.log(
        `http://localhost:${PORT}`
    );

});
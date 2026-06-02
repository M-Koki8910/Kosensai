document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".card").forEach(card => {
        card.addEventListener("click", () => {
            card.classList.toggle("active");
        });
    });

    const toggle = document.querySelector(".menu-toggle, #menu-toggle");
    const nav = document.getElementById("nav");

    if (toggle && nav) {
        toggle.addEventListener("click", () => {
            nav.classList.toggle("active");
        });

        document.querySelectorAll("#nav a").forEach(link => {
            link.addEventListener("click", () => {
                nav.classList.remove("active");
            });
        });
    }

    initStampRally();
});

function initStampRally() {
    const locations = [
        { id: "entrance", name: "正門", note: "正門横の案内ブース", linkText: "会場マップへ", href: "/map.html" },
        { id: "museum", name: "展示ホール", note: "展示ホール入口", linkText: "高専祭とはへ", href: "/about.html" },
        { id: "stage", name: "ステージ", note: "ステージ前の案内", linkText: "イベント紹介へ", href: "/event.html" },
        { id: "shop", name: "模擬店エリア", note: "模擬店エリア入口", linkText: "模擬店紹介へ", href: "/shop.html" },
    ];
    const storageKey = "kosensai-stamp-rally";
    const analyticsKey = "kosensai-stamp-rally-analytics";
    const stampCards = Array.from(document.querySelectorAll(".stamp-card"));
    const statusEl = document.getElementById("scan-status");
    const summaryEl = document.getElementById("stamp-summary");
    const startBtn = document.getElementById("start-scan");
    const startRallyBtn = document.getElementById("begin-rally");
    const rallyIntroSection = document.getElementById("stamp-rally-start");
    const stampSection = document.getElementById("stamp-rally");
    const readerEl = document.getElementById("reader");

    let scanner = null;

    function loadVisited() {
        try {
            return JSON.parse(localStorage.getItem(storageKey) || "[]");
        } catch (error) {
            console.warn("訪問履歴の読み込みに失敗しました", error);
            return [];
        }
    }

    function saveVisited(visited) {
        localStorage.setItem(storageKey, JSON.stringify(visited));
    }

    // sessionId はサーバー発行の Cookie を利用します（クライアント生成は廃止）

    async function sendStampEvent(type, stampId) {
        try {
            await fetch('/api/stamp-event', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type,
                    stampId,
                    page: window.location.pathname,
                }),
            });
        } catch (error) {
            console.warn('サーバーへの送信に失敗しました', error);
        }
    }

    function loadAnalytics() {
        try {
            return JSON.parse(localStorage.getItem(analyticsKey) || "{\"visits\":{},\"jumps\":{}}")
        } catch (error) {
            console.warn("集計データの読み込みに失敗しました", error);
            return { visits: {}, jumps: {} };
        }
    }

    function saveAnalytics(analytics) {
        localStorage.setItem(analyticsKey, JSON.stringify(analytics));
    }

    function renderStampState() {
        const visited = loadVisited();
        const analytics = loadAnalytics();

        stampCards.forEach(card => {
            const id = card.dataset.stampId;
            const visitedNow = visited.includes(id);
            card.classList.toggle("visited", visitedNow);
            const status = card.querySelector(".stamp-status");
            if (status) {
                if (visitedNow) {
                    status.innerHTML = `<span class="visited-icon">✔︎</span>`;
                } else {
                    status.textContent = "未訪問";
                }
            }

            const metrics = card.querySelector(".stamp-metrics");
            if (metrics) {
                // 値の表示は廃止：将来的に画像で済アイコンを差し替え予定
                metrics.textContent = '';
            }
        });

        const progress = Math.round((visited.length / locations.length) * 100);
        summaryEl.textContent = `現在 ${visited.length} / ${locations.length} か所を訪問済みです（${progress}%）。この端末の履歴と集計は localStorage に保存されます。`;
    }

    // サーバー側の訪問履歴は管理者向けに限定するため、公開ページでは取得しません。

    function generateQrCodes() {
        stampCards.forEach(card => {
            const id = card.dataset.stampId;
            const canvas = card.querySelector(".stamp-qr");
            if (!canvas || !window.QRCode) return;

            QRCode.toCanvas(canvas, `kosen-stamp:${id}`, { width: 160, margin: 1 }, error => {
                if (error) {
                    console.error("QRコード生成に失敗しました", error);
                }
            });
        });
    }

    function markVisited(code) {
        const match = String(code || "").match(/^kosen-stamp:([^\s:]+)$/i);

        if (!match) {
            statusEl.textContent = "このQRコードはスタンプラリー用ではありません。";
            return;
        }

        const id = match[1];
        const location = locations.find(item => item.id === id);

        if (!location) {
            statusEl.textContent = "登録されていない場所のQRコードです。";
            return;
        }

        const visited = loadVisited().filter(item => item !== id);
        visited.push(id);
        saveVisited(visited);

        const analytics = loadAnalytics();
        analytics.visits[id] = (analytics.visits[id] || 0) + 1;
        saveAnalytics(analytics);

        sendStampEvent('visit', id);

        renderStampState();
        statusEl.textContent = `${location.name} を訪問済みに保存しました。`;
    }

    function recordJump(id) {
        const location = locations.find(item => item.id === id);
        if (!location) return;

        const analytics = loadAnalytics();
        analytics.jumps[id] = (analytics.jumps[id] || 0) + 1;
        saveAnalytics(analytics);
        sendStampEvent('jump', id);
        renderStampState();
        statusEl.textContent = `${location.name} の関連リンクを開きました。`;
    }

    function stopScanner() {
        if (!scanner) return Promise.resolve();

        return scanner.stop().catch(() => {
            // カメラ停止時は無視する
        });
    }

    async function startScanner() {
        if (!window.Html5Qrcode) {
            statusEl.textContent = "カメラ機能を読み込めませんでした。";
            return;
        }

        if (scanner) {
            await stopScanner();
            scanner = null;
        }

        readerEl.innerHTML = "";
        scanner = new Html5Qrcode("reader");

        try {
            statusEl.textContent = "カメラを起動しています...";
            let cameraConfig = { facingMode: "environment" };

            if (typeof Html5Qrcode.getCameras === "function") {
                try {
                    const cameras = await Html5Qrcode.getCameras();
                    if (cameras && cameras.length) {
                        const backCamera = cameras.find(cam => /(back|rear|environment)/i.test(cam.label));
                        cameraConfig = backCamera ? backCamera.id : cameras[0].id;
                    }
                } catch (error) {
                    console.warn("カメラ一覧の取得に失敗しました", error);
                }
            }

            await scanner.start(
                cameraConfig,
                { fps: 10, qrbox: { width: 260, height: 260 } },
                (decodedText) => {
                    markVisited(decodedText);
                    stopScanner().finally(() => {
                        scanner = null;
                    });
                },
                () => {}
            );
        } catch (error) {
            console.error("カメラ起動に失敗しました", error);
            statusEl.textContent = "カメラを起動できませんでした。端末のカメラ利用権限を許可するか、対応ブラウザで再度お試しください。";
            scanner = null;
        }
    }

    function startStampRally() {
        if (rallyIntroSection) {
            rallyIntroSection.classList.add("hidden");
        }
        if (stampSection) {
            stampSection.classList.remove("hidden");
            stampSection.scrollIntoView({ behavior: "smooth" });
        }
        if (statusEl) {
            statusEl.textContent = "スタンプラリーを開始しました。カードとカメラを使ってQRコードを読み取ってください。";
        }
    }

    if (startRallyBtn) {
        startRallyBtn.addEventListener("click", startStampRally);
    }

    if (startBtn) {
        startBtn.addEventListener("click", () => {
            startScanner();
        });
    }

    document.querySelectorAll(".stamp-link").forEach(link => {
        link.addEventListener("click", () => {
            recordJump(link.dataset.stampId);
        });
    });

    generateQrCodes();
    renderStampState();
}

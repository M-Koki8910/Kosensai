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
    const storageKey = "kosensai-stamp-rally";
    const analyticsKey = "kosensai-stamp-rally-analytics";
    const startStateKey = "kosensai-stamp-rally-started";
    let locations = [];
    let stampCards = [];
    let stampSheetSlots = [];
    const statusEl = document.getElementById("scan-status");
    const summaryEl = document.getElementById("stamp-summary");
    const stampSheetEl = document.getElementById("stamp-sheet");
    const stampSheetCountEl = document.getElementById("stamp-sheet-count");
    const stampSheetTotalEl = document.getElementById("stamp-sheet-total");
    const stampSheetRateEl = document.getElementById("stamp-sheet-rate");
    const stampSheetFillEl = document.getElementById("stamp-sheet-fill");
    const startBtn = document.getElementById("start-scan");
    const startRallyBtn = document.getElementById("begin-rally");
    const rallyIntroSection = document.getElementById("stamp-rally-start");
    const stampSection = document.getElementById("stamp-rally");
    const readerEl = document.getElementById("reader");
    const surveyAgeEl = document.getElementById("survey-age-group");
    const surveyVisitorTypeEl = document.getElementById("survey-visitor-type");
    const surveyGroupTypeEl = document.getElementById("survey-group-type");
    const scanModalEl = document.getElementById("scan-modal");
    const scanModalCloseBtn = document.getElementById("scan-modal-close");
    const scanModalRetryBtn = document.getElementById("scan-modal-retry");
    const scanSuccessEl = document.getElementById("scan-success");

    let scanner = null;
    let scanModalOpen = false;
    let scanBusy = false;
    let scanStatusTimer = null;
    let modalCloseTimer = null;
    let scannerStartToken = 0;

    const stampThemes = [
        { primary: "#dc2626", secondary: "#f59e0b", surface: "#fff7ed" },
        { primary: "#c2410c", secondary: "#fb7185", surface: "#fff7ed" },
        { primary: "#2563eb", secondary: "#22c55e", surface: "#eff6ff" },
        { primary: "#7c3aed", secondary: "#f97316", surface: "#f5f3ff" },
        { primary: "#0f766e", secondary: "#38bdf8", surface: "#f0fdfa" },
        { primary: "#be185d", secondary: "#f43f5e", surface: "#fff1f2" },
        { primary: "#0f172a", secondary: "#2563eb", surface: "#f8fafc" },
        { primary: "#166534", secondary: "#84cc16", surface: "#f0fdf4" },
    ];

    /*
    旧・会場スポット版の定義は将来の再利用用に残しています。
    const legacyLocations = [
        { id: "entrance", name: "正門", note: "正門横の案内ブース", linkText: "会場マップへ", href: "/map.html" },
        { id: "museum", name: "展示ホール", note: "展示ホール入口", linkText: "高専祭とはへ", href: "/about.html" },
        { id: "stage", name: "ステージ", note: "ステージ前の案内", linkText: "イベント紹介へ", href: "/event.html" },
        { id: "shop", name: "模擬店エリア", note: "模擬店エリア入口", linkText: "模擬店紹介へ", href: "/shop.html" },
    ];
    */

    async function loadCompanyMaster() {
        try {
            const response = await fetch('/companies.json', { cache: 'no-store' });
            if (!response.ok) {
                return [];
            }

            const data = await response.json();
            if (!Array.isArray(data)) {
                return [];
            }

            return data.map((item, index) => ({
                id: String(item.id || `company-${String.fromCharCode(97 + index)}`),
                name: String(item.name || `企業${String.fromCharCode(65 + index)}`),
                note: String(item.note || `${String(item.name || `企業${String.fromCharCode(65 + index)}`)}のブース前のQRコードを読み取る`),
                linkText: String(item.linkText || '企業紹介へ'),
                href: String(item.href || '/company.html'),
                image: String(item.image || '/header_ed.jpg')
            }));
        } catch (error) {
            console.warn('出展企業マスタの読み込みに失敗しました', error);
            return [];
        }
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function hashString(value) {
        return String(value).split('').reduce((hash, character) => {
            return ((hash << 5) - hash + character.charCodeAt(0)) | 0;
        }, 0);
    }

    function getStampTheme(index, seedValue) {
        const seed = Math.abs(hashString(`${seedValue}:${index}`));
        return stampThemes[seed % stampThemes.length];
    }

    function createStampSvg(index, label, seedValue) {
        const theme = getStampTheme(index, seedValue);
        const safeLabel = escapeHtml(label);

        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" role="img" aria-label="${safeLabel}のスタンプ">
                <rect width="240" height="240" rx="28" fill="${theme.surface}"/>
                <circle cx="120" cy="120" r="86" fill="none" stroke="${theme.primary}" stroke-width="10"/>
                <circle cx="120" cy="120" r="66" fill="none" stroke="${theme.secondary}" stroke-width="8" stroke-dasharray="12 10"/>
                <path d="M54 120h132" stroke="${theme.primary}" stroke-width="8" stroke-linecap="round"/>
                <path d="M120 54v132" stroke="${theme.primary}" stroke-width="8" stroke-linecap="round"/>
                <circle cx="120" cy="120" r="22" fill="${theme.secondary}" opacity="0.18"/>
                <text x="120" y="132" text-anchor="middle" fill="${theme.primary}" font-family="Arial, sans-serif" font-size="36" font-weight="800" transform="rotate(-8 120 120)">STAMP</text>
            </svg>
        `)}`;
    }

    function renderStampCards() {
        const stampGrid = document.getElementById('stamp-grid');
        if (!stampGrid) return;

        stampGrid.innerHTML = locations.map((location, index) => `
            <article class="stamp-card" data-stamp-id="${location.id}">
                <p class="stamp-label">STEP ${index + 1}</p>
                <img class="stamp-thumb" src="${location.image || '/header_ed.jpg'}" alt="${location.name}のサムネイル">
                <h3>${location.name}</h3>
                <p class="stamp-note">${location.note}</p>
                <canvas class="stamp-qr" width="160" height="160" aria-label="${location.name}のQRコード"></canvas>
                <a class="stamp-link" href="${location.href || '/company.html'}" data-stamp-id="${location.id}">${location.linkText || '企業紹介へ'}</a>
                <p class="stamp-status">未訪問</p>
            </article>
        `).join('');

        stampCards = Array.from(stampGrid.querySelectorAll('.stamp-card'));

        document.querySelectorAll('#stamp-grid .stamp-link').forEach(link => {
            link.addEventListener('click', () => {
                recordJump(link.dataset.stampId);
            });
        });

        generateQrCodes();
    }

    function renderStampSheet() {
        if (!stampSheetEl) return;

        const total = locations.length || 0;

        if (!total) {
            stampSheetEl.innerHTML = '<p class="stamp-note">出展企業情報を読み込んでいます。</p>';
            stampSheetSlots = [];
            return;
        }

        stampSheetEl.innerHTML = locations.map((location, index) => {
            const theme = getStampTheme(index, location.id);

            return `
                <article class="stamp-sheet-slot" data-slot-index="${index}" style="--stamp-slot-color:${theme.primary}; --stamp-slot-color-soft:${theme.secondary}; --stamp-slot-surface:${theme.surface};">
                    <div class="stamp-sheet-slot-visual">
                        <span class="stamp-sheet-empty">空き枠</span>
                        <img class="stamp-sheet-badge" src="${createStampSvg(index, location.name, location.id)}" alt="${escapeHtml(location.name)}のスタンプ" loading="lazy">
                    </div>
                    <div class="stamp-sheet-slot-meta">
                        <span class="stamp-sheet-step">STAMP ${String(index + 1).padStart(2, '0')}</span>
                        <strong>${escapeHtml(location.name)}</strong>
                    </div>
                </article>
            `;
        }).join('');

        stampSheetSlots = Array.from(stampSheetEl.querySelectorAll('.stamp-sheet-slot'));
    }

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

    async function acquireStamp(companyId) {
        try {
            const response = await fetch('/api/stamp/acquire', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ company_id: companyId }),
            });

            const result = await response.json().catch(() => ({}));

            if (response.ok) {
                return { ok: true, result };
            }

            if (String(result.error || '').includes('already acquired')) {
                return { ok: true, already: true, result };
            }

            console.warn('スタンプ取得の記録に失敗しました', result);
            return { ok: false, result };
        } catch (error) {
            console.warn('スタンプ取得の送信に失敗しました', error);
            return { ok: false, error };
        }
    }

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

    function collectSurveyAttributes() {
        const attributes = {
            ageGroup: surveyAgeEl ? surveyAgeEl.value : '',
            visitorType: surveyVisitorTypeEl ? surveyVisitorTypeEl.value : '',
            groupType: surveyGroupTypeEl ? surveyGroupTypeEl.value : '',
        };

        const filtered = Object.fromEntries(
            Object.entries(attributes).filter(([, value]) => String(value || '').trim() !== '')
        );

        return Object.keys(filtered).length ? filtered : null;
    }

    async function sendSurveyAttributes() {
        const attributes = collectSurveyAttributes();

        try {
            await fetch('/api/stamp-survey', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ attributes }),
            });
        } catch (error) {
            console.warn('アンケート属性の送信に失敗しました', error);
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

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function setScanMessage(message) {
        if (statusEl) {
            statusEl.textContent = message;
        }
    }

    function setScanModalState(state) {
        if (!scanModalEl) return;

        scanModalEl.classList.remove("is-scanning", "is-success", "is-loading", "is-error", "is-closing");
        if (state) {
            scanModalEl.classList.add(state);
        }
    }

    function setScanRetryVisible(visible) {
        if (!scanModalRetryBtn) return;
        scanModalRetryBtn.classList.toggle("hidden", !visible);
    }

    function setScanCloseEnabled(enabled) {
        if (!scanModalCloseBtn) return;
        scanModalCloseBtn.disabled = !enabled;
    }

    function setScanBusy(isBusy) {
        scanBusy = isBusy;
        setScanCloseEnabled(!isBusy);
        if (scanModalRetryBtn) {
            scanModalRetryBtn.disabled = isBusy;
        }
    }

    function resetScanVisuals() {
        if (scanSuccessEl) {
            scanSuccessEl.classList.remove("is-visible");
        }
        setScanRetryVisible(false);
        setScanCloseEnabled(true);
        setScanModalState("is-scanning");
    }

    function openScanModal() {
        if (!scanModalEl || scanModalOpen) {
            return;
        }

        scanModalOpen = true;
        scanModalEl.classList.remove("hidden");
        scanModalEl.setAttribute("aria-hidden", "false");
        document.body.classList.add("scan-modal-open");
        resetScanVisuals();
        setScanMessage("カメラを起動しています…");

        requestAnimationFrame(() => {
            scanModalEl.classList.add("is-open");
        });
    }

    async function closeScanModal(force = false) {
        if (!scanModalEl || !scanModalOpen) {
            return;
        }

        if (scanBusy && !force) {
            return;
        }

        const closeToken = ++scannerStartToken;

        if (scanStatusTimer) {
            clearTimeout(scanStatusTimer);
            scanStatusTimer = null;
        }
        if (modalCloseTimer) {
            clearTimeout(modalCloseTimer);
            modalCloseTimer = null;
        }

        scanModalOpen = false;
        scanModalEl.classList.remove("is-open", "is-scanning", "is-success", "is-loading", "is-error");
        scanModalEl.classList.add("is-closing");
        setScanCloseEnabled(false);
        setScanRetryVisible(false);

        await stopScanner();
        scanner = null;

        if (closeToken !== scannerStartToken) {
            return;
        }

        modalCloseTimer = window.setTimeout(() => {
            scanModalEl.classList.remove("is-closing");
            scanModalEl.classList.add("hidden");
            scanModalEl.setAttribute("aria-hidden", "true");
            document.body.classList.remove("scan-modal-open");
            setScanMessage("カメラを起動すると、読み取ったQRコードの場所を記録できます。");
            setScanCloseEnabled(true);
            setScanRetryVisible(false);
        }, 220);
    }

    async function playSuccessTone() {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
            return;
        }

        try {
            const context = playSuccessTone.context || (playSuccessTone.context = new AudioContextCtor());
            if (context.state === "suspended") {
                await context.resume();
            }

            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.type = "sine";
            oscillator.frequency.setValueAtTime(880, context.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(660, context.currentTime + 0.14);
            gain.gain.setValueAtTime(0.0001, context.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.2);
        } catch (error) {
            console.warn("成功音の再生に失敗しました", error);
        }
    }

    function parseStampCode(code) {
        const match = String(code || "").match(/^kosen-stamp:([^\s:]+)$/i);

        if (!match) {
            return { ok: false, message: "このQRコードはスタンプラリー用ではありません。" };
        }

        const id = match[1];
        const location = locations.find(item => item.id === id);

        if (!location) {
            return { ok: false, message: "登録されていない場所のQRコードです。" };
        }

        return { ok: true, id, location };
    }

    function applySuccessfulStamp(id, location) {
        const visited = loadVisited().filter(item => item !== id);
        visited.push(id);
        saveVisited(visited);

        const analytics = loadAnalytics();
        analytics.visits[id] = (analytics.visits[id] || 0) + 1;
        saveAnalytics(analytics);

        renderStampState();
        setScanMessage(`${location.name} のスタンプを記録しました。`);
    }

    async function finishSuccessfulScan(id, location) {
        setScanBusy(true);
        setScanModalState("is-success");
        setScanRetryVisible(false);
        setScanMessage("読み取り完了。スタンプを記録しています…");

        if (scanSuccessEl) {
            scanSuccessEl.classList.remove("is-visible");
            void scanSuccessEl.offsetWidth;
            scanSuccessEl.classList.add("is-visible");
        }

        await playSuccessTone();
        await sleep(420);
        await stopScanner();
        scanner = null;

        setScanModalState("is-loading");
        setScanMessage("スタンプを記録しています…");

        const recordResult = await acquireStamp(id);

        if (recordResult.ok) {
            applySuccessfulStamp(id, location);
            setScanBusy(false);
            await sleep(180);
            await closeScanModal(true);
            return;
        }

        setScanBusy(false);
        setScanModalState("is-error");
        setScanRetryVisible(true);
        setScanCloseEnabled(true);
        setScanMessage("スタンプの記録に失敗しました。通信状況を確認して、再試行してください。");
    }
    //スタンプラリー開始履歴復元---------------------------------------
    function loadStartState() {
        try {
            const explicitState = localStorage.getItem(startStateKey);
            if (explicitState === "true") {
                return true;
            }
            if (explicitState === "false") {
                return false;
            }
        } catch (error) {
            console.warn("開始状態の読み込みに失敗しました", error);
        }

        const visited = loadVisited();
        const analytics = loadAnalytics();

        return visited.length > 0
            || Object.keys(analytics.visits || {}).length > 0
            || Object.keys(analytics.jumps || {}).length > 0;
    }

    function saveStartState() {
        localStorage.setItem(startStateKey, "true");
    }

    function applyStartState(started) {
        if (rallyIntroSection) {
            rallyIntroSection.classList.toggle("hidden", started);
        }
        if (stampSection) {
            stampSection.classList.toggle("hidden", !started);
        }
    }

    const started = loadStartState();
    applyStartState(started);
//---------------------------------------------------------------------------
    function renderStampState() {
        if (!stampCards.length) {
            stampCards = Array.from(document.querySelectorAll('.stamp-card'));
        }
        if (!stampSheetSlots.length) {
            stampSheetSlots = Array.from(document.querySelectorAll('.stamp-sheet-slot'));
        }

        const visited = Array.from(new Set(loadVisited()));
        const analytics = loadAnalytics();
        const total = locations.length || 0;
        const visitedCount = Math.min(visited.length, total);
        const progress = total ? Math.round((visitedCount / total) * 100) : 0;

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

        stampSheetSlots.forEach((slot, index) => {
            slot.classList.toggle('filled', index < visitedCount);
        });

        if (stampSheetCountEl) {
            stampSheetCountEl.textContent = String(visitedCount);
        }
        if (stampSheetTotalEl) {
            stampSheetTotalEl.textContent = String(total);
        }
        if (stampSheetRateEl) {
            stampSheetRateEl.textContent = `${progress}%`;
        }
        if (stampSheetFillEl) {
            stampSheetFillEl.style.width = total ? `${(visitedCount / total) * 100}%` : '0%';
        }

        summaryEl.textContent = total
            ? `現在 ${visitedCount} / ${total} 件の出展企業を訪問済みです（${progress}%）。スタンプシートは先頭から順に埋まり、この端末の履歴と集計は localStorage に保存されます。`
            : '出展企業情報を読み込んでいます。';
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

    async function markVisited(code) {
        if (scanBusy) {
            return;
        }

        const parsed = parseStampCode(code);

        if (!parsed.ok) {
            setScanModalState("is-error");
            setScanRetryVisible(false);
            setScanMessage(parsed.message);

            if (scanStatusTimer) {
                clearTimeout(scanStatusTimer);
            }

            scanStatusTimer = window.setTimeout(() => {
                if (!scanBusy && scanModalOpen) {
                    setScanModalState("is-scanning");
                    setScanMessage("QRコードを枠内に合わせてください。");
                }
            }, 1200);
            return;
        }

        await finishSuccessfulScan(parsed.id, parsed.location);
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
        openScanModal();

        if (!window.Html5Qrcode) {
            setScanMessage("カメラ機能を読み込めませんでした。");
            setScanModalState("is-error");
            return;
        }

        if (scanner) {
            await stopScanner();
            scanner = null;
        }

        const startToken = ++scannerStartToken;
        if (readerEl) {
            readerEl.innerHTML = "";
        }
        scanner = new Html5Qrcode("reader");

        try {
            setScanBusy(false);
            setScanRetryVisible(false);
            setScanModalState("is-scanning");
            setScanMessage("カメラを起動しています…");

            await sleep(50);

            if (!scanModalOpen || startToken !== scannerStartToken) {
                await stopScanner();
                scanner = null;
                return;
            }

            let cameraConfig = { facingMode: "environment" };

            if (typeof Html5Qrcode.getCameras === "function") {
                try {
                    const cameras = await Html5Qrcode.getCameras();
                    if (cameras && cameras.length) {
                        const backCamera = cameras.find(cam => /(back|rear|environment)/i.test(cam.label));
                        if (backCamera || cameras[0]) {
                            const selectedCamera = backCamera || cameras[0];
                            cameraConfig = { deviceId: selectedCamera.id };
                        }
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
                },
                () => {}
            );

            if (startToken !== scannerStartToken) {
                await stopScanner();
                scanner = null;
                return;
            }

            setScanMessage("QRコードを枠内に合わせてください。");
        } catch (error) {
            console.error("カメラ起動に失敗しました", error);
            setScanModalState("is-error");
            setScanMessage("カメラを起動できませんでした。端末のカメラ利用権限を許可するか、対応ブラウザで再度お試しください。");
            setScanRetryVisible(true);
            setScanBusy(false);
            scanner = null;
        }
    }

    async function startStampRally() {
        saveStartState();
        await sendSurveyAttributes();

        applyStartState(true);

        if (stampSection) {
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

    if (scanModalCloseBtn) {
        scanModalCloseBtn.addEventListener("click", () => {
            closeScanModal();
        });
    }

    if (scanModalRetryBtn) {
        scanModalRetryBtn.addEventListener("click", () => {
            startScanner();
        });
    }

    if (scanModalEl) {
        scanModalEl.addEventListener("click", event => {
            if (event.target && event.target.dataset && event.target.dataset.scanClose === "backdrop") {
                closeScanModal();
            }
        });
    }

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && scanModalOpen) {
            closeScanModal();
        }
    });

    loadCompanyMaster().then(master => {
        locations = master;
        renderStampCards();
        renderStampSheet();
        renderStampState();

        if (started && stampSection) {
            requestAnimationFrame(() => {
                stampSection.scrollIntoView({ behavior: "auto", block: "start" });
            });
        }
    });
}

// システム全体の進行状態定義
const STATES = {
    START: 'START',       // スタート画面
    READY: 'READY',       // 抽選待機（本番画面）
    ANIMATING: 'ANIMATING', // シャッフル演出中
    RESULT: 'RESULT',     // 結果確定表示中
    FINISHED: 'FINISHED'  // 全全景品終了
};

let currentState = STATES.START;

// 各種データプール
let masterPrizes = [];      // JSONから読み込んだ元の景品データ
let masterParticipants = [];// JSONから読み込んだ元の参加者データ
let activePrizes = [];      // 実行用にコピーした残り景品データ
let activeParticipants = [];// 実行用にコピーした残り参加者データ

// 進行トラッキング
let currentGradeIndex = 0;   // 現在何番目の「等枠」を処理しているか
let maxDrawCountPerTurn = 5; // 一度に同時抽選する基本枠数（LocalStorageで永続化）

// 音声
const soundRoll = document.getElementById('sound-roll');
const soundStop = document.getElementById('sound-stop');
const soundFinish = document.getElementById('sound-finish'); 

// 各種画面要素
const screenStart = document.getElementById('screen-start');
const screenDraw = document.getElementById('screen-draw');
const screenConfig = document.getElementById('screen-config');

// 初期読み込み
async function loadData() {
    try {
        const [prizesRes, participantsRes] = await Promise.all([
            fetch('prizes.json'),
            fetch('participants.json')
        ]);
        masterPrizes = await prizesRes.json();
        masterParticipants = await participantsRes.json();
        
        // 設定値の復元
        const savedCount = localStorage.getItem('lottery_max_draw_count');
        if (savedCount) {
            maxDrawCountPerTurn = parseInt(savedCount, 10);
            document.getElementById('config-draw-count').value = maxDrawCountPerTurn;
        }

        document.getElementById('start-load-status').textContent = "📦 データの読み込み完了";
        buildConfigDataTables();
    } catch (e) {
        console.error(e);
        document.getElementById('start-load-status').textContent = "❌ データ読み込み失敗 (CORS制限等)";
    }
}

// 抽選本番の開始処理（スタート画面から移行時のみリセット）
function startLotterySession() {
    if (masterPrizes.length === 0 || masterParticipants.length === 0) {
        alert("データが正常に読み込まれていません。");
        return;
    }
    // ディープコピーして本番用プールを作成
    activePrizes = JSON.parse(JSON.stringify(masterPrizes));
    activeParticipants = JSON.parse(JSON.stringify(masterParticipants));
    
    currentGradeIndex = 0;
    
    // 画面切り替え
    screenStart.style.display = 'none';
    screenDraw.style.display = 'flex';
    
    moveToState(STATES.READY);
}

// 状態遷移マネージャー
function moveToState(nextState) {
    currentState = nextState;
    
    if (currentGradeIndex >= activePrizes.length) {
        currentState = STATES.FINISHED;
    }

    const drawBadge = document.getElementById('grade-badge');
    const prizeTitle = document.getElementById('prize-title');
    const statusMessage = document.getElementById('status-message');
    const actionBtn = document.getElementById('action-btn');

    switch (currentState) {
        case STATES.READY:
            const currentGrade = activePrizes[currentGradeIndex];
            drawBadge.textContent = `${currentGrade.grade_name}`;
            
            // 残っている景品数と設定数から、今回引く枠数を算出
            const availableItemsCount = currentGrade.items.length;
            const currentTurnCount = Math.min(maxDrawCountPerTurn, availableItemsCount);
            
            prizeTitle.textContent = `${currentGrade.grade_name} 抽選 (残り ${availableItemsCount} つ中 ${currentTurnCount} つ)`;
            statusMessage.textContent = "Spaceキーまたはボタンで抽選開始";
            actionBtn.textContent = "抽選開始";
            actionBtn.disabled = false;
            
            // 空のマスク枠を生成
            setupBlankCards(currentTurnCount);
            break;

        case STATES.ANIMATING:
            statusMessage.textContent = "パタパタ抽選中...";
            actionBtn.disabled = true;
            if (soundRoll) {
                soundRoll.currentTime = 0;
                soundRoll.play().catch(()=>{});
            }
            executeDrawSequence();
            break;

        case STATES.RESULT:
            if (soundRoll) { soundRoll.pause(); }
            statusMessage.textContent = "Enterキーまたはボタンで次へ進む";
            actionBtn.textContent = "次へ";
            actionBtn.disabled = false;
            break;

        case STATES.FINISHED:
            if (soundRoll) { soundRoll.pause(); }
            drawBadge.style.display = 'none';
            prizeTitle.textContent = "すべての抽選が終了しました";
            statusMessage.textContent = "本日の抽選会はすべて終了です。ありがとうございました！";
            actionBtn.textContent = "終了";
            actionBtn.disabled = true;
            document.getElementById('result-container').innerHTML = "";
            break;
    }
}

// マスク用カードの生成
function setupBlankCards(count) {
    const container = document.getElementById('result-container');
    container.innerHTML = '';
    for(let i=0; i<count; i++) {
        const card = document.createElement('div');
        card.className = 'winner-card';
        card.innerHTML = `
            <div>
                <div class="box-label ticket">抽選番号</div>
                <div class="ticket-box">
                    <div class="flap-digit">?</div><div class="flap-digit">?</div><div class="flap-digit">?</div>
                </div>
            </div>
            <div>
                <div class="box-label item">景品番号</div>
                <div class="item-box">
                    <div class="flap-digit">?</div><div class="flap-digit">?</div><div class="flap-digit">?</div>
                </div>
            </div>
            <div class="item-text-name">???</div>
        `;
        container.appendChild(card);
    }
}

// コア抽選ロジック：現在の等枠のitemsからランダム選出し、参加者を重み付け抽選
let currentTurnResults = [];
function executeDrawSequence() {
    const currentGrade = activePrizes[currentGradeIndex];
    const availableItemsCount = currentGrade.items.length;
    const currentTurnCount = Math.min(maxDrawCountPerTurn, availableItemsCount);
    
    currentTurnResults = [];

    for (let i = 0; i < currentTurnCount; i++) {
        if (activeParticipants.length === 0 || currentGrade.items.length === 0) break;

        // 1. 今回割り当てる景品を1つランダムに選出し、配列から削除
        const itemIdx = Math.floor(Math.random() * currentGrade.items.length);
        const chosenItem = currentGrade.items.splice(itemIdx, 1)[0];

        // 2. 参加者を重み付け抽選
        let totalWeight = activeParticipants.reduce((sum, p) => sum + p.weight, 0);
        let randomValue = Math.random() * totalWeight;
        let currentSum = 0;
        let winnerIndex = -1;

        for (let j = 0; j < activeParticipants.length; j++) {
            currentSum += activeParticipants[j].weight;
            if (randomValue <= currentSum) {
                winnerIndex = j;
                break;
            }
        }

        if (winnerIndex !== -1) {
            // 当選者をプールから除外
            const winner = activeParticipants.splice(winnerIndex, 1)[0];
            currentTurnResults.push({
                participantId: winner.id,
                itemNum: chosenItem.item_num,
                itemName: chosenItem.item_name
            });
        }
    }

    // パタパタアニメーション開始
    animateFlaps();
}

// 演出と最後の確定時1回のみの効果音再生
function animateFlaps() {
    const container = document.getElementById('result-container');
    const cards = container.querySelectorAll('.winner-card');

    // 全桁のローリング開始
    cards.forEach(card => {
        card.querySelectorAll('.flap-digit').forEach(digit => {
            digit.classList.add('rolling');
            digit.dataset.intervalId = setInterval(() => {
                digit.textContent = Math.floor(Math.random() * 10);
            }, 40);
        });
    });

    const stepDelay = 1500; // 桁が確定する時間差
    
    // 計6ステップ (抽選3桁 + 景品3桁)
   for (let step = 0; step < 6; step++) {
        setTimeout(() => {
            // 桁が止まったかどうかを判定するフラグ
            let anyDigitStopped = false;

            // 1. 各カードの該当する桁（数字）を順番に止めていく処理
            cards.forEach((card, cardIdx) => {
                if (!currentTurnResults[cardIdx]) return;

                const ticketDigits = card.querySelectorAll('.ticket-box .flap-digit');
                const itemDigits = card.querySelectorAll('.item-box .flap-digit');

                let targetDigit = null;
                let finalChar = "0";

                if (step < 3) {
                    targetDigit = ticketDigits[step];
                    const fullStr = String(currentTurnResults[cardIdx].participantId).padStart(3, '0');
                    finalChar = fullStr[step];
                } else {
                    targetDigit = itemDigits[step - 3];
                    const fullStr = String(currentTurnResults[cardIdx].itemNum).padStart(3, '0');
                    finalChar = fullStr[step - 3];
                }

                if (targetDigit && targetDigit.classList.contains('rolling')) {
                    clearInterval(targetDigit.dataset.intervalId);
                    targetDigit.classList.remove('rolling');
                    targetDigit.textContent = finalChar;
                    anyDigitStopped = true; // 実際に桁が止まったフラグを立てる
                }
            });

            // 🎵 【桁確定音】数字が1桁止まる度に、ロール音に重ねて stop.mp3 を鳴らす
            if (anyDigitStopped && soundStop) {
                const cloneStopSound = soundStop.cloneNode();
                cloneStopSound.volume = soundStop.volume;
                cloneStopSound.play().catch(() => {});
            }

            // 2. 最後の桁（ステップ5：商品番号の3桁目）が完全に止まったあ後の処理
            if (step === 5) {
                // ⏳ 1秒のタメ（静寂）を作るため、ここでドラムロールを止める
                if (soundRoll) { soundRoll.pause(); }

                const delayForSE = 1000; 

                setTimeout(() => {
                    // 🎵 【最終確定音】1秒待ったあとに、新しく追加した soundFinish（finish.mp3）を盛大に鳴らす！
                    if (soundFinish) {
                        const finalSound = soundFinish.cloneNode();
                        finalSound.volume = soundFinish.volume;
                        finalSound.play().catch(() => {});
                    }

                    // 同時に、すべてのカードの景品名テキストをバシッと表示
                    cards.forEach((c, idx) => {
                        if (currentTurnResults[idx]) {
                            c.querySelector('.item-text-name').textContent = currentTurnResults[idx].itemName;
                        }
                    });

                    // 結果確定状態（次へボタンが押せる状態）へ移行
                    setTimeout(() => {
                        moveToState(STATES.RESULT);
                    }, 600);

                }, delayForSE);
            }

        }, (step + 1) * stepDelay);
    }
}

// 「次へ」またはEnterが押された時の進行処理
function handlePrimaryAction() {
    if (currentState === STATES.READY) {
        moveToState(STATES.ANIMATING);
    } else if (currentState === STATES.RESULT) {
        // 現在の等の景品配列が空になったか確認
        if (activePrizes[currentGradeIndex].items.length === 0) {
            // 空なら次の等（4等枠→3等枠など）へ進む
            currentGradeIndex++;
        }
        moveToState(STATES.READY);
    }
}

// 🛠️ 設定画面内にデータを表形式で出力する機能
function buildConfigDataTables() {
    document.getElementById('count-prizes-label').textContent = masterPrizes.length;
    document.getElementById('count-participants-label').textContent = masterParticipants.length;

    const tbodyPrizes = document.querySelector('#table-prizes tbody');
    tbodyPrizes.innerHTML = '';
    masterPrizes.forEach(g => {
        g.items.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${g.grade_num}</td><td><strong>${g.grade_name}</strong></td><td><code>[${item.item_num}]</code> ${item.item_name}</td>`;
            tbodyPrizes.appendChild(tr);
        });
    });

    const tbodyParticipants = document.querySelector('#table-participants tbody');
    tbodyParticipants.innerHTML = '';
    masterParticipants.forEach(p => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td><code>${p.id}</code></td><td>${p.weight} 口</td>`;
        tbodyParticipants.appendChild(tr);
    });
}

// ================= イベントリスナー紐付け =================

// スタート画面のボタン群
document.getElementById('start-draw-btn').addEventListener('click', startLotterySession);
document.getElementById('open-config-btn').addEventListener('click', () => {
    screenStart.style.display = 'none';
    screenConfig.style.display = 'flex';
});

// 設定画面のボタン群
document.getElementById('save-config-btn').addEventListener('click', () => {
    const val = parseInt(document.getElementById('config-draw-count').value, 10);
    if (val >= 1) {
        maxDrawCountPerTurn = val;
        localStorage.setItem('lottery_max_draw_count', val);
        alert("一度の同時抽選数を保存しました！");
    }
});
document.getElementById('close-config-btn').addEventListener('click', () => {
    screenConfig.style.display = 'none';
    screenStart.style.display = 'flex';
});

// 抽選画面から強制的にスタート画面に戻る（リセット）
document.getElementById('back-to-start-draw').addEventListener('click', () => {
    if(confirm("現在の抽選履歴を破棄してスタート画面に戻ります。よろしいですか？")) {
        if (soundRoll) soundRoll.pause();
        screenDraw.style.display = 'none';
        screenStart.style.display = 'flex';
        currentState = STATES.START;
    }
});

// メインアクションボタン
document.getElementById('action-btn').addEventListener('click', handlePrimaryAction);

// キーボードイベント
window.addEventListener('keydown', (e) => {
    if (currentState === STATES.START || currentState === STATES.LOADING) return;
    
    if (e.code === 'Space') {
        e.preventDefault();
        if (currentState === STATES.READY) handlePrimaryAction();
    }
    if (e.code === 'Enter') {
        e.preventDefault();
        if (currentState === STATES.RESULT) handlePrimaryAction();
    }
});

// 起動
loadData();
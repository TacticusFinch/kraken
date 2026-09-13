// ============================================
// Kraken — тренажёр дебютов v4.0 (Lightweight)
// ============================================

const API_BASE = ''; // Автоматически работает и на localhost, и на Amvera без CORS
const EVAL_DEPTH = 12;
const NUM_ENGINES = 2;
const MAX_MOVES_OUT_OF_BOOK = 3;

// --- Состояние ---
let board = null;
const game = new Chess();
let playerColor = 'white';
let selectedSquare = null;
let premoveData = null;
let waitingForOpponent = false;
let sessionActive = false;
let movesOutOfBook = 0;
let notationHalfMoves = 0;

// --- Пользовательские данные ---
let userRating = 1200;
let gamesPlayed = 0;
let recentDeltas = [];
const blunderHistory = JSON.parse(localStorage.getItem('blunderHistory') || '{}');
let sessionStats = createEmptyStats();

let userId = localStorage.getItem('userId');
if (!userId) {
    userId = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('userId', userId);
}

// --- DOM Cache ---
const $id = id => document.getElementById(id);
const DOM = {};

function cacheDOM() {
    ['board', 'status', 'rating-value', 'games-display', 'move-history', 
     'opening-badge', 'kraken-message', 'combo-fill', 'combo-multiplier',
     'stat-moves', 'stat-accuracy', 'stat-best-combo', 'stat-blunders',
     'unified-result-modal', 'game-over-card', 'go-title', 'go-rating-delta',
     'go-rating-transition', 'go-categories', 'go-combo-value', 'go-combo-section',
     'go-worst-move', 'go-worst-value', 'lichess-analysis-btn'].forEach(id => {
        DOM[id] = $id(id);
    });
}

function createEmptyStats() {
    return {
        moves: [],
        categories: { theory: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, grossBlunder: 0, catastrophe: 0 },
        repeatedBlunder: false,
        hangsQueen: false,
        mateBlunder: false,
        combo: 0,
        maxCombo: 0,
        comboHistory: [],
        perfectStreak: false
    };
}

// ============================================
// Stockfish Worker Pool (Лаконичный пул)
// ============================================
const engines = [];
const engineQueue = [];

function initEngines() {
    for (let i = 0; i < NUM_ENGINES; i++) {
        const worker = new Worker('sf-worker2.js');
        const eng = { id: i, worker, busy: false, resolve: null, score: 0, isMate: false };

        worker.onmessage = (e) => {
            const msg = e.data;
            if (typeof msg !== 'string') return;
            if (msg === 'uciok') { worker.postMessage('isready'); return; }

            const cp = msg.match(/score cp (-?\d+)/);
            if (cp) { eng.score = parseInt(cp[1]); eng.isMate = false; }
            const mate = msg.match(/score mate (-?\d+)/);
            if (mate) { eng.score = parseInt(mate[1]) > 0 ? 10000 : -10000; eng.isMate = true; }

            if (msg.startsWith('bestmove')) {
                if (eng.resolve) {
                    eng.resolve({ score: eng.score, isMate: eng.isMate, bestMove: msg.split(' ')[1] });
                    eng.resolve = null;
                }
                eng.busy = false;
                runNextEngineTask();
            }
        };
        worker.postMessage('uci');
        engines.push(eng);
    }
}

function runNextEngineTask() {
    if (!engineQueue.length) return;
    const free = engines.find(e => !e.busy);
    if (!free) return;
    const task = engineQueue.shift();
    free.busy = true;
    free.resolve = task.resolve;
    free.worker.postMessage(`position fen ${task.fen}`);
    free.worker.postMessage(`go depth ${task.depth}`);
}

function evaluatePosition(fen, depth = EVAL_DEPTH) {
    return new Promise(resolve => {
        engineQueue.push({ fen, depth, resolve });
        runNextEngineTask();
    });
}

// ============================================
// Сетевой слой (Fetch)
// ============================================
async function apiRequest(endpoint, body = {}) {
    try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn(`API Error [${endpoint}]:`, e.message);
        return null;
    }
}

// ============================================
// Анализ и игровой процесс
// ============================================
function categorizeMove(cpl, isBook) {
    if (isBook) return 'theory';
    if (cpl <= 35) return 'good';
    if (cpl <= 80) return 'inaccuracy';
    if (cpl <= 180) return 'mistake';
    if (cpl <= 400) return 'blunder';
    return 'grossBlunder';
}

async function processPlayerMove(move, fenBefore) {
    appendMoveToNotation(move.san, 'pending', true);
    const turn = fenBefore.split(' ')[1];

    // Параллельно: 1) запрос к Lichess через сервер 2) оценка движка
    const [serverData, evalBefore, evalAfter] = await Promise.all([
        apiRequest('/play-move', { fen: fenBefore, san: move.san, rating: userRating }),
        evaluatePosition(fenBefore),
        evaluatePosition(game.fen())
    ]);

    // Расчет CPL
    const sign = turn === 'w' ? 1 : -1;
    const loss = (evalBefore.score * sign) - (evalAfter.score * sign);
    const cpl = Math.max(0, loss);

    // Обработка книжности
    const bookCheck = serverData?.check || { inBook: false, rank: 99, moveCount: 0 };
    const isBook = bookCheck.inBook && bookCheck.rank <= 3 && cpl <= 45;
    const cat = categorizeMove(cpl, isBook);

    updateMoveInHistory(move.san, cat);

    // Статистика комбо
    if (cat === 'theory' || cat === 'good') {
        sessionStats.combo++;
        if (sessionStats.combo > sessionStats.maxCombo) sessionStats.maxCombo = sessionStats.combo;
    } else {
        if (sessionStats.combo >= 2) sessionStats.comboHistory.push(sessionStats.combo);
        sessionStats.combo = 0;
    }

    if (cpl > 200 && blunderHistory[fenBefore]) sessionStats.repeatedBlunder = true;
    if (cpl > 200) blunderHistory[fenBefore] = true;

    sessionStats.moves.push({
        san: move.san,
        cpl,
        isBookMove: isBook,
        popularityRank: bookCheck.rank || 99,
        evalBefore: evalBefore.score,
        evalAfter: evalAfter.score,
        isUserMove: true
    });
    sessionStats.categories[cat]++;

    updateLiveStats();

    // Проверка окончания или ответа
    if (serverData?.gameOver || game.game_over()) {
        endSession();
        return;
    }

    if (serverData?.reply) {
        setTimeout(() => applyOpponentMove(serverData.reply), 150);
    } else {
        movesOutOfBook++;
        if (movesOutOfBook >= MAX_MOVES_OUT_OF_BOOK) {
            updateStatus('📚 Выход из теории. Дебют окончен!');
            endSession();
        } else {
            makeEngineFallbackMove();
        }
    }
}

function applyOpponentMove(san) {
    const res = game.move(san);
    if (!res) return;
    board.position(game.fen(), true);
    appendMoveToNotation(res.san, 'opponent', false);
    waitingForOpponent = false;

    if (game.game_over()) endSession();
    else if (premoveData) executePremove();
}

async function makeEngineFallbackMove() {
    updateStatus('🤖 Соперник обдумывает ход...');
    const result = await evaluatePosition(game.fen(), 8);
    if (result.bestMove) {
        const m = game.move(result.bestMove, { sloppy: true });
        if (m) {
            board.position(game.fen(), true);
            appendMoveToNotation(m.san, 'opponent', false);
        }
    }
    waitingForOpponent = false;
    if (game.game_over()) endSession();
}

// ============================================
// Завершение и Рейтинг
// ============================================
async function endSession() {
    if (!sessionActive) return;
    sessionActive = false;

    const userMoves = sessionStats.moves.filter(m => m.isUserMove);
    if (userMoves.length < 2) {
        updateStatus('Слишком короткая партия для изменения рейтинга');
        return;
    }

    updateStatus('⏳ Сохранение результатов...');
    const data = await apiRequest(`/api/rating/${userId}/update`, {
        moves: userMoves,
        recentDeltas,
        maxCombo: sessionStats.maxCombo,
        mateBlunder: sessionStats.mateBlunder,
        hangsQueen: sessionStats.hangsQueen,
        repeatedBlunder: sessionStats.repeatedBlunder
    });

    if (data) {
        const oldR = userRating;
        userRating = data.newRating;
        gamesPlayed = data.gamesPlayed;
        recentDeltas = data.recentDeltas || [];
        localStorage.setItem('chessRating', userRating);
        showResultsModal(oldR, data.delta);
    }
}

// ============================================
// UI & Доска
// ============================================
function onDrop(source, target) {
    if (source === target || !sessionActive) return 'snapback';
    if (waitingForOpponent) {
        premoveData = { from: source, to: target };
        return 'snapback';
    }

    const fenBefore = game.fen();
    const move = game.move({ from: source, to: target, promotion: 'q' });
    if (!move) return 'snapback';

    waitingForOpponent = true;
    processPlayerMove(move, fenBefore);
}

function executePremove() {
    const { from, to } = premoveData;
    premoveData = null;
    const fenBefore = game.fen();
    const move = game.move({ from, to, promotion: 'q' });
    if (!move) return;
    board.position(game.fen(), true);
    waitingForOpponent = true;
    processPlayerMove(move, fenBefore);
}

function updateStatus(html) { if (DOM.status) DOM.status.innerHTML = html; }

function appendMoveToNotation(san, cls, isWhite) {
    if (!DOM['move-history']) return;
    const span = document.createElement('span');
    span.className = `move-san ${cls}`;
    span.textContent = san;
    span.dataset.san = san;

    if (isWhite) {
        const pair = document.createElement('div');
        pair.className = 'move-pair';
        pair.innerHTML = `<span class="move-number">${Math.floor(notationHalfMoves / 2) + 1}.</span>`;
        pair.appendChild(span);
        DOM['move-history'].appendChild(pair);
    } else {
        const last = DOM['move-history'].lastElementChild;
        if (last) last.appendChild(span);
    }
    notationHalfMoves++;
    DOM['move-history'].scrollTop = DOM['move-history'].scrollHeight;
}

function updateMoveInHistory(san, newClass) {
    const el = DOM['move-history']?.querySelector(`.move-san.pending[data-san="${san}"]`);
    if (el) {
        el.className = `move-san ${newClass}`;
    }
}

function updateLiveStats() {
    const userMoves = sessionStats.moves.filter(m => m.isUserMove);
    if (!userMoves.length || !DOM['stat-moves']) return;

    DOM['stat-moves'].textContent = userMoves.length;
    const good = userMoves.filter(m => m.cpl <= 50).length;
    DOM['stat-accuracy'].textContent = `${Math.round((good / userMoves.length) * 100)}%`;
    DOM['stat-best-combo'].textContent = sessionStats.maxCombo;
}

function showResultsModal(oldR, delta) {
    if (!DOM['unified-result-modal']) return;
    DOM['go-rating-delta'].textContent = (delta >= 0 ? '+' : '') + delta;
    DOM['go-rating-transition'].innerHTML = `${oldR} → <b>${userRating}</b>`;
    DOM['unified-result-modal'].classList.add('show');
}

function startGame() {
    game.reset();
    sessionStats = createEmptyStats();
    sessionActive = true;
    movesOutOfBook = 0;
    notationHalfMoves = 0;
    premoveData = null;

    playerColor = $id('playerColor')?.value || 'white';
    waitingForOpponent = (playerColor === 'black');

    board.orientation(playerColor);
    board.position('start');
    if (DOM['move-history']) DOM['move-history'].innerHTML = '';

    if (waitingForOpponent) {
        updateStatus('⏳ Соперник выбирает ход...');
        apiRequest('/get-move', { fen: game.fen(), rating: userRating }).then(res => {
            if (res?.move) applyOpponentMove(res.move);
            else makeEngineFallbackMove();
        });
    } else {
        updateStatus('♟ Ваш ход!');
    }
}

// ============================================
// Инициализация
// ============================================
document.addEventListener('DOMContentLoaded', async () => {
    cacheDOM();
    initEngines();

    board = Chessboard('board', {
        draggable: true,
        position: 'start',
        onDrop: onDrop,
        pieceTheme: '/chesspieces/alpha/{piece}.png'
    });

    // Загрузка сохранённого рейтинга
    const res = await fetch(`${API_BASE}/api/rating/${userId}`).then(r => r.json()).catch(() => null);
    if (res) {
        userRating = res.rating;
        gamesPlayed = res.games || 0;
        if (DOM['rating-value']) DOM['rating-value'].textContent = userRating;
    }

    $id('go-btn-new-game')?.addEventListener('click', () => {
        DOM['unified-result-modal'].classList.remove('show');
        startGame();
    });

    $id('go-btn-close')?.addEventListener('click', () => {
        DOM['unified-result-modal'].classList.remove('show');
    });

    console.log('🦑 Kraken Mini Engine v4.0 ready');
});
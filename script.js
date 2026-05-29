//============================================
// Kraken — тренажёр дебютов v3.8 (optimized)
//============================================

// --- Константы ---
const API_BASE = window.location.hostname === 'localhost' ? '' : 'https://kraken-qslu.onrender.com';
const EVAL_DEPTH = 15;
const NUM_ENGINES = 2;
const EVAL_TIMEOUT_MS = 6000;
const MAX_MOVES_OUT_OF_BOOK = 2;
const MAX_MOVES_OUT_OF_BOOK_FEN = 10;
const TAP_DEDUP_MS = 250;
const TOUCH_MOVE_THRESHOLD = 10;

// --- Состояние ---
let board = null;
const game = new Chess();
let playerColor = 'white';
let selectedSquare = null;
let premoveData = null;
let waitingForOpponent = false;
let sessionActive = false;

// --- Состояние FEN-сессии ---
let lastCustomFEN = null;
let lastCustomColor = null;
let isCustomFENSession = false;

let movesOutOfBook = 0;
let notationHalfMoves = 0;
let lastTapTime = 0;
let lastTapSquare = null;
let lastTapAction = null;
let touchStartX = 0;
let touchStartY = 0;
let touchMoved = false;
const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

// --- Пользовательские данные ---
let userRating = 1200;
let gamesPlayed = 0;
let recentDeltas = [];
const blunderHistory = JSON.parse(localStorage.getItem('blunderHistory') || '{}');
let sessionStats = createEmptyStats();
let pendingEndSession = false;

let userId = localStorage.getItem('userId');
if (!userId) {
    userId = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('userId', userId);
}

// --- Stockfish ---
const engines = [];
const engineWaitQueue = [];

// --- Кэш DOM-элементов ---
const DOM = {};

function cacheDOMElements() {
    DOM.board = $('#board');
    DOM.status = $('#status');
    DOM.ratingValue = $('#rating-value');
    DOM.gamesDisplay = $('#games-display');
    DOM.moveHistory = $('#move-history');
    DOM.openingBadge = $('#opening-badge');
    DOM.krakenMessage = $('#kraken-message');
    DOM.comboFill = $('#combo-fill');
    DOM.comboMultiplier = $('#combo-multiplier');
    DOM.statMoves = $('#stat-moves');
    DOM.statAccuracy = $('#stat-accuracy');
    DOM.statBestCombo = $('#stat-best-combo');
    DOM.statBlunders = $('#stat-blunders');
    DOM.lichessBtn = document.getElementById('lichess-analysis-btn');

    // Модалка результатов
    DOM.modal = $('#unified-result-modal');
    DOM.gameOverCard = $('#game-over-card');
    DOM.goDateline = $('#go-dateline');
    DOM.goTitle = $('#go-title');
    DOM.goStars = $('#go-stars');
    DOM.goIllustration = $('#go-illustration');
    DOM.goRatingDelta = $('#go-rating-delta');
    DOM.goRatingTransition = $('#go-rating-transition');
    DOM.goCategories = $('#go-categories');
    DOM.goComboSection = $('#go-combo-section');
    DOM.goComboValue = $('#go-combo-value');
    DOM.goVoyageSection = $('#go-voyage-section');
    DOM.goHull = $('#go-hull');
    DOM.goRepairs = $('#go-repairs');
    DOM.goDamage = $('#go-damage');
    DOM.goCrits = $('#go-crits');
    DOM.goCritsRow = $('#go-crits-row');
    DOM.goAchievements = $('#go-achievements');
    DOM.goPenalties = $('#go-penalties');
    DOM.goWorstMove = $('#go-worst-move');
    DOM.goWorstValue = $('#go-worst-value');
    DOM.goDefeatTip = $('#go-defeat-tip');
    DOM.goRetryBtn = $('#go-btn-retry-fen');
    DOM.goMapResult = $('#go-map-result');
}

// --- Кэш оценок Stockfish ---
const evalCache = new Map();
const EVAL_CACHE_MAX = 200;

function getEvalCacheKey(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
}

function getCachedEvaluation(fen, depth) {
    return evalCache.get(getEvalCacheKey(fen) + '|' + depth) || null;
}

function setCachedEvaluation(fen, depth, result) {
    const key = getEvalCacheKey(fen) + '|' + depth;
    if (evalCache.size >= EVAL_CACHE_MAX) {
        const firstKey = evalCache.keys().next().value;
        evalCache.delete(firstKey);
    }
    evalCache.set(key, result);
}

// --- Кэш нотации ---
let lastMovePairEl = null;

// --- Константы для комбо-фидбека ---
const COMBO_ICONS = {
    theory: '📘', good: '✅', inaccuracy: '⚠️',
    mistake: '❌', blunder: '🔥', grossBlunder: '💀', catastrophe: '☠️'
};
const COMBO_LABELS = {
    theory: 'Теория', good: 'Хороший ход', inaccuracy: 'Неточность',
    mistake: 'Ошибка', blunder: 'Зевок!', grossBlunder: 'Грубый зевок!', catastrophe: 'Катастрофа!'
};

// --- Lichess форма (создаётся один раз) ---
let lichessForm = null;
let lichessPgnInput = null;

// --- Утилиты статистики ---
function createEmptyStats() {
    return {
        moves: [],
        pendingAnalysis: 0,
        categories: { theory: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, grossBlunder: 0, catastrophe: 0 },
        repeatedBlunder: false,
        hangsQueen: false,
        mateBlunder: false,
        openingDifficulty: null,
        combo: 0,
        maxCombo: 0,
        comboHistory: [],
        perfectStreak: false
    };
}

function categorizeMove(cpl, isBookMove) {
    if (isBookMove) return 'theory';
    if (cpl <= 50) return 'good';
    if (cpl <= 90) return 'inaccuracy';
    if (cpl <= 200) return 'mistake';
    if (cpl <= 500) return 'blunder';
    if (cpl <= 1000) return 'grossBlunder';
    return 'catastrophe';
}

function isComboBreaker(category) {
    return category === 'mistake' || category === 'blunder' ||
           category === 'grossBlunder' || category === 'catastrophe';
}

function isOwnPiece(piece) {
    if (!piece) return false;
    return (playerColor === 'white' && piece.color === 'w') ||
           (playerColor === 'black' && piece.color === 'b');
}

//============================================
// Stockfish — оптимизированный пул воркеров
//============================================

function createEngine(id) {
    const e = {
        id, worker: null, ready: false, busy: false, resolve: null,
        turn: 'w', score: 0, isMate: false, timeout: null,
        currentSkillLevel: -1
    };
    try {
        e.worker = new Worker('sf-worker2.js');
        e.worker.onmessage = function (event) {
            const data = event.data;
            if (typeof data !== 'string') return;

            if (data === 'uciok') { e.worker.postMessage('isready'); return; }
            if (data === 'readyok') {
                if (!e.ready) { e.ready = true; processEngineQueue(); }
                return;
            }
            if (!e.resolve) return;

            const cpMatch = data.match(/score cp (-?\d+)/);
            if (cpMatch) { e.score = parseInt(cpMatch[1]); e.isMate = false; return; }

            const mateMatch = data.match(/score mate (-?\d+)/);
            if (mateMatch) {
                e.score = parseInt(mateMatch[1]) > 0 ? 10000 : -10000;
                e.isMate = true;
                return;
            }

            if (data.charCodeAt(0) === 98 && data.startsWith('bestmove')) {
                const finalScore = e.turn === 'b' ? -e.score : e.score;
                clearTimeout(e.timeout);
                const resolve = e.resolve;
                e.resolve = null;
                e.busy = false;
                resolve({ score: finalScore, isMate: e.isMate });
                processEngineQueue();
            }
        };
        e.worker.onerror = function (err) {
            console.error(`❌ SF#${id} error:`, err.message || 'unknown');
        };
        e.worker.postMessage('uci');
    } catch (err) {
        console.error(`Ошибка инициализации Stockfish #${id}:`, err);
    }
    return e;
}

function initEngines() {
    for (let i = 0; i < NUM_ENGINES; i++) engines.push(createEngine(i));
}

function findFreeEngine() {
    return engines.find(e => e.ready && !e.busy) || null;
}

function processEngineQueue() {
    while (engineWaitQueue.length > 0) {
        const free = findFreeEngine();
        if (!free) return;
        const task = engineWaitQueue.shift();
        runEvalOnEngine(free, task.fen, task.depth, task.resolve);
    }
}

function runEvalOnEngine(e, fen, depth, resolve) {
    e.busy = true;
    e.resolve = resolve;
    e.turn = fen.charAt(fen.indexOf(' ') + 1);
    e.score = 0;
    e.isMate = false;
    e.timeout = setTimeout(() => {
        if (e.resolve === resolve) {
            e.resolve = null;
            e.busy = false;
            resolve({ score: 0, isMate: false });
            processEngineQueue();
        }
    }, EVAL_TIMEOUT_MS);
    e.worker.postMessage('position fen ' + fen);
    e.worker.postMessage('go depth ' + depth);
}

function getEngineEvaluation(fen, depth = EVAL_DEPTH) {
    const cached = getCachedEvaluation(fen, depth);
    if (cached) return Promise.resolve(cached);

    return new Promise(resolve => {
        const free = findFreeEngine();
        const onResult = (result) => {
            setCachedEvaluation(fen, depth, result);
            resolve(result);
        };
        if (free) runEvalOnEngine(free, fen, depth, onResult);
        else engineWaitQueue.push({ fen, depth, resolve: onResult });
    });
}

// ============================================
// Адаптивная сила движка
// ============================================

function getEngineDepthForRating(rating) {
    if (rating < 1000) return 3;
    if (rating < 1200) return 4;
    if (rating < 1400) return 5;
    if (rating < 1600) return 6;
    if (rating < 1800) return 7;
    if (rating < 2000) return 8;
    if (rating < 2200) return 10;
    return 12;
}

function getSkillLevelForRating(rating) {
    return Math.max(0, Math.min(20, Math.round((rating - 800) / 80)));
}

function getEngineBestMoveAdaptive(fen, depth) {
    return new Promise(resolve => {
        const tryRun = () => {
            const e = findFreeEngine();
            if (!e) { setTimeout(tryRun, 150); return; }
            e.busy = true;

            const skillLevel = getSkillLevelForRating(userRating);
            if (e.currentSkillLevel !== skillLevel) {
                e.worker.postMessage(`setoption name Skill Level value ${skillLevel}`);
                e.currentSkillLevel = skillLevel;
            }

            let bestMove = null;
            const origOnMessage = e.worker.onmessage;
            e.worker.onmessage = function (event) {
                const data = event.data;
                if (typeof data !== 'string') return;
                if (data.charCodeAt(0) === 98 && data.startsWith('bestmove')) {
                    const spaceIdx = data.indexOf(' ', 9);
                    bestMove = spaceIdx > 0 ? data.substring(9, spaceIdx) : data.substring(9);
                    if (bestMove === '(none)') bestMove = null;
                    e.worker.onmessage = origOnMessage;
                    e.busy = false;
                    resolve(bestMove);
                    processEngineQueue();
                }
            };
            e.worker.postMessage('position fen ' + fen);
            e.worker.postMessage('go depth ' + depth);
        };
        tryRun();
    });
}

async function computeCPL(fenBefore, fenAfter, playerTurnBefore) {
    const [evalBefore, evalAfter] = await Promise.all([
        getEngineEvaluation(fenBefore),
        getEngineEvaluation(fenAfter)
    ]);

    const sign = playerTurnBefore === 'w' ? 1 : -1;
    const evalBeforePlayer = evalBefore.score * sign;
    const evalAfterPlayer = evalAfter.score * sign;

    const clampedBefore = Math.max(-2000, Math.min(2000, evalBeforePlayer));
    const clampedAfter = Math.max(-2000, Math.min(2000, evalAfterPlayer));
    const lossForPlayer = clampedBefore - clampedAfter;

    const isMateBlunder = evalAfter.isMate && (evalAfter.score * sign) < 0 &&
        !(evalBefore.isMate && evalBefore.score * sign < 0);

    return {
        cpl: lossForPlayer > 0 ? lossForPlayer : 0,
        isMateBlunder,
        evalBefore: evalBefore.score,
        evalAfter: evalAfter.score
    };
}

// ============================================
// Серверное взаимодействие
// ============================================

async function loadRatingFromServer() {
    try {
        const response = await fetch(API_BASE + '/api/rating/' + userId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const r = await response.json();
        userRating = r.rating;
        gamesPlayed = r.games || 0;
        recentDeltas = r.recentDeltas || [];
        localStorage.setItem('chessRating', userRating);
        localStorage.setItem('gamesPlayed', gamesPlayed);
        updateRatingUI();
    } catch (e) {
        console.warn('Рейтинг с сервера недоступен:', e.message);
        const savedRating = localStorage.getItem('chessRating');
        if (savedRating) userRating = parseInt(savedRating);
        const savedGames = localStorage.getItem('gamesPlayed');
        if (savedGames) gamesPlayed = parseInt(savedGames);
        updateRatingUI();
    }
}

async function playMoveOnServer(fen, san, rating) {
    try {
        const response = await fetch(API_BASE + '/play-move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen, san, rating })
        });
        if (!response.ok) {
            console.warn('/play-move: HTTP ${response.status}');
            return { check: { inBook: false, rank: 99 }, reply: null, gameOver: false };
        }
        return await response.json();
    } catch (e) {
        console.error('Ошибка /play-move:', e.message);
        return { check: { inBook: false, rank: 99 }, reply: null, gameOver: false };
    }
}

// ============================================
// Обработка хода игрока
// ============================================

function onDrop(source, target) {
    if (source === target) return 'snapback';
    clearClickHighlight();
    selectedSquare = null;

    if (!sessionActive) return 'snapback';

    if (waitingForOpponent) {
        premoveData = { source, target };
        highlightPremove(source, target);
        updateStatus(`⏩ Предход: ${source}→${target}`);
        return 'snapback';
    }

    const fenBefore = game.fen();
    const move = game.move({ from: source, to: target, promotion: 'q' });
    if (move === null) {
        SoundEngine.illegal();
        return 'snapback';
    }

    playMoveSound(move);
    waitingForOpponent = true;
    clearPremoveHighlight();
    processPlayerMove(move, fenBefore);
}

function onSnapEnd() {
    board.position(game.fen(), true);
}

function playMoveSound(move) {
    if (move.san.includes('O-O')) SoundEngine.moveCastle();
    else if (move.captured) SoundEngine.moveCapture();
    else if (move.promotion) SoundEngine.movePromotion();
    else SoundEngine.moveNormal();

    if (move.san.includes('+') || move.san.includes('#')) {
        setTimeout(() => SoundEngine.moveCheck(), 100);
    }
}

async function processPlayerMove(move, fenBefore) {
    try {
        const fenAfter = game.fen();
        const moveNumber = Math.ceil(game.history().length / 2);
        const playerTurnBefore = fenBefore.charAt(fenBefore.indexOf(' ') + 1);

        appendMoveToNotation(move, 'pending', true);

        const serverDataPromise = playMoveOnServer(fenBefore, move.san, userRating);
        analyzeMoveInBackground(move, fenBefore, fenAfter, moveNumber, playerTurnBefore, serverDataPromise);

        const serverData = await serverDataPromise;

        if (serverData.gameOver) {
            updateStatus('Партия окончена');
            scheduleEndSession();
            return;
        }

        if (serverData.reply) {
            setTimeout(() => applyOpponentReply(serverData.reply), 120);
        } else {
            movesOutOfBook++;
            updateStatus('📚 Вне книги (${movesOutOfBook}/${MAX_MOVES_OUT_OF_BOOK})');
            const maxOutOfBook = isCustomFENSession ? MAX_MOVES_OUT_OF_BOOK_FEN : MAX_MOVES_OUT_OF_BOOK;
            if (movesOutOfBook >= maxOutOfBook) {
                updateStatus('📚 Тренировка завершена');
                scheduleEndSession();
                return;
            }
            makeEngineReply();
        }
    } catch (err) {
        console.error('❌ processPlayerMove:', err);
        waitingForOpponent = false;
    }
}

// ============================================
// Фоновый анализ хода
// ============================================

async function analyzeMoveInBackground(move, fenBefore, fenAfter, moveNumber, playerTurnBefore, serverDataPromise) {
    sessionStats.pendingAnalysis++;

    try {
        const { cpl, isMateBlunder, evalBefore, evalAfter } = await computeCPL(fenBefore, fenAfter, playerTurnBefore);
        const serverData = await serverDataPromise;
        const bookInfo = serverData.check || { inBook: false, rank: 99, moveCount: 0 };
        const popularityRank = bookInfo.rank || 99;

        if (isMateBlunder) sessionStats.mateBlunder = true;

        const isBookMove = bookInfo.inBook && bookInfo.rank <= 3 &&
            (bookInfo.moveCount || 0) >= 50 && cpl <= 50;
        const category = categorizeMove(cpl, isBookMove);

        if (category === 'theory' || category === 'good') {
            sessionStats.combo++;
            if (sessionStats.combo > sessionStats.maxCombo) {
                sessionStats.maxCombo = sessionStats.combo;
            }
        } else if (isComboBreaker(category)) {
            if (sessionStats.combo >= 2) {
                sessionStats.comboHistory.push(sessionStats.combo);
            }
            sessionStats.combo = 0;
        }

        showComboFeedback(sessionStats.combo, category, cpl);

        if (cpl > 200 && blunderHistory[fenBefore]) sessionStats.repeatedBlunder = true;
        if (cpl > 200) {
            blunderHistory[fenBefore] = true;
            localStorage.setItem('blunderHistory', JSON.stringify(blunderHistory));
        }
        if (cpl >= 700 && move.piece === 'q') sessionStats.hangsQueen = true;

        sessionStats.moves.push({
            cpl: Math.round(cpl), moveNumber, popularityRank,
            fen: fenBefore, san: move.san, isBookMove, isUserMove: true,
            combo: sessionStats.combo,
            evalBefore: Math.round(evalBefore),
            evalAfter: Math.round(evalAfter)
        });
        sessionStats.categories[category]++;

        if (typeof VoyageEngine !== 'undefined' && !VoyageEngine.state.isGameOver) {
            const oppPop = VoyageEngine.getOpponentLastPopularity();
            const popularityPercent = bookInfo.moveCount
                ? ((bookInfo.moveCount || 0) / Math.max(1, bookInfo.totalGames || 1)) * 100 : 50;

            VoyageEngine.processPlayerMove({
                cpl, category, isBookMove, popularityRank, popularityPercent,
                san: move.san, moveNumber, opponentLastPopularity: oppPop
            });

            if (VoyageEngine.state.isGameOver && VoyageEngine.state.currentHP <= 0) {
                scheduleEndSession();
            }
        }

        updateLiveStats();
        updateMoveCategory(move.san, category, true);
    } catch (err) {
        console.error('Ошибка фонового анализа:', err);
    } finally {
        sessionStats.pendingAnalysis--;
        if (pendingEndSession && sessionStats.pendingAnalysis === 0) {
            pendingEndSession = false;
            endSession();
        }
    }
}

// ============================================
// Ответ соперника
// ============================================

function applyOpponentReply(san) {
    const result = game.move(san);
    if (!result) {
        console.error('Нелегальный ход от сервера:', san);
        updateStatus('⚠️ Сервер вернул нелегальный ход');
        waitingForOpponent = false;
        return;
    }

    board.position(game.fen(), true);
    playMoveSound(result);
    appendMoveToNotation(result, 'opponent', false);

    if (typeof VoyageEngine !== 'undefined') {
        VoyageEngine.setOpponentMovePopularity(50);
    }

    waitingForOpponent = false;
    if (game.game_over()) {
        scheduleEndSession();
    } else {
        setTimeout(tryExecutePremove, 50);
    }
}

async function makeEngineReply() {
    try {
        const fen = game.fen();
        const depth = getEngineDepthForRating(userRating);
        const bestMove = await getEngineBestMoveAdaptive(fen, depth);

        if (bestMove) {
            const result = game.move({
                from: bestMove.slice(0, 2),
                to: bestMove.slice(2, 4),
                promotion: bestMove.length > 4 ? bestMove[4] : 'q'
            });
            if (result) {
                board.position(game.fen(), true);
                playMoveSound(result);
                appendMoveToNotation(result, 'opponent', false);
            }
        }
        waitingForOpponent = false;
        if (game.game_over()) scheduleEndSession();
    } catch (e) {
        console.error('makeEngineReply error:', e);
        waitingForOpponent = false;
    }
}

// ============================================
// Предходы
// ============================================

function highlightPremove(source, target) {
    clearPremoveHighlight();
    const boardEl = document.getElementById('board');
    if (!boardEl) return;
    const s = boardEl.querySelector('.square-' + source);
    const t = boardEl.querySelector('.square-' + target);
    if (s) s.classList.add('premove-highlight');
    if (t) t.classList.add('premove-highlight');
}

function clearPremoveHighlight() {
    const boardEl = document.getElementById('board');
    if (!boardEl) return;
    const els = boardEl.querySelectorAll('.premove-highlight');
    for (let i = 0; i < els.length; i++) els[i].classList.remove('premove-highlight');
}

function tryExecutePremove() {
    if (!premoveData || !sessionActive) return;
    const { source, target } = premoveData;
    premoveData = null;
    clearPremoveHighlight();

    const fenBefore = game.fen();
    const move = game.move({ from: source, to: target, promotion: 'q' });
    if (move === null) {
        SoundEngine.illegal();
        updateStatus('⚠️ Предход невозможен');
        return;
    }

    board.position(game.fen(), true);
    playMoveSound(move);
    waitingForOpponent = true;
    processPlayerMove(move, fenBefore);
}

// ============================================
// Завершение сессии
// ============================================

function scheduleEndSession() {
    if (!sessionActive) return;
    if (sessionStats.pendingAnalysis === 0) {
        endSession();
    } else {
        pendingEndSession = true;
        updateStatus('⏳ Анализ партии...');
    }
}

async function endSession() {
    if (!sessionActive && !pendingEndSession) return;
    sessionActive = false;
    pendingEndSession = false;

    const oldRating = userRating;
    const userMoves = sessionStats.moves.filter(m => m.isUserMove);
    if (userMoves.length === 0) {
        updateStatus('Партия слишком короткая, рейтинг не изменён');
        return;
    }

    if (sessionStats.combo >= 2) {
        sessionStats.comboHistory.push(sessionStats.combo);
    }
    sessionStats.perfectStreak = userMoves.every(m => m.cpl <= 100) && userMoves.length >= 4;

    try {
        const resp = await fetch(API_BASE + '/api/rating/' + userId + '/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                moves: userMoves,
                openingDifficulty: sessionStats.openingDifficulty || userRating,
                recentDeltas,
                mateBlunder: sessionStats.mateBlunder,
                hangsQueen: sessionStats.hangsQueen,
                repeatedBlunder: sessionStats.repeatedBlunder,
                maxCombo: sessionStats.maxCombo,
                comboHistory: sessionStats.comboHistory,
                perfectStreak: sessionStats.perfectStreak
            })
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        userRating = data.newRating;
        gamesPlayed = data.gamesPlayed;
        recentDeltas = data.recentDeltas || [];
        localStorage.setItem('chessRating', userRating);
        localStorage.setItem('gamesPlayed', gamesPlayed);
        updateRatingUI();

        let mapResult = null;
        if (typeof VoyageMap !== 'undefined' && VoyageMap.hasActiveOpening()) {
            mapResult = VoyageMap.recordResult(data.delta, sessionStats);
        }

        const pgn = game.pgn();
        showLichessAnalysisButton(pgn);

        setTimeout(() => showSessionResults(oldRating, data.delta, mapResult), 400);
    } catch (e) {
        console.error('Не удалось обновить рейтинг:', e);
        updateStatus('❌ Не удалось обновить рейтинг');
    }
}

// ============================================
// UI — результаты партии
// ============================================

function showSessionResults(oldRating, ratingChange, mapResult) {
SoundEngine.gameEnd();
setTimeout(() => {
(ratingChange >= 0 ? SoundEngine.ratingUp : SoundEngine.ratingDown)();
}, 500);

const cats = sessionStats.categories;
const userMoves = sessionStats.moves;
let userMovesCount = 0;
let worst = null;

for (let i = 0; i < userMoves.length; i++) {
const m = userMoves[i];
if (m.isUserMove) userMovesCount++;
if (!worst || m.cpl > worst.cpl) worst = m;
}

let voyageData = null, isVictory = false, isSunk = false;
if (typeof VoyageEngine !== 'undefined' && VoyageEngine.state.movesMade > 0) {
voyageData = VoyageEngine.getStats();
isVictory = voyageData.isVictory;
isSunk = voyageData.isSunk;
}

const mood = isSunk ? 'defeat' : isVictory ? 'victory' : 'neutral';

DOM.goDateline[0].textContent = 'Экстренный выпуск • №' + gamesPlayed + ' • ' + userMovesCount + ' ходов';

const headline = isVictory ? 'КРАКЕН ПОВЕРЖЕН: КОРАБЛЬ В ПОРТУ!'
: isSunk ? 'КРАКЕН ПОТОПИЛ КОРАБЛЬ!' : 'ЭКСПЕДИЦИЯ ЗАВЕРШЕНА';

const titleEl = DOM.goTitle[0];
titleEl.textContent = headline;
titleEl.className = 'game-over-title game-over-title--' + mood;

// Звёзды
if (voyageData && isVictory) {
const starCount = voyageData.hp === voyageData.maxHP ? 3 : voyageData.hp >= 3 ? 2 : 1;
DOM.goStars[0].innerHTML = '⭐'.repeat(starCount) + '☆'.repeat(3 - starCount);
DOM.goStars.removeClass('hidden');
} else {
DOM.goStars.addClass('hidden');
}

// Иллюстрация
DOM.goIllustration.toggleClass('hidden', !isSunk);

// Рейтинг
const sign = ratingChange >= 0 ? '+' : '';
DOM.goRatingDelta[0].textContent = sign + ratingChange;
DOM.goRatingDelta[0].className = 'rating-delta rating-delta--' +
(ratingChange === 0 ? 'zero' : ratingChange > 0 ? 'positive' : 'negative');
DOM.goRatingTransition[0].innerHTML = oldRating + ' → <b>' + userRating + '</b>';

// Категории ходов — одна строка HTML
const catData = [
['📘', 'Теория', cats.theory, 'cat-theory'],
['✅', 'Хорошие', cats.good, 'cat-good'],
['⚠️', 'Неточности', cats.inaccuracy, 'cat-inaccuracy'],
['❌', 'Ошибки', cats.mistake, 'cat-mistake'],
['🔥', 'Зевки', cats.blunder, 'cat-blunder'],
['💀', 'Грубые', cats.grossBlunder, 'cat-gross'],
['☠️', 'Катастрофы', cats.catastrophe, 'cat-catastrophe']
];

let catHtml = '';
for (let i = 0; i < catData.length; i++) {
const [icon, label, count, cls] = catData[i];
if (count === 0) continue;
catHtml += '<div class="voyage-stat-row">' +
'<span class="voyage-stat-label ' + cls + '">' + icon + ' ' + label + '</span>' +
'<span class="voyage-stat-value ' + cls + ' voyage-stat-value--bold">' + count + '</span>' +
'</div>';
}
DOM.goCategories[0].innerHTML = catHtml;

// Комбо
if (sessionStats.maxCombo >= 3) {
DOM.goComboValue[0].textContent = sessionStats.maxCombo + ' ходов';
DOM.goComboSection.removeClass('hidden');
} else {
DOM.goComboSection.addClass('hidden');
}

// Voyage секция
if (voyageData) {
DOM.goHull[0].textContent = voyageData.hp + '/' + voyageData.maxHP;
DOM.goRepairs[0].textContent = voyageData.timesRepaired;
DOM.goDamage[0].textContent = voyageData.damageTotal;

if (voyageData.criticalHits > 0) {
DOM.goCrits[0].textContent = voyageData.criticalHits;
DOM.goCritsRow.removeClass('hidden');
} else {
DOM.goCritsRow.addClass('hidden');
}
DOM.goVoyageSection.removeClass('hidden');
} else {
DOM.goVoyageSection.addClass('hidden');
}

// Достижения
if (voyageData && voyageData.achievements.length > 0) {
const iconMap = {
first_blood: '🎯', unsinkable: '🛡️', kraken_slayer: '⚔️',
navigator: '🧭', explorer: '🗺️', survivor: '💪'
};
let achHtml = '';
for (let i = 0; i < voyageData.achievements.length; i++) {
const a = voyageData.achievements[i];
achHtml += '<span class="achievement-badge">' + (iconMap[a] || '🏆') + '</span>';
}
DOM.goAchievements[0].innerHTML = achHtml;
DOM.goAchievements.removeClass('hidden');
} else {
DOM.goAchievements.addClass('hidden');
}

// Штрафы
const penalties = [];
if (sessionStats.repeatedBlunder) penalties.push('🔁 Повторный зевок');
if (sessionStats.mateBlunder) penalties.push('😱 Пропущен мат');
if (sessionStats.hangsQueen) penalties.push('👑 Зевок ферзя');

if (penalties.length) {
DOM.goPenalties[0].textContent = penalties.join(' · ');
DOM.goPenalties.removeClass('hidden');
} else {
DOM.goPenalties.addClass('hidden');
}

// Худший ход
if (worst && worst.cpl > 200) {
DOM.goWorstValue[0].innerHTML =
'💀 <b>' + worst.san + '</b> (ход ' + worst.moveNumber +
') — <span class="voyage-stat-value--critical">−' + Math.round(worst.cpl) + '</span>';
DOM.goWorstMove.removeClass('hidden');
} else {
DOM.goWorstMove.addClass('hidden');
}

// Совет при поражении
if (isSunk) {
const tips = [
'Неточность = 1 урон. Ошибка = 2 + деморализация. Зевок = 3 + течь + пробоина.',
'Починка стоит 4 очка и дорожает. Теория = 2, хороший = 1.',
'После 50% пути урон x1.4, после 75% — x1.8. Берегите HP.',
'Шторм усиливает ошибки на 50%. Не зевайте в шторм.',
'Пробоина заживает за 6 хороших ходов подряд.',
'Комбо x6 = +1 починки. Стабильность важнее гениальности.',
'Катастрофа снижает макс HP навсегда.',
'Течь от зевка = отложенный урон. Два зевка = двойная течь.'
];
DOM.goDefeatTip[0].textContent = '💡 ' + tips[(Math.random() * tips.length) | 0];
DOM.goDefeatTip.removeClass('hidden');
} else {
DOM.goDefeatTip.addClass('hidden');
}

// Кнопка повтора FEN
DOM.goRetryBtn.toggleClass('hidden', !(lastCustomFEN && lastCustomColor));

// Результат экспедиции
if (mapResult && DOM.goMapResult.length) {
const opening = VoyageMap.getActiveOpening ? VoyageMap._activeOpening : null;
const openingName = opening ? opening.name : '';
const mapStarsHtml = '⭐'.repeat(mapResult.stars) + '☆'.repeat(3 - mapResult.stars);

DOM.goMapResult[0].innerHTML =
'<div class="map-result-row">' +
'<span class="map-result-label">📚 ' + openingName + '</span>' +
'</div>' +
'<div class="map-result-row">' +
'<span class="map-result-stars">' + mapStarsHtml + '</span>' +
'<span class="map-result-accuracy">Точность: ' + mapResult.accuracy + '%</span>' +
'</div>';
DOM.goMapResult.removeClass('hidden');
} else if (DOM.goMapResult.length) {
DOM.goMapResult.addClass('hidden');
}

showUnifiedModal(mood);
}

// ============================================
// Модалка результатов
// ============================================

function showUnifiedModal(mood) {
    if (typeof VoyageEngine !== 'undefined' && VoyageEngine.closeOverlay) {
        VoyageEngine.closeOverlay();
    }

    const $modal = DOM.modal;
    const $card = DOM.gameOverCard;

    // Убираем только классы настроения, не трогая базовые
    $modal.removeClass('result-victory result-defeat result-neutral show');
    $card.removeClass('result-defeat');

    // Ставим новый класс настроения
    if (mood === 'victory') $modal.addClass('result-victory');
    else if (mood === 'defeat') {
        $modal.addClass('result-defeat');
        $card.addClass('result-defeat');
    } else {
        $modal.addClass('result-neutral');
    }

    // Показываем
    requestAnimationFrame(() => {
        $modal.addClass('show');
    });
}

function closeUnifiedModal() {
    DOM.modal.removeClass('show');
}
// ============================================
// UI — обновление статуса и рейтинга
// ============================================

function updateStatus(msg) {
if (DOM.status && DOM.status.length) DOM.status[0].innerHTML = msg;
}

function updateRatingUI() {
if (DOM.ratingValue && DOM.ratingValue.length) DOM.ratingValue[0].textContent = userRating;
if (DOM.gamesDisplay && DOM.gamesDisplay.length) DOM.gamesDisplay[0].textContent = gamesPlayed;
}

// ============================================
// Live Stats — с батчингом через rAF
// ============================================

let liveStatsScheduled = false;

function updateLiveStats() {
if (liveStatsScheduled) return;
liveStatsScheduled = true;

requestAnimationFrame(() => {
liveStatsScheduled = false;

const moves = sessionStats.moves;
let moveCount = 0, goodMoves = 0, blunders = 0;

for (let i = 0; i < moves.length; i++) {
const m = moves[i];
if (!m.isUserMove) continue;
moveCount++;
if (m.cpl <= 50) goodMoves++;
if (m.cpl > 200) blunders++;
}

DOM.statMoves[0].textContent = moveCount;
DOM.statBestCombo[0].textContent = sessionStats.maxCombo;

if (moveCount > 0) {
const accuracy = Math.round((goodMoves / moveCount) * 100);
const accEl = DOM.statAccuracy[0];
accEl.textContent = accuracy + '%';
accEl.style.color = accuracy >= 90 ? '#39ff7a'
: accuracy >= 70 ? '#ffde59'
: accuracy >= 50 ? '#ffab40' : '#ff5c5c';
} else {
DOM.statAccuracy[0].textContent = '—';
DOM.statAccuracy[0].style.color = '#fff';
}

const blunderEl = DOM.statBlunders[0];
blunderEl.textContent = blunders;
blunderEl.style.color = blunders > 0 ? '#ff2e93' : '#fff';
});
}

function resetLiveStats() {
    if (!DOM.statMoves || !DOM.statMoves.length) return;
    DOM.statMoves[0].textContent = '0';
    DOM.statAccuracy[0].textContent = '—';
    DOM.statAccuracy[0].style.color = '#fff';
    DOM.statBestCombo[0].textContent = '0';
    DOM.statBlunders[0].textContent = '0';
    DOM.statBlunders[0].style.color = '#fff';
}

function updateLiveStats() {
    if (liveStatsScheduled) return;
    liveStatsScheduled = true;

    requestAnimationFrame(() => {
        liveStatsScheduled = false;

        if (!DOM.statMoves || !DOM.statMoves.length) return;

        const moves = sessionStats.moves;
        let moveCount = 0, goodMoves = 0, blunders = 0;

        for (let i = 0; i < moves.length; i++) {
            const m = moves[i];
            if (!m.isUserMove) continue;
            moveCount++;
            if (m.cpl <= 50) goodMoves++;
            if (m.cpl > 200) blunders++;
        }

        DOM.statMoves[0].textContent = moveCount;
        DOM.statBestCombo[0].textContent = sessionStats.maxCombo;

        if (moveCount > 0) {
            const accuracy = Math.round((goodMoves / moveCount) * 100);
            const accEl = DOM.statAccuracy[0];
            accEl.textContent = accuracy + '%';
            accEl.style.color = accuracy >= 90 ? '#39ff7a'
                : accuracy >= 70 ? '#ffde59'
                : accuracy >= 50 ? '#ffab40' : '#ff5c5c';
        } else {
            DOM.statAccuracy[0].textContent = '—';
            DOM.statAccuracy[0].style.color = '#fff';
        }

        const blunderEl = DOM.statBlunders[0];
        blunderEl.textContent = blunders;
        blunderEl.style.color = blunders > 0 ? '#ff2e93' : '#fff';
    });
}

// ============================================
// Комбо-фидбек
// ============================================

function showComboFeedback(combo, category, cpl) {
let msg = COMBO_ICONS[category] + ' ' + COMBO_LABELS[category];

if (cpl > 30 && category !== 'theory') {
msg += ' <small style="opacity:.7">−' + Math.round(cpl) + ' сп</small>';
}

if (combo >= 2) {
const tier = getComboTier(combo);
msg += ' <span class="combo-badge ' + tier.cssClass + '">' + tier.icon + '×' + combo + '</span>';
}

const wasCombo = sessionStats.maxCombo >= 3;
if (combo === 0 && wasCombo && isComboBreaker(category)) {
msg += ' <span class="combo-break">💔 Серия прервана</span>';
}

updateStatus(msg);

// Звуки
if (category === 'catastrophe') SoundEngine.catastrophe();
else if (category === 'blunder' || category === 'grossBlunder') SoundEngine.blunder();

if (combo === 3 || combo === 5 || combo === 8 || combo === 12) {
const tier = getComboTier(combo);
SoundEngine.comboUp(combo);
pulseBoard(tier.color);
}

if (combo === 0 && wasCombo && isComboBreaker(category)) {
SoundEngine.comboBreak();
}

updateComboBar(combo);
updateLiveStats();
}

function getComboTier(combo) {
if (combo >= 12) return { icon: '💎', label: 'НЕВЕРОЯТНО', cssClass: 'combo-legendary', color: '#005f73', multiplier: 1.5 };
if (combo >= 8) return { icon: '🌊', label: 'В УДАРЕ', cssClass: 'combo-epic', color: '#0a9396', multiplier: 1.35 };
if (combo >= 5) return { icon: '✨', label: 'ОТЛИЧНО', cssClass: 'combo-great', color: '#81B29A', multiplier: 1.2 };
if (combo >= 3) return { icon: '🍃', label: 'КОМБО', cssClass: 'combo-good', color: '#0E1A4C', multiplier: 1.1 };
return { icon: '', label: '', cssClass: '', color: 'transparent', multiplier: 1.0 };
}

function pulseBoard(color) {
const el = DOM.board[0];
el.style.boxShadow = '0 0 30px ' + color;
setTimeout(() => { el.style.boxShadow = 'none'; }, 800);
}

function updateComboBar(combo) {
if (!DOM.comboFill.length) return;

const pct = combo >= 12 ? 100 : (combo / 12) * 100;
DOM.comboFill[0].style.width = pct + '%';

const multEl = DOM.comboMultiplier[0];
if (combo >= 3) {
const tier = getComboTier(combo);
multEl.textContent = 'x' + tier.multiplier.toFixed(1);
multEl.style.color = tier.color;
} else {
multEl.textContent = 'x1';
multEl.style.color = 'rgba(255,255,255,0.5)';
}
}

// ============================================
// Нотация — нативный DOM
// ============================================

function appendMoveToNotation(move, category, isUserMove) {
const historyEl = DOM.moveHistory[0];
if (!historyEl) return;

const san = typeof move === 'string' ? move : move.san;
if (!san) return;

const cssClass = isUserMove ? (category || 'pending') : 'opponent';
const isWhiteMove = move.color ? (move.color === 'w') : (notationHalfMoves % 2 === 0);
const moveNumber = Math.floor(notationHalfMoves / 2) + 1;

if (isWhiteMove) {
const pair = document.createElement('div');
pair.className = 'move-pair';
pair.dataset.halfmove = notationHalfMoves;

const numSpan = document.createElement('span');
numSpan.className = 'move-number';
numSpan.textContent = moveNumber + '.';

const sanSpan = document.createElement('span');
sanSpan.className = 'move-san ' + cssClass;
sanSpan.dataset.san = san;
sanSpan.textContent = san;

pair.appendChild(numSpan);
pair.appendChild(sanSpan);
historyEl.appendChild(pair);
lastMovePairEl = pair;
} else {
const targetPair = lastMovePairEl || historyEl.lastElementChild;

if (targetPair && targetPair.querySelectorAll('.move-san').length === 1) {
const sanSpan = document.createElement('span');
sanSpan.className = 'move-san ' + cssClass;
sanSpan.dataset.san = san;
sanSpan.textContent = san;
targetPair.appendChild(sanSpan);
} else {
const pair = document.createElement('div');
pair.className = 'move-pair';
pair.dataset.halfmove = notationHalfMoves;

const numSpan = document.createElement('span');
numSpan.className = 'move-number';
numSpan.textContent = moveNumber + '.';

const placeholder = document.createElement('span');
placeholder.className = 'move-san placeholder';
placeholder.textContent = '...';

const sanSpan = document.createElement('span');
sanSpan.className = 'move-san ' + cssClass;
sanSpan.dataset.san = san;
sanSpan.textContent = san;

pair.appendChild(numSpan);
pair.appendChild(placeholder);
pair.appendChild(sanSpan);
historyEl.appendChild(pair);
lastMovePairEl = pair;
}
}

notationHalfMoves++;
historyEl.scrollTop = historyEl.scrollHeight;
}

function updateMoveCategory(san, category, isUserMove) {
if (!isUserMove) return;
const historyEl = DOM.moveHistory[0];
if (!historyEl) return;

const pendingElements = historyEl.querySelectorAll('.move-san.pending[data-san="' + san + '"]');
if (pendingElements.length > 0) {
const el = pendingElements[pendingElements.length - 1];
el.classList.remove('pending');
el.classList.add(category);
}
}

// ============================================
// Подсветка клеток — нативный DOM
// ============================================

function getSquareFromElement(el) {
let node = el;
for (let i = 0; i < 3 && node; i++) {
if (node.dataset && node.dataset.square) return node.dataset.square;
const cls = node.className;
if (typeof cls === 'string') {
const idx = cls.indexOf('square-');
if (idx !== -1) {
const sub = cls.substring(idx + 7, idx + 9);
if (sub.length === 2 &&
sub.charCodeAt(0) >= 97 && sub.charCodeAt(0) <= 104 &&
sub.charCodeAt(1) >= 49 && sub.charCodeAt(1) <= 56) {
return sub;
}
}
}
node = node.parentElement;
}
return null;
}

function highlightClickSquare(square) {
clearClickHighlight();
const el = document.querySelector('#board .square-' + square);
if (el) el.classList.add('click-selected');
}

function highlightLegalMoves(square) {
const moves = game.moves({ square, verbose: true });
for (let i = 0; i < moves.length; i++) {
const m = moves[i];
const el = document.querySelector('#board .square-' + m.to);
if (el) el.classList.add(m.captured ? 'legal-capture' : 'legal-dot');
}
}

function clearClickHighlight() {
const boardEl = document.getElementById('board');
if (!boardEl) return;

const selected = boardEl.querySelectorAll('.click-selected');
for (let i = 0; i < selected.length; i++) selected[i].classList.remove('click-selected');

const dots = boardEl.querySelectorAll('.legal-dot');
for (let i = 0; i < dots.length; i++) dots[i].classList.remove('legal-dot');

const captures = boardEl.querySelectorAll('.legal-capture');
for (let i = 0; i < captures.length; i++) captures[i].classList.remove('legal-capture');
}

// ============================================
// Tap-to-move
// ============================================

function onSquareClick(square) {
if (!sessionActive) return;

const piece = game.get(square);

if (selectedSquare) {
const from = selectedSquare;

if (from === square) {
clearClickHighlight();
selectedSquare = null;
lastTapAction = 'deselect';
return;
}

if (waitingForOpponent) {
if (piece && isOwnPiece(piece)) {
clearClickHighlight();
selectedSquare = square;
highlightClickSquare(square);
lastTapAction = 'select';
return;
}
premoveData = { source: from, target: square };
highlightPremove(from, square);
updateStatus('⏩ Предход: ' + source + '→' + target);
clearClickHighlight();
selectedSquare = null;
lastTapAction = 'premove';
return;
}

if (piece && isOwnPiece(piece)) {
clearClickHighlight();
selectedSquare = square;
highlightClickSquare(square);
highlightLegalMoves(square);
lastTapAction = 'select';
return;
}

const fenBefore = game.fen();
const move = game.move({ from: from, to: square, promotion: 'q' });
if (move === null) {
SoundEngine.illegal();
clearClickHighlight();
selectedSquare = null;
lastTapAction = 'illegal';
return;
}

board.position(game.fen(), true);
playMoveSound(move);
waitingForOpponent = true;
clearClickHighlight();
selectedSquare = null;
lastTapAction = 'move';
processPlayerMove(move, fenBefore);
return;
}

if (piece && isOwnPiece(piece)) {
selectedSquare = square;
highlightClickSquare(square);
if (!waitingForOpponent) {
highlightLegalMoves(square);
}
lastTapAction = 'select';
}
}

// ============================================
// Drag & Drop
// ============================================

function onDragStart(source, piece, position, orientation) {
if (isTouchDevice) return false;
if (!sessionActive) return false;
if (game.game_over()) return false;

if (selectedSquare) {
clearClickHighlight();
selectedSquare = null;
}

const pieceColor = piece[0];
if ((playerColor === 'white' && pieceColor === 'b') ||
(playerColor === 'black' && pieceColor === 'w')) {
return false;
}

return true;
}

// ============================================
// Игровой цикл
// ============================================

async function makeFirstWhiteMove() {
    try {
        const response = await fetch(`${API_BASE}/get-move`, {   // ← исправлено
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen: game.fen(), rating: userRating })
        });
        const data = await response.json();

        if (data.move) {
            const result = game.move(data.move);
            if (result) {
                board.position(game.fen(), true);
                appendMoveToNotation(result, 'opponent', false);
            }
        }
    } catch (e) {
        console.error('makeFirstWhiteMove error:', e);
    }
    waitingForOpponent = false;
}

function startGame() {
lastCustomFEN = null;
lastCustomColor = null;
isCustomFENSession = false;
selectedSquare = null;
lastTapSquare = null;
lastTapAction = null;
lastMovePairEl = null;
clearClickHighlight();

if (!board) { alert('Доска ещё не загрузилась!'); return; }

game.reset();
sessionStats = createEmptyStats();
sessionStats.openingDifficulty = userRating;
sessionActive = true;
pendingEndSession = false;
movesOutOfBook = 0;
notationHalfMoves = 0;
premoveData = null;
clearPremoveHighlight();
evalCache.clear();

playerColor = document.getElementById('playerColor').value;
waitingForOpponent = false;
board.orientation(playerColor);
board.position('start', false);

if (playerColor === 'black') {
waitingForOpponent = true;
setTimeout(makeFirstWhiteMove, 300);
}

DOM.moveHistory[0].innerHTML = '';
DOM.openingBadge[0].textContent = 'Начальная позиция';
DOM.krakenMessage[0].textContent = 'Кракен наблюдает за вашими ходами...';
updateComboBar(0);
resetLiveStats();

if (DOM.lichessBtn) {
DOM.lichessBtn.classList.remove('visible');
DOM.lichessBtn.onclick = null;
}

if (typeof VoyageEngine !== 'undefined') {
VoyageEngine.init(15);
}

updateStatus('Тренировка дебюта началась!');
SoundEngine.gameStart();
}

function startGameFromFEN(fen, color) {
lastCustomFEN = fen;
lastCustomColor = color;
isCustomFENSession = true;
selectedSquare = null;
lastTapSquare = null;
lastTapAction = null;
lastMovePairEl = null;
clearClickHighlight();

if (!board) { alert('Доска ещё не загрузилась!'); return; }

const loaded = game.load(fen);
if (!loaded) {
updateStatus('❌ Невозможно загрузить позицию');
return;
}

sessionStats = createEmptyStats();
sessionStats.openingDifficulty = userRating;
sessionActive = true;
pendingEndSession = false;
movesOutOfBook = 0;
premoveData = null;
clearPremoveHighlight();
evalCache.clear();

const fenParts = fen.split(/\s+/);
const fenTurn = fenParts[1] || 'w';
const fenFullmove = parseInt(fenParts[5]) || 1;
notationHalfMoves = (fenFullmove - 1) * 2 + (fenTurn === 'b' ? 1 : 0);

playerColor = color;
document.getElementById('playerColor').value = color;
waitingForOpponent = false;

board.orientation(playerColor);
board.position(game.fen(), false);

DOM.moveHistory[0].innerHTML = '';
DOM.openingBadge[0].textContent = 'Пользовательская позиция';
DOM.krakenMessage[0].textContent = 'Кракен наблюдает за вашими ходами...';
updateComboBar(0);
resetLiveStats();

if (DOM.lichessBtn) {
DOM.lichessBtn.classList.remove('visible');
DOM.lichessBtn.onclick = null;
}

if (typeof VoyageEngine !== 'undefined') {
VoyageEngine.init(15);
}

SoundEngine.gameStart();

const currentTurn = game.turn();
const isPlayerTurn =
(playerColor === 'white' && currentTurn === 'w') ||
(playerColor === 'black' && currentTurn === 'b');

if (!isPlayerTurn) {
waitingForOpponent = true;
updateStatus('⏳ Соперник думает...');
setTimeout(makeEngineReplyFromPosition, 300);
} else {
updateStatus('♟ Ваш ход!');
}
}

async function makeEngineReplyFromPosition() {
try {
const fen = game.fen();

let replied = false;
try {
const response = await fetch(API_BASE + '/get-move', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ fen: fen, rating: userRating })
});
const data = await response.json();
if (data.move) {
const result = game.move(data.move);
if (result) {
board.position(game.fen(), true);
playMoveSound(result);
appendMoveToNotation(result, 'opponent', false);
                    replied = true;
                }
            }
        } catch (e) {
            console.warn('Книга недоступна, используем движок');
        }

        if (!replied) {
            const depth = getEngineDepthForRating(userRating);
            const bestMove = await getEngineBestMoveAdaptive(fen, depth);
            if (bestMove) {
                const result = game.move({
                    from: bestMove.slice(0, 2),
                    to: bestMove.slice(2, 4),
                    promotion: bestMove.length > 4 ? bestMove[4] : 'q'
                });
                if (result) {
                    board.position(game.fen(), true);
                    playMoveSound(result);
                    appendMoveToNotation(result, 'opponent', false);
                }
            }
        }

        waitingForOpponent = false;
        if (game.game_over()) {
            scheduleEndSession();
        }
    } catch (e) {
        console.error('makeEngineReplyFromPosition error:', e);
        waitingForOpponent = false;
    }
}

// ============================================
// Lichess
// ============================================

function showLichessAnalysisButton(pgn) {
 if (!DOM.lichessBtn) return;

 const API_BASE = 'http://localhost:3000'; // замени на свой backend URL DOM.lichessBtn.href = '#';
 DOM.lichessBtn.onclick = function (e) {
 e.preventDefault();

 const form = document.createElement('form');
 form.method = 'POST';
 form.action = `${API_BASE}/lichess-redirect`;
 form.target = '_blank';
 form.style.display = 'none';

 const input = document.createElement('input');
 input.type = 'hidden';
 input.name = 'pgn';
 input.value = pgn || '';

 form.appendChild(input);
 document.body.appendChild(form);
 form.submit();
 form.remove();
 };

 DOM.lichessBtn.classList.add('visible');
}

// ============================================
// Переключатель темы
// ============================================

(function () {
    'use strict';

    const STORAGE_KEY = 'kraken-theme';
    const toggle = document.getElementById('theme-toggle');
    const label = document.getElementById('theme-label');
    const darkStylesheet = document.getElementById('dark-theme-link');

    function getInitialTheme() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return saved;
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        return 'light';
    }

    function applyTheme(theme, animate) {
        const isDark = theme === 'dark';

        if (animate) {
            document.documentElement.classList.add('theme-transitioning');
            setTimeout(() => {
                document.documentElement.classList.remove('theme-transitioning');
            }, 500);
        }

        if (darkStylesheet) {
            if (isDark) darkStylesheet.removeAttribute('disabled');
            else darkStylesheet.setAttribute('disabled', 'true');
        }

        document.documentElement.setAttribute('data-theme', theme);

        if (toggle) toggle.checked = isDark;
        if (label) label.textContent = isDark ? '🌙 Тёмная' : '☀️ Светлая';

        let metaTheme = document.querySelector('meta[name="theme-color"]');
        if (!metaTheme) {
            metaTheme = document.createElement('meta');
            metaTheme.name = 'theme-color';
            document.head.appendChild(metaTheme);
        }
        metaTheme.content = isDark ? '#0a0e17' : '#f5f0e8';

        localStorage.setItem(STORAGE_KEY, theme);

        window.dispatchEvent(new CustomEvent('themechange', {
            detail: { theme }
        }));
    }

    const initialTheme = getInitialTheme();
    applyTheme(initialTheme, false);

    if (toggle) {
        toggle.addEventListener('change', function () {
            applyTheme(this.checked ? 'dark' : 'light', true);
        });
    }

    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (!localStorage.getItem(STORAGE_KEY)) {
                applyTheme(e.matches ? 'dark' : 'light', true);
            }
        });
    }

    window.ThemeManager = {
        get current() {
            return document.documentElement.getAttribute('data-theme') || 'light';
        },
        set(theme) { applyTheme(theme, true); },
        toggle() {
            applyTheme(this.current === 'dark' ? 'light' : 'dark', true);
        }
    };
})();

// ============================================
// Проверка Skill Level
// ============================================

function testSkillLevelSupport() {
    const e = engines[0];
    if (!e || !e.ready) {
        setTimeout(testSkillLevelSupport, 2000);
        return;
    }

    const origOnMessage = e.worker.onmessage;
    let optionFound = false;

    e.worker.onmessage = function (event) {
        const data = event.data;
        if (typeof data !== 'string') return;

        if (data.includes('option name Skill Level')) {
            optionFound = true;
            console.log('✅ Skill Level ПОДДЕРЖИВАЕТСЯ:', data.trim());
        }

        if (data === 'uciok') {
            e.worker.onmessage = origOnMessage;

            if (optionFound) {
                console.log('✅ Skill Level поддерживается!');
                console.log(`   Rating: ${userRating}, Skill: ${getSkillLevelForRating(userRating)}, Depth: ${getEngineDepthForRating(userRating)}`);
            } else {
                console.warn('⚠️ Skill Level НЕ поддерживается — только ограничение глубины.');
            }
        }
    };

    e.worker.postMessage('uci');
}

// ============================================
// Сброс рейтинга
// ============================================

async function handleRatingReset() {
    const newRating = parseInt($('#startRating').val());
    const ALLOWED = [1000, 1400, 1800, 2200];

    if (isNaN(newRating) || !ALLOWED.includes(newRating)) {
        updateStatus('⚠️ Недопустимый рейтинг. Выберите из 1000, 1400, 1800, 2200.');
        return;
    }

    if (newRating === userRating && gamesPlayed === 0) {
        updateStatus('✅ Рейтинг уже ' + newRating);
        return;
    }

    try {
        const resp = await fetch(API_BASE + '/api/rating/' + userId + '/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rating: newRating })
        });

        if (!resp.ok) {
            const err = await resp.json();
            updateStatus('❌ Ошибка: ' + (err.error || resp.statusText));
            return;
        }

        const data = await resp.json();
        userRating = data.rating;
        gamesPlayed = data.games || 0;
        recentDeltas = [];

        localStorage.setItem('chessRating', userRating);
        localStorage.setItem('gamesPlayed', gamesPlayed);
        updateRatingUI();
        updateStatus('✅ Рейтинг сброшен на ' + userRating + '. Удачи!');
    } catch (e) {
        console.error('Ошибка сброса рейтинга:', e);
        updateStatus('❌ Не удалось применить рейтинг');
    }
}

// ============================================
// Инициализация
// ============================================

$(document).ready(async function () {
    cacheDOMElements();

    board = Chessboard('board', {
        draggable: !isTouchDevice,
        position: 'start',
        orientation: 'white',
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd,
        pieceTheme: '/chesspieces/alpha/{piece}.png',
        appearSpeed: 200,
        moveSpeed: 200,
        snapSpeed: 25,
        snapbackSpeed: 100,
        trashSpeed: 200
    });

    // Кнопки — делегирование
    const modalHandlers = {
        'go-btn-new-game': () => { closeUnifiedModal(); startGame(); },
        'go-btn-retry-fen': () => {
            closeUnifiedModal();
            if (lastCustomFEN && lastCustomColor) startGameFromFEN(lastCustomFEN, lastCustomColor);
        },
        'go-btn-close': closeUnifiedModal,
        'btn-map': () => { if (typeof VoyageMap !== 'undefined') VoyageMap.openMap(); }
    };

    $(document).on('click', '#go-btn-new-game, #go-btn-retry-fen, #go-btn-close, #btn-map', function () {
        const handler = modalHandlers[this.id];
        if (handler) handler();
    });

    // Ресайз с debounce
    let resizeTimer;
    $(window).on('resize', function () {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { if (board) board.resize(); }, 150);
    });

    // Обработчики тапов — нативные
    const boardEl = document.getElementById('board');

    if (isTouchDevice) {
        boardEl.addEventListener('touchstart', function (e) {
            touchMoved = false;
            const touch = e.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
        }, { passive: true });

        boardEl.addEventListener('touchmove', function (e) {
            if (!touchMoved) {
                const touch = e.touches[0];
                const dx = touch.clientX - touchStartX;
                const dy = touch.clientY - touchStartY;
                if (dx * dx + dy * dy > TOUCH_MOVE_THRESHOLD * TOUCH_MOVE_THRESHOLD) {
                    touchMoved = true;
                }
            }
        }, { passive: true });

        boardEl.addEventListener('touchend', function (e) {
            if (touchMoved) { touchMoved = false; return; }
            touchMoved = false;

            const touch = e.changedTouches[0];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);
            if (!target) return;

            const square = getSquareFromElement(target);
            if (!square) return;

            e.preventDefault();
            handleTap(square);
        }, { passive: false });
    } else {
        boardEl.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            const square = getSquareFromElement(e.target);
            if (!square) return;
            handleTap(square);
        });
    }

    function handleTap(square) {
        const now = Date.now();

        if (square === lastTapSquare && now - lastTapTime < TAP_DEDUP_MS) {
            if (lastTapAction !== 'deselect') return;
        }

        lastTapSquare = square;
        lastTapTime = now;
        onSquareClick(square);
    }

    // Разблокировка звука
    document.addEventListener('click', function () {
        SoundEngine.unlock();
    }, { once: true });

    initEngines();
    await loadRatingFromServer();

    setTimeout(testSkillLevelSupport, 3000);

    $('#applyRating').on('click', handleRatingReset);

    console.log('🦑 Kraken Opening Trainer v3.8 loaded');
});
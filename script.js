//============================================
// Kraken — тренажёр дебютов v3.8
// Исправления: нотация всех ходов, drag после клика,
// оптимизация и очистка кода
//============================================

// --- Константы ---
const API_BASE = window.location.hostname === 'localhost' ? '' : 'https://kraken-qslu.onrender.com';
const EVAL_DEPTH = 15;
const NUM_ENGINES = 2;
const EVAL_TIMEOUT_MS = 6000;
const MAX_MOVES_OUT_OF_BOOK = 2;
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
    userId ='u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('userId', userId);
}

// --- Stockfish ---
const engines = [];
const engineWaitQueue = [];

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
    return ['mistake', 'blunder', 'grossBlunder', 'catastrophe'].includes(category);
}

//============================================
// Stockfish — пул воркеров
//============================================

function createEngine(id) {
    const e = { id, worker: null, ready: false, busy: false, resolve: null, turn: 'w', score: 0, isMate: false, timeout: null };
    try {
        e.worker = new Worker('sf-worker2.js');
        e.worker.onmessage = function (event) {
            const data = event.data;
            if (typeof data !== 'string') return;

            if (data === 'uciok') {
                e.worker.postMessage('isready');
            } else if (data === 'readyok') {
                if (!e.ready) {
                    e.ready = true;
                    console.log(`✅ Stockfish #${id} готов`);
                    processEngineQueue();
                }
            } else if (e.resolve) {
                if (data.includes('score cp')) {
                    const m = data.match(/score cp (-?\d+)/);
                    if (m) { e.score = parseInt(m[1]); e.isMate = false; }
                } else if (data.includes('score mate')) {
                    const m = data.match(/score mate (-?\d+)/);
                    if (m) {
                        e.score = parseInt(m[1]) > 0 ? 10000 : -10000;
                        e.isMate = true;
                    }
                } else if (data.startsWith('bestmove')) {
                    const finalScore = e.turn === 'b' ? -e.score : e.score;
                    clearTimeout(e.timeout);
                    const resolve = e.resolve;
                    e.resolve = null;
                    e.busy = false;
                    resolve({ score: finalScore, isMate: e.isMate });
                processEngineQueue();
                }
            }
        };
        e.worker.onerror = function (err) {
            console.error(`❌ SF#${id} error:`, err.message ||'unknown');
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
    e.turn = fen.split(' ')[1];
    e.score = 0;
    e.isMate = false;
    e.timeout = setTimeout(() => {
        if (e.resolve === resolve) {
            console.warn(`⏱ Stockfish #${e.id} timeout`);
            e.resolve = null;
            e.busy = false;
            resolve({ score: 0, isMate: false });
            processEngineQueue();
        }
    }, EVAL_TIMEOUT_MS);
    e.worker.postMessage('position fen ' + fen);e.worker.postMessage('go depth ' + depth);
}

function getEngineEvaluation(fen, depth = EVAL_DEPTH) {
    return new Promise(resolve => {
        const free = findFreeEngine();
        if (free) runEvalOnEngine(free, fen, depth, resolve);
        else engineWaitQueue.push({ fen, depth, resolve });
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

    const clamp = (v) => Math.max(-2000, Math.min(2000, v));
    const lossForPlayer = clamp(evalBeforePlayer) - clamp(evalAfterPlayer);

    const isMateBlunder = evalAfter.isMate && (evalAfter.score * sign) < 0 &&!(evalBefore.isMate && evalBefore.score * sign < 0);

    return { cpl: Math.max(0, lossForPlayer), isMateBlunder };
}

// ============================================
// Серверное взаимодействие
// ============================================

async function loadRatingFromServer() {
    try {
        const response = await fetch(`${API_BASE}/api/rating/${userId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const r = await response.json();
        userRating = r.rating;
        gamesPlayed = r.games || 0;
        recentDeltas = r.recentDeltas || [];
        localStorage.setItem('chessRating', userRating);
        localStorage.setItem('gamesPlayed', gamesPlayed);
        updateRatingUI();
    } catch (e) {
        console.warn('Рейтинг с сервера недоступен, используем локальный:', e.message);
        const savedRating = localStorage.getItem('chessRating');
        if (savedRating) userRating = parseInt(savedRating);
        const savedGames = localStorage.getItem('gamesPlayed');
        if (savedGames) gamesPlayed = parseInt(savedGames);
        updateRatingUI();
    }
}

async function playMoveOnServer(fen, san, rating) {
    try {
        const response = await fetch(`${API_BASE}/play-move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen, san, rating })
        });
        if (!response.ok) {
            console.warn(`/play-move: HTTP ${response.status}`);
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

    // После успешного drag — сбрасываем выделение
    clearClickHighlight();
    selectedSquare = null;

    if (!sessionActive) return'snapback';

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
    if (move.san.includes('O-O')) {
        SoundEngine.moveCastle();
    } else if (move.captured) {
        SoundEngine.moveCapture();
    } else if (move.promotion) {
        SoundEngine.movePromotion();
    } else {
        SoundEngine.moveNormal();
    }
    if (move.san.includes('+') || move.san.includes('#')) {
        setTimeout(() => SoundEngine.moveCheck(), 100);
    }
}

// ============================================
// Обработка хода игрока — с диагностикой нотации
// ============================================

async function processPlayerMove(move, fenBefore) {
    try {
        const fenAfter = game.fen();
        const moveNumber = Math.ceil(game.history().length / 2);
        const playerTurnBefore = fenBefore.split(' ')[1];

        // Записываем ход игрока в нотацию
        console.log('[FLOW] Записываем ход игрока:', move.san, '| color:', move.color);
        appendMoveToNotation(move, 'pending', true);

        // Параллельно:ответ сервера + анализ
        const serverDataPromise = playMoveOnServer(fenBefore, move.san, userRating);
        analyzeMoveInBackground(move, fenBefore, fenAfter, moveNumber, playerTurnBefore, serverDataPromise);

        const serverData = await serverDataPromise;
        console.log('[FLOW] serverData получен:', JSON.stringify(serverData).substring(0, 200));

        if (serverData.gameOver) {
            updateStatus('Партия окончена');
            scheduleEndSession();
            return;
        }

        if (serverData.reply) {
            console.log('[FLOW] Есть reply от сервера:', serverData.reply, '→ вызываем applyOpponentReply через 120мс');
            setTimeout(() => applyOpponentReply(serverData.reply), 120);
        } else {
            console.log('[FLOW] reply=null → вне книги');
            movesOutOfBook++;
            updateStatus(`📚 Вне книги (${movesOutOfBook}/${MAX_MOVES_OUT_OF_BOOK})`);
            if (movesOutOfBook >= MAX_MOVES_OUT_OF_BOOK) {
                updateStatus('📚 Тренировка дебюта завершена');
                scheduleEndSession();
                return;
            }
            makeEngineReply();
        }
    } catch (err) {
        console.error('❌ processPlayerMove:', err);
        waitingForOpponent = false;}
}


// ============================================
// Фоновый анализ хода
// ============================================

async function analyzeMoveInBackground(move, fenBefore, fenAfter, moveNumber, playerTurnBefore, serverDataPromise) {
    sessionStats.pendingAnalysis++;

    try {
        const { cpl, isMateBlunder } = await computeCPL(fenBefore, fenAfter, playerTurnBefore);
        const serverData = await serverDataPromise;
        const bookInfo = serverData.check || { inBook: false, rank: 99, moveCount: 0 };
        const popularityRank = bookInfo.rank || 99;

        if (isMateBlunder) sessionStats.mateBlunder = true;

        const isBookMove = bookInfo.inBook && bookInfo.rank <=3&&
            (bookInfo.moveCount || 0) >= 50 && cpl <= 50;
        const category = categorizeMove(cpl, isBookMove);

        // Комбо
        if (category === 'theory' || category === 'good') {
            sessionStats.combo++;
            if (sessionStats.combo > sessionStats.maxCombo) {
                sessionStats.maxCombo = sessionStats.combo;
            }
        } else if (isComboBreaker(category)) {
            if (sessionStats.combo >=2) {
                sessionStats.comboHistory.push(sessionStats.combo);
            }
            sessionStats.combo = 0;
        }

        showComboFeedback(sessionStats.combo, category, cpl);

        // Штрафы
        if (cpl > 200&& blunderHistory[fenBefore]) sessionStats.repeatedBlunder = true;
        if (cpl > 200) {
            blunderHistory[fenBefore] = true;
            localStorage.setItem('blunderHistory', JSON.stringify(blunderHistory));
        }
        if (cpl >= 700&& move.piece === 'q') sessionStats.hangsQueen = true;

        sessionStats.moves.push({
            cpl: Math.round(cpl), moveNumber, popularityRank,fen: fenBefore, san: move.san, isBookMove,
            isUserMove: true, combo: sessionStats.combo
        });
        sessionStats.categories[category]++;

        // VoyageEngine
        if (typeof VoyageEngine !== 'undefined' && !VoyageEngine.state.isGameOver) {
            const oppPop = VoyageEngine.getOpponentLastPopularity();
            const popularityPercent = bookInfo.moveCount
                ? ((bookInfo.moveCount || 0) / Math.max(1, bookInfo.totalGames || 1)) * 100: 50;

            VoyageEngine.processPlayerMove({
                cpl, category, isBookMove, popularityRank, popularityPercent,
                san: move.san, moveNumber, opponentLastPopularity: oppPop
            });

            if (VoyageEngine.state.isGameOver && VoyageEngine.state.currentHP <= 0) {
                scheduleEndSession();
            }
        }

        updateLiveStats();
        updateMoveCategory(move.san, category, true);} catch (err) {
        console.error('Ошибка фонового анализа:', err);} finally {
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
    console.log('[FLOW] applyOpponentReply вызван с san:', san);

    const result = game.move(san);
    if (!result) {
        console.error('[FLOW] Нелегальный ход от сервера:', san);
        updateStatus('⚠️ Сервер вернул нелегальный ход');
        waitingForOpponent = false;
        return;
    }

    board.position(game.fen(), true);
    playMoveSound(result);

    //★КЛЮЧЕВОЙ ВЫЗОВ — записываем ход соперника
    console.log('[FLOW] Записываем ход соперника:', result.san, '| color:', result.color);
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
    console.log('[FLOW] makeEngineReply вызван');
    try {
        const fen = game.fen();
        const bestMove = await getEngineBestMove(fen, 8);
        console.log('[FLOW] bestMove от движка:', bestMove);

        if (bestMove) {
            const result = game.move({
                from: bestMove.slice(0, 2),
                to: bestMove.slice(2, 4),
                promotion: 'q'
            });
            if (result) {
                board.position(game.fen(), true);
                playMoveSound(result);
                // ★ КЛЮЧЕВОЙ ВЫЗОВ — записываем ход движка
                console.log('[FLOW] Записываем ход движка:', result.san, '| color:', result.color);
                appendMoveToNotation(result, 'opponent', false);
            } else {
                console.error('[FLOW] game.move вернул null для bestMove:', bestMove);
            }
        } else {
            console.warn('[FLOW] bestMove = null, движок не дал ответ');
        }

        waitingForOpponent = false;
        if (game.game_over()) scheduleEndSession();
    } catch (e) {
        console.error('[FLOW] makeEngineReply error:', e);
        waitingForOpponent = false;
    }
}


function getEngineBestMove(fen, depth = 8) {
    return new Promise(resolve => {
        const tryRun = () => {
            const e = findFreeEngine();
            if (!e) { setTimeout(tryRun, 200); return; }
            e.busy = true;
            let bestMove = null;
            const origOnMessage = e.worker.onmessage;
            e.worker.onmessage = function (event) {
                const data = event.data;
                if (typeof data !== 'string') return;
                if (data.startsWith('bestmove')) {
                    const m = data.match(/bestmove (\S+)/);
                    if (m && m[1] !== '(none)') bestMove = m[1];
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

//============================================
// Предходы
// ============================================

function highlightPremove(source, target) {
    clearPremoveHighlight();
    $('#board .square-' + source).addClass('premove-highlight');
    $('#board .square-' + target).addClass('premove-highlight');
}

function clearPremoveHighlight() {
    $('#board .premove-highlight').removeClass('premove-highlight');
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
        const resp = await fetch(`${API_BASE}/api/rating/${userId}/update`, {
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

        setTimeout(() => showSessionResults(oldRating, data.delta), 400);
    } catch (e) {
        console.error('Не удалось обновить рейтинг:', e);
        updateStatus('❌ Не удалось обновить рейтинг');
    }
}

// ============================================
// UI — результаты партии
// ============================================

function showSessionResults(oldRating, ratingChange) {
    SoundEngine.gameEnd();
    setTimeout(() => {
        if (ratingChange >= 0) SoundEngine.ratingUp();
        else SoundEngine.ratingDown();
    }, 500);

    const cats = sessionStats.categories;
    const sign = ratingChange >= 0 ? '+' : '';
    const clr = ratingChange >= 0 ? '#39ff7a' : '#ff5c5c';
    const userMovesCount = sessionStats.moves.filter(m => m.isUserMove).length;

    let worst = null;
    sessionStats.moves.forEach(m => { if (!worst || m.cpl > worst.cpl) worst = m; });

    const catRows = [
        ['📘', 'Теория', cats.theory, '#00e5ff'],
        ['✅', 'Хорошие', cats.good, '#39ff7a'],
        ['⚠️', 'Неточности', cats.inaccuracy, '#ffde59'],
        ['❌', 'Ошибки', cats.mistake, '#ffab40'],
        ['🔥', 'Зевки', cats.blunder, '#ff2e93'],
        ['💀', 'Грубые', cats.grossBlunder, '#b24bf3'],
        ['☠️', 'Катастрофы', cats.catastrophe, '#ff4444']
    ];

    let catHtml = '';
    catRows.forEach(([icon, label, count, color]) => {
        if (count === 0) return;
        catHtml += `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <span style="color:${color};font-size:0.82rem">${icon} ${label}</span>
                <span style="color:${color};font-family:Bungee,cursive;font-size:0.95rem">${count}</span>
            </div>`;
    });

    let comboHtml = '';
    if (sessionStats.maxCombo >= 3) {
        const tier = getComboTier(sessionStats.maxCombo);
        comboHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-top:12px;background:rgba(255,222,89,0.08);border:1px solid rgba(255,222,89,0.25);border-radius:10px;font-size:0.8rem">
                <span>${tier.icon} Лучшая серия</span>
                <span style="font-family:Bungee,cursive;color:#ffde59">${sessionStats.maxCombo} ходов</span>
            </div>`;
    }

    if (sessionStats.perfectStreak) {
        comboHtml += `
            <div style="text-align:center;padding:8px;margin-top:8px;
                        background:rgba(57,255,122,0.08);border:1px solid rgba(57,255,122,0.25);
                        border-radius:10px;color:#39ff7a;font-size:0.82rem;font-weight:700">🏆 Безупречная партия
            </div>`;
    }

    let voyageHtml = '';
    if (typeof VoyageEngine !== 'undefined' && VoyageEngine.state.movesMade > 0) {
        const vs = VoyageEngine.getStats();
        const voyageIcon = vs.isVictory ? '🏝️' : vs.isSunk ? '💀' : '⛵';
        const voyageLabel = vs.isVictory ? 'Гавань достигнута!' :vs.isSunk ? 'Корабль потоплен' :
                            Math.round(vs.progress) + '% пути';
        const voyageColor = vs.isVictory ? '#39ff7a' : vs.isSunk ? '#ff5c5c' : '#ffde59';
        voyageHtml = `
            <div style="margin-top:12px;padding:10px 12px;background:rgba(0,200,255,0.06);border:1px solid rgba(0,200,255,0.2);border-radius:10px">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                    <span style="font-size:0.82rem;color:rgba(255,255,255,0.7)">${voyageIcon} Рейс</span>
                    <span style="font-family:Bungee,cursive;color:${voyageColor};font-size:0.9rem">${voyageLabel}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:rgba(255,255,255,0.5)">
                    <span>🛡️ Корпус: ${vs.hp}/${vs.maxHP}</span>
                    <span>💥 Урон: ${vs.damageTotal}</span>
                    <span>🏆 ${vs.achievements.length} ачивок</span>
                </div>
            </div>`;
    }

    let penaltyHtml = '';
    const penalties = [];
    if (sessionStats.repeatedBlunder) penalties.push('🔁 Повторный зевок');
    if (sessionStats.mateBlunder) penalties.push('😱 Пропущен мат');
    if (sessionStats.hangsQueen) penalties.push('👑 Зевокферзя');
    if (penalties.length) {
        penaltyHtml = `<div style="margin-top:10px;font-size:0.78rem;color:#ff5c5c">${penalties.join(' &nbsp;·&nbsp; ')}</div>`;
    }

    let critHtml = '';
    if (worst && worst.cpl > 200) {
        critHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;margin-top:12px;
                        background:rgba(255,0,0,0.06);border:1px solid rgba(255,70,70,0.25);border-radius:10px;font-size:0.8rem">
                <span>💀 Ход ${worst.moveNumber}: <b style="color:#fff">${worst.san}</b></span>
                <span style="color:#ff4444;font-family:Bungee,cursive">−${Math.round(worst.cpl)}</span>
            </div>`;
    }

    const html = `
    <div>
        <div style="text-align:center;margin-bottom:20px">
            <div style="font-family:Bungee,cursive;font-size:1.2rem;color:#d0b8ff;letter-spacing:0.04em">Итоги партии</div>
            <div style="font-size:0.7rem;color:rgba(255,255,255,0.35);margin-top:4px">${userMovesCount} ходов · партия #${gamesPlayed}</div>
        </div>
        <div style="text-align:center;padding:18px 0;margin-bottom:18px;border-top:1px solid rgba(255,255,255,0.06);border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="font-family:Bungee,cursive;font-size:2.4rem;color:${clr};text-shadow:0 0 24px ${clr};line-height:1">${sign}${ratingChange}</div>
            <div style="font-size:0.85rem;color:rgba(255,255,255,0.5);margin-top:8px">${oldRating} → <b style="color:#fff">${userRating}</b></div>
        </div>
        <div style="margin-bottom:4px">${catHtml}</div>
        ${comboHtml}
        ${voyageHtml}
        ${penaltyHtml}
        ${critHtml}
        <div style="display:flex;gap:10px;margin-top:22px">
            <button style="flex:1;padding:12px;font-family:Bungee,cursive;font-size:0.82rem;border:none;border-radius:10px;cursor:pointer;color:#fff;background:linear-gradient(135deg,#ff2e93,#b24bf3);box-shadow:0 4px 16px rgba(255,46,147,0.35)" onclick="closeModal(); startGame();">Ещё партия</button>
            <button style="flex:1;padding:12px;font-size:0.82rem;font-weight:700;border:1px solid rgba(255,255,255,0.15);border-radius:10px;cursor:pointer;background:transparent;color:rgba(255,255,255,0.6)" onclick="closeModal();">Закрыть</button>
        </div>
    </div>`;

    showModal(html);
}

// ============================================
// UI — модалка, статус, вспомогательные
// ============================================

function showModal(contentHtml) {
    $('#session-modal').remove();
    $('body').append(`
        <div id="session-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(5,2,20,0.92);backdrop-filter:blur(8px);z-index:9999;
            display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.25s ease;">
            <div style="background:#120a30;border:1px solid rgba(178,75,243,0.3);border-radius:16px;
                padding:28px 24px;max-width:380px;width:92%;color:#fff;
                font-family:Space Grotesk,sans-serif;box-shadow:0 16px 60px rgba(0,0,0,0.7);
                max-height:88vh;overflow-y:auto;">${contentHtml}</div>
        </div>`);
    document.getElementById('session-modal').offsetHeight;
    $('#session-modal').css('opacity', '1');
}

function closeModal() {
    $('#session-modal').css('opacity', '0');
    setTimeout(() => $('#session-modal').remove(), 250);
}

function updateStatus(msg) {
    const $status = $('#status');
    if ($status.length) $status.html(msg);
}

function updateRatingUI() {
    $('#rating-value').text(userRating);
    $('#games-display').text(gamesPlayed);
}

function showComboFeedback(combo, category, cpl) {
    const icons = {
        theory: "📘", good: "✅", inaccuracy: "⚠️",
        mistake: "❌", blunder: "🔥", grossBlunder: "💀", catastrophe: "☠️"
    };
    const labels = {
        theory: "Теория", good: "Хороший ход", inaccuracy: "Неточность",
        mistake: "Ошибка", blunder: "Зевок!", grossBlunder: "Грубый зевок!", catastrophe: "Катастрофа!"
    };

    let msg = `${icons[category]} ${labels[category]}`;
    if (cpl > 30&& category !== 'theory') {
        msg += ` <small style="opacity:.7">−${Math.round(cpl)} сп</small>`;
    }

    if (combo >= 2) {
        const comboTier = getComboTier(combo);
        msg += ` <span class="combo-badge ${comboTier.cssClass}">${comboTier.icon}×${combo}</span>`;
    }

    if (combo === 0&& sessionStats.maxCombo >= 3 && isComboBreaker(category)) {
        msg +=` <span class="combo-break">💔 Серия прервана</span>`;
    }

    updateStatus(msg);

    // Звуки
    if (category === 'catastrophe') SoundEngine.catastrophe();
    else if (category === 'blunder' || category === 'grossBlunder') SoundEngine.blunder();

    if (combo === 3|| combo === 5|| combo === 8|| combo === 12) {
        SoundEngine.comboUp(combo);
        pulseBoard(getComboTier(combo).color);
    }

    if (combo === 0&& sessionStats.maxCombo >= 3 && isComboBreaker(category)) {
        SoundEngine.comboBreak();
    }

    updateComboBar(combo);
    updateLiveStats();
}

function getComboTier(combo) {
    if (combo >= 12) return { icon: '💎', label: 'НЕВЕРОЯТНО', cssClass: 'combo-legendary', color: '#005f73', multiplier: 1.5 };
    if (combo >= 8) return { icon: '🌊', label: 'ВУДАРЕ', cssClass: 'combo-epic', color: '#0a9396', multiplier: 1.35 };
    if (combo >= 5) return { icon: '✨', label: 'ОТЛИЧНО', cssClass: 'combo-great', color: '#81B29A', multiplier: 1.2 };
    if (combo >= 3) return { icon: '🍃', label: 'КОМБО', cssClass: 'combo-good', color: '#0E1A4C', multiplier: 1.1 };
    return { icon: '', label: '', cssClass: '', color: 'transparent', multiplier: 1.0 };
}

function pulseBoard(color) {
    const $board = $('#board');
    $board.css('box-shadow', `0 0 30px ${color}`);
    setTimeout(() => $board.css('box-shadow', 'none'), 800);
}

function updateComboBar(combo) {
    const $fill = $('#combo-fill');
    const $mult = $('#combo-multiplier');
    if (!$fill.length) return;

    const pct = Math.min(100, (combo / 12) * 100);
    $fill.css('width', `${pct}%`);

    const tier = getComboTier(combo);
    if (combo >= 3) {
        $mult.text(`x${tier.multiplier.toFixed(1)}`);$mult.css({ color: tier.color});
    } else {
        $mult.text('x1');
        $mult.css({ color: 'rgba(255,255,255,0.5)', textShadow: 'none' });
    }
}

function updateLiveStats() {
    const userMoves = sessionStats.moves.filter(m => m.isUserMove);
    const moveCount = userMoves.length;

    $('#stat-moves').text(moveCount);
    $('#stat-best-combo').text(sessionStats.maxCombo);

    if (moveCount > 0) {
        const goodMoves = userMoves.filter(m => m.cpl <= 50).length;
        const accuracy = Math.round((goodMoves / moveCount) * 100);
        $('#stat-accuracy').text(`${accuracy}%`);
        const accColor = accuracy >= 90 ? '#39ff7a' : accuracy >= 70 ? '#ffde59' : accuracy >= 50 ? '#ffab40' : '#ff5c5c';
        $('#stat-accuracy').css('color', accColor);
    } else {
        $('#stat-accuracy').text('—').css('color', '#fff');
    }

    const blunders = userMoves.filter(m => m.cpl > 200).length;
    $('#stat-blunders').text(blunders);
    $('#stat-blunders').css('color', blunders > 0 ? '#ff2e93' : '#fff');
}

function resetLiveStats() {
    $('#stat-moves').text('0');
    $('#stat-accuracy').text('—').css('color', '#fff');
    $('#stat-best-combo').text('0');
    $('#stat-blunders').text('0').css('color', '#fff');
}

// ============================================
// Нотация — запись ВСЕХ ходов
// ============================================

function appendMoveToNotation(move, category, isUserMove) {
    const $history = $('#move-history');
    if (!$history.length) {
        console.error('[NOTATION] ❌ Элемент #move-history НЕ НАЙДЕН в DOM!');
        return;
    }

    const san = typeof move === 'string' ? move : move.san;
    if (!san) {
        console.error('[NOTATION] ❌ Нет SAN:', move);
        return;
    }

    const cssClass = isUserMove ? (category || 'pending') : 'opponent';

    // Определяем цвет хода
    const isWhiteMove = move.color ? (move.color === 'w') : (notationHalfMoves % 2 === 0);
    const moveNumber = Math.floor(notationHalfMoves / 2) + 1;

    console.log(`[NOTATION] ${isWhiteMove ? '⬜W' : '⬛B'} halfmove=${notationHalfMoves} | ${moveNumber}. ${san} | class="${cssClass}" | isUser=${isUserMove}`);

    if (isWhiteMove) {
        // Белый ход — новая строка
        const $pair = $('<div class="move-pair"></div>');
        $pair.attr('data-halfmove', notationHalfMoves);
        $pair.append(`<span class="move-number">${moveNumber}.</span>`);
        $pair.append(`<span class="move-san ${cssClass}" data-san="${san}">${san}</span>`);
        $history.append($pair);
    } else {
        // Чёрный ход — добавляем в последнюю строку
        const $lastPair = $history.find('.move-pair').last();

        if ($lastPair.length && $lastPair.find('.move-san').length === 1) {
            $lastPair.append(`<span class="move-san ${cssClass}" data-san="${san}">${san}</span>`);
        } else {
            // Крайний случай: строки нет или вней уже 2 хода
            console.warn(`[NOTATION] Крайний случай: создаём строку с "..." для чёрного хода`);
            const $pair = $('<div class="move-pair"></div>');
            $pair.attr('data-halfmove', notationHalfMoves);
            $pair.append(`<span class="move-number">${moveNumber}.</span>`);
            $pair.append(`<span class="move-san placeholder">...</span>`);
            $pair.append(`<span class="move-san ${cssClass}" data-san="${san}">${san}</span>`);
            $history.append($pair);
        }
    }

    notationHalfMoves++;
    $history.scrollTop($history[0].scrollHeight);

    // Проверка: сколько элементов в нотации
    const totalMoves = $history.find('.move-san').not('.placeholder').length;
    console.log(`[NOTATION] Итого в нотации: ${totalMoves} ходов`);
}

function updateMoveCategory(san, category, isUserMove) {
    if (!isUserMove) return;
    const $history = $('#move-history');
    const $pending = $history.find(`.move-san.pending[data-san="${san}"]`).last();
    if ($pending.length) {
        $pending.removeClass('pending').addClass(category);
    }
}


// ============================================
// Подсветка клеток
// ============================================

function isOwnPiece(piece) {
    if (!piece) return false;
    return (playerColor === 'white' && piece.color === 'w') ||
           (playerColor === 'black' && piece.color === 'b');
}

function getSquareFromElement(el) {
    const $sq = $(el).closest('.square-55d63');
    if (!$sq.length) return null;
    const ds = $sq.attr('data-square');
    if (ds) return ds;
    const classes = ($sq.attr('class') || '').split(/\s+/);
    for (const cls of classes) {
        const match = cls.match(/^square-([a-h][1-8])$/);
        if (match) return match[1];
    }
    return null;
}

function highlightClickSquare(square) {
    clearClickHighlight();
    $('#board .square-' + square).addClass('click-selected');
}

function highlightLegalMoves(square) {
    const moves = game.moves({ square: square, verbose: true });
    moves.forEach(m => {
        const $sq = $('#board .square-' + m.to);
        if (m.captured) {
            $sq.addClass('legal-capture');
        } else {
            $sq.addClass('legal-dot');
        }
    });
}

function clearClickHighlight() {
    $('#board .click-selected').removeClass('click-selected');$('#board .legal-dot').removeClass('legal-dot');
    $('#board .legal-capture').removeClass('legal-capture');
}

//============================================
// Tap-to-move (клик по клетке)
// ============================================

function onSquareClick(square) {
    if (!sessionActive) return;

    const piece = game.get(square);

    //═══ Если уже есть выбранная фигура ═══
    if (selectedSquare) {
        const from = selectedSquare;

        // Повторный тап — снимаем выбор
        if (from === square) {
            clearClickHighlight();
            selectedSquare = null;
            lastTapAction = 'deselect';
            return;
        }

        //Ожидание соперника — предходы
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
            updateStatus(`⏩ Предход: ${from}→${square}`);
            clearClickHighlight();
            selectedSquare = null;
            lastTapAction = 'premove';
            return;
        }

        // Тап на другую свою фигуру — переключаем выбор
        if (piece && isOwnPiece(piece)) {
            clearClickHighlight();
            selectedSquare = square;
            highlightClickSquare(square);
            highlightLegalMoves(square);
            lastTapAction = 'select';
            return;
        }

        // Попытка сделать ход
        const fenBefore = game.fen();
        const move = game.move({ from: from, to: square, promotion: 'q' });
        if (move === null) {
            SoundEngine.illegal();
            clearClickHighlight();
            selectedSquare = null;
            lastTapAction = 'illegal';
            return;
        }

        // Ход успешен
        board.position(game.fen(), true);
        playMoveSound(move);
        waitingForOpponent = true;
        clearClickHighlight();
        selectedSquare = null;
        lastTapAction = 'move';
        processPlayerMove(move, fenBefore);
        return;
    }

    // ═══ Первый тап — выбор фигуры ═══
    if (piece && isOwnPiece(piece)) {
        selectedSquare = square;
        highlightClickSquare(square);
        if (!waitingForOpponent) {
            highlightLegalMoves(square);
        }
        lastTapAction = 'select';}
}

// ============================================
// Drag & Drop
// ============================================

function onDragStart(source, piece, position, orientation) {
    // На мобильных: drag отключён,ходы через tap
    if (isTouchDevice) return false;

    if (!sessionActive) return false;
    if (game.game_over()) return false;

    // ИСПРАВЛЕНИЕ: если есть выделенная клетка — сбрасываем её,
    // но РАЗРЕШАЕМ drag (не блокируем перетаскивание)
    if (selectedSquare) {
        clearClickHighlight();
        selectedSquare = null;
    }

    // Проверка, что двигаем свою фигуру
    const pieceColor = piece[0];
    if ((playerColor === 'white' && pieceColor === 'b') ||
        (playerColor === 'black' && pieceColor === 'w')) {
        return false;
    }

    return true;
}

//============================================
// Игровой цикл
// ============================================

async function makeFirstWhiteMove() {
    console.log('[FLOW] makeFirstWhiteMove вызван');
    try {
        const response = await fetch(`${API_BASE}/get-move`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen: game.fen(), rating: userRating })
        });
        const data = await response.json();
        console.log('[FLOW]Ответ get-move:', JSON.stringify(data));

        if (data.move) {
            const result = game.move(data.move);
            if (result) {
                board.position(game.fen(), true);
                // ★ КЛЮЧЕВОЙ ВЫЗОВ — первый ход белых
                console.log('[FLOW] Записываем первый ход белых:', result.san, '| color:', result.color);
                appendMoveToNotation(result, 'opponent', false);
            } else {
                console.error('[FLOW] game.move вернул null для:', data.move);
            }
        } else {
            console.warn('[FLOW] Сервер не вернул move');
        }} catch (e) {
        console.error('[FLOW] makeFirstWhiteMove error:', e);
    }
    waitingForOpponent = false;
}

function startGame() {
    selectedSquare = null;
    lastTapSquare = null;
    lastTapAction = null;
    clearClickHighlight();

    if (!board) { alert('Доскаещё не загрузилась!'); return; }

    game.reset();
    sessionStats = createEmptyStats();
    sessionStats.openingDifficulty = userRating;
    sessionActive = true;
    pendingEndSession = false;
    movesOutOfBook = 0;
    notationHalfMoves = 0;
    premoveData = null;
    clearPremoveHighlight();

    playerColor = $('#playerColor').val();
    waitingForOpponent = false;
    board.orientation(playerColor);
    board.position('start', false);

    if (playerColor === 'black') {
        waitingForOpponent = true;
        setTimeout(makeFirstWhiteMove, 300);
    }

    // Очищаем UI
    $('#move-history').empty();
    $('#opening-badge').text('Начальная позиция');
    $('#kraken-message').text('Кракен наблюдает за вашими ходами...');
    updateComboBar(0);
    resetLiveStats();

    if (typeof VoyageEngine !== 'undefined') {
        VoyageEngine.init(15);
    }

    updateStatus('Тренировка дебюта началась!');
    SoundEngine.gameStart();
}


function showLichessAnalysisButton(pgn) {
  const btn = document.getElementById('lichess-analysis-btn');
  if (!btn) return;

  // Используем lichess import API через форму
  btn.href = '#';
  btn.onclick = function(e) {
    e.preventDefault();
    
    // Создаём скрытую форму для POST-запроса
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = 'https://lichess.org/import';
    form.target = '_blank';
    
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'pgn';
    input.value = pgn;
    
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();document.body.removeChild(form);
  };
  
  btn.classList.add('visible');
}







// ============================================
// Инициализация
// ============================================

$(document).ready(async function () {
    board = Chessboard('board', {
        draggable: true,
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

    // Ресайз при повороте экрана
    $(window).on('resize', function () {
        if (board) board.resize();
    });

    // ═══ ОБРАБОТЧИКИ ТАПОВ ═══
    const TAP_SELECTOR = '.square-55d63, .piece-417db, .legal-dot, .legal-capture';

    if (isTouchDevice) {
        $('#board').on('touchstart', TAP_SELECTOR, function (e) {
            touchMoved = false;
            const touch = e.originalEvent.touches[0];
            touchStartX = touch.clientX;
            touchStartY = touch.clientY;
        });

        $('#board').on('touchmove', function (e) {
            if (!touchMoved) {
                const touch = e.originalEvent.touches[0];
                const dx = Math.abs(touch.clientX - touchStartX);
                const dy = Math.abs(touch.clientY - touchStartY);
                if (dx > TOUCH_MOVE_THRESHOLD || dy > TOUCH_MOVE_THRESHOLD) {
                    touchMoved = true;
                }
            }
        });

        $('#board').on('touchend', TAP_SELECTOR, function (e) {
            if (touchMoved) {
                touchMoved = false;
                return;
            }
            touchMoved = false;
            e.preventDefault();
            handleTap(this);
        });
    } else {
        // Десктоп: mousedown для мгновенного отклика
        $('#board').on('mousedown', TAP_SELECTOR, function (e) {
            if (e.which !== 1) return;
            handleTap(this);
        });
    }

    function handleTap(element) {
        const now = Date.now();

        let $square = $(element).closest('.square-55d63');
        let square = $square.attr('data-square');
        if (!square) {
            const match = ($square.attr('class') || '').match(/square-([a-h][1-8])/);
            if (match) square = match[1];
        }
        if (!square) return;

        // Дедупликация: блокируем дубль, кроме случая когда предыдущий тап снял выделение
        if (square === lastTapSquare && now - lastTapTime < TAP_DEDUP_MS) {
            if (lastTapAction !== 'deselect') return;
        }

        lastTapSquare = square;
        lastTapTime = now;
        onSquareClick(square);
    }

    // Разблокировка звука
    $(document).one('click touchstart', function () {
        SoundEngine.unlock();
    });

    initEngines();
    await loadRatingFromServer();

    // Кнопка сброса рейтинга
    $('#applyRating').on('click', async function () {
        const newRating = parseInt($('#startRating').val());
        const ALLOWED = [1000, 1400, 1800, 2200];

        if (isNaN(newRating) || !ALLOWED.includes(newRating)) {
            updateStatus('⚠️ Недопустимый рейтинг. Выберите из 1000, 1400, 1800, 2200.');
            return;
        }

        if (newRating === userRating && gamesPlayed === 0) {
            updateStatus(`✅ Рейтинг уже ${newRating}`);
            return;
        }

        try {
            const resp = await fetch(`${API_BASE}/api/rating/${userId}/reset`, {
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
            updateStatus(`✅ Рейтинг сброшен на ${userRating}. Удачи!`);
        } catch (e) {
            console.error('Ошибка сброса рейтинга:', e);
            updateStatus('❌ Не удалось применить рейтинг');
        }
    });

    console.log('🦑 Kraken Opening Trainer v3.8loaded');
});


// ============================================
// Kraken — тренажёр дебютов v3.7
// Серверный рейтинг + корректный расчёт CPL
// ============================================

const API_BASE = window.location.hostname === 'localhost'
    ? ''
    : 'https://kraken-qslu.onrender.com';var board = null;
var game = new Chess();
var playerColor = 'white';
var userRating = 1200;
var gamesPlayed = 0;
var recentDeltas = [];
var waitingForOpponent = false;
var premoveData = null; // { source, target } — запомненный предход
var selectedSquare = null; // клик-ход: выбранная клетка
var sessionActive = false;
var movesOutOfBook = 0;
var MAX_MOVES_OUT_OF_BOOK = 2;
var justDragged = false; // подавление клика после drag
var lastClickTime = 0; 
var dragStartTime = 0;
var touchStartSquare = null;
var touchStartX = 0;
var touchStartY = 0;
var touchStartTime = 0;
var blunderHistory = JSON.parse(localStorage.getItem('blunderHistory') || '{}');

// Идентификатор пользователя (для серверного рейтинга)
var userId = localStorage.getItem('userId');
if (!userId) {
    userId = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('userId', userId);
}

var sessionStats = createEmptyStats();
var pendingEndSession = false;

function createEmptyStats() {
    return {
        moves: [],
        pendingAnalysis: 0,
        categories: { theory: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, grossBlunder: 0, catastrophe: 0 },
        repeatedBlunder: false,
        hangsQueen: false,
        mateBlunder: false,
        openingDifficulty: null,

        // ── Комбо ──
        combo: 0,           // текущая серия хороших ходов подряд
        maxCombo: 0,         // лучшая серия за партию
        comboHistory: [],    // массив длин всех серий (для статистики)
        perfectStreak: false // вся партия без единой неточности
    };
}
// ============================================
// Категоризация хода (только для UI-подсказок)
// Сам рейтинг считается на сервере
// ============================================
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
    return category === 'mistake' || category === 'blunder' 
        || category === 'grossBlunder' || category === 'catastrophe';
}

// ============================================
// Stockfish — пул из двух воркеров
// ============================================
const EVAL_DEPTH = 15;
const NUM_ENGINES = 2;
const EVAL_TIMEOUT_MS = 6000;

var engines = [];
var engineWaitQueue = [];

function createEngine(id) {
    const e = {
        id, worker: null, ready: false, busy: false,
        resolve: null, turn: 'w', score: 0, isMate: false, timeout: null
    };
    try {

        e.worker = new Worker('sf-worker2.js');
        e.worker.onmessage = function (event) {
            const data = event.data;
            if (typeof data !== 'string') return;

            //★ ОТЛАДКА: логируем ВСЕ сообщения от движка
            console.log(`🔧 SF#${id}:`, data.substring(0, 120));

            if (data === 'uciok') {
                e.worker.postMessage('isready');
                return;
            }
            if (data === 'readyok') {
                if (!e.ready) {
                    e.ready = true;
                    console.log(`✅ Stockfish #${id} готов`);
                    processEngineQueue();
                }
                return;
            }

            if (e.resolve) {
                if (data.includes('score cp')) {
                    const m = data.match(/score cp (-?\d+)/);
                    if (m) { e.score = parseInt(m[1]); e.isMate = false; }
                } else if (data.includes('score mate')) {
                    const m = data.match(/score mate (-?\d+)/);
                    if (m) {
                        e.score = parseInt(m[1]) > 0 ? 10000 : -10000;
                        e.isMate = true;
                    }
                }if (data.startsWith('bestmove')) {
                    let finalScore = e.score;
                    if (e.turn === 'b') finalScore = -finalScore;
                    clearTimeout(e.timeout);
                    const resolve = e.resolve;
                    e.resolve = null;
                    e.busy = false;
                    resolve({ score: finalScore, isMate: e.isMate });
                processEngineQueue();
                }
            }
        };

        //★ ОТЛАДКА: ловим ошибки воркера
        e.worker.onerror = function (err) {
    console.error(`❌ SF#${id} worker error:`, err.message ||'unknown', err.filename || 'no file', err.lineno || 'no line');
    console.error(`❌ SF#${id} full error object:`, err);
    console.error(`❌ SF#${id} type:`, err.type);
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
    e.worker.postMessage('position fen ' + fen);
    e.worker.postMessage('go depth ' + depth);
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
    const evalAfterPlayer  = evalAfter.score  * sign;

    const clamp = (v) => Math.max(-2000, Math.min(2000, v));
    const lossForPlayer = clamp(evalBeforePlayer) - clamp(evalAfterPlayer);

    const isMateBlunder = evalAfter.isMate && (evalAfter.score * sign) < 0&& !(evalBefore.isMate && evalBefore.score * sign < 0);

    //═══ ДИАГНОСТИКА CPL ═══
    console.log(`⚙️ computeCPL:`);
    console.log(`   fenBefore turn: ${playerTurnBefore}`);
    console.log(`   evalBefore: raw=${evalBefore.score}, mate=${evalBefore.isMate} → forPlayer=${evalBeforePlayer}`);
    console.log(`   evalAfter:  raw=${evalAfter.score}, mate=${evalAfter.isMate} → forPlayer=${evalAfterPlayer}`);
    console.log(`   loss = ${clamp(evalBeforePlayer)} - ${clamp(evalAfterPlayer)} = ${lossForPlayer}`);
    console.log(`   CPL = ${Math.max(0, lossForPlayer)}, isMateBlunder = ${isMateBlunder}`);

    return {
        cpl: Math.max(0, lossForPlayer),
        isMateBlunder
    };
}

// ============================================
// Серверное взаимодействие
// ============================================
async function loadRatingFromServer() {
    try {
        const response = await fetch(API_BASE +'/api/rating/' + userId);
		if (!response.ok) throw new Error('HTTP ' + response.status);
		const r = await response.json();
        userRating = r.rating;
        gamesPlayed = r.games || 0;
        recentDeltas = r.recentDeltas || [];
        localStorage.setItem('chessRating', userRating);
        localStorage.setItem('gamesPlayed', gamesPlayed);
        updateRatingUI();
        console.log(`📥 Рейтинг с сервера: ${userRating} (партий: ${gamesPlayed})`);
    } catch (e) {
        console.warn('Не удалось загрузить рейтинг с сервера, использую локальный');
        const saved = localStorage.getItem('chessRating');
        if (saved) userRating = parseInt(saved);
        const savedGames = localStorage.getItem('gamesPlayed');
        if (savedGames) gamesPlayed = parseInt(savedGames);
        updateRatingUI();
    }
}

async function playMoveOnServer(fen, san, rating) {
    try {
        const response = await fetch(API_BASE +'/play-move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fen, san, rating })
        });
        if (!response.ok) return { check: { inBook: false, rank: 99 }, reply: null, gameOver: false };
        return await response.json();
    } catch (e) {
        console.warn('Ошибка /play-move:', e.message);
        return { check: { inBook: false, rank: 99 }, reply: null, gameOver: false };
    }
}

// ============================================
// Обработка хода игрока
// ============================================

function onDrop(source, target) {
    var dragDuration = Date.now() - dragStartTime;

    // Если это был быстрый тап (меньше 200мс) ИЛИ фигура осталась на той же клетке
    if (dragDuration < 200 || source === target) {
        // Это клик! Отменяем перетаскивание и вызываем выделение клетки
        setTimeout(function() {
            onSquareClick(source);
        }, 50);
        return 'snapback'; 
    }

    justDragged = true;
    setTimeout(function () { justDragged = false; }, 300);
    clearClickHighlight();
    selectedSquare = null;
    if (!sessionActive) return 'snapback';

    // Если ждём ответ соперника — сохраняем как предход
    if (waitingForOpponent) {
        premoveData = { source, target };
        highlightPremove(source, target);
        updateStatus('⏩ Предход: ' + source + '→' + target);
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
        board.position(game.fen(), false);
        return;
    }

    board.position(game.fen(), true);
    playMoveSound(move);
    waitingForOpponent = true;
    processPlayerMove(move, fenBefore);
}
async function processPlayerMove(move, fenBefore) {
    try {
        const fenAfter = game.fen();
        const moveNumber = Math.ceil(game.history().length / 2);
        const playerTurnBefore = fenBefore.split(' ')[1];

        // 🚀 Ответ соперника — быстро, параллельно с анализом
        const serverData = await playMoveOnServer(fenBefore, move.san, userRating);
        const bookInfo = serverData.check || { inBook: false, rank: 99, moveCount: 0 };
        const popularityRank = bookInfo.rank || 99;

        // 🔬 Анализ ТОЛЬКО хода пользователя — в фоне
        analyzeMoveInBackground(move, fenBefore, fenAfter, moveNumber, popularityRank, bookInfo, playerTurnBefore);

        if (serverData.gameOver) {
            updateStatus('Партия окончена');
            scheduleEndSession();
            return;
        }

        if (serverData.reply) {
            setTimeout(() => applyOpponentReply(serverData.reply), 120);
        } else {
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
        waitingForOpponent = false;
    }
}

function analyzeMoveInBackground(move, fenBefore, fenAfter, moveNumber, popularityRank, bookInfo, playerTurnBefore) {
    sessionStats.pendingAnalysis++;

    (async () => {
        try {
            const { cpl, isMateBlunder } = await computeCPL(fenBefore, fenAfter, playerTurnBefore);

            console.log(`⚙️ computeCPL:`);
            console.log(`   fenBefore turn: ${playerTurnBefore}`);
            console.log(`   CPL = ${cpl.toFixed(0)}, isMateBlunder = ${isMateBlunder}`);

            if (isMateBlunder) sessionStats.mateBlunder = true;

            const isBookMove = bookInfo.inBook&& bookInfo.rank <=3
                            && (bookInfo.moveCount ||0) >= 50
                            && cpl <= 50;

            //★ СНАЧАЛА объявляем category, ПОТОМ логируем
            const category = categorizeMove(cpl, isBookMove);

            console.log(`🔬АНАЛИЗ: ${move.san} | CPL=${cpl.toFixed(0)} | book=${isBookMove} | rank=${bookInfo.rank} | → ${category}`);

            // ── Комбо-система──
            const isComboWorthy = (category === 'theory' || category === 'good');
            // Добавить в script.js (используется в showComboFeedback, но не объявлена)

            if (isComboWorthy) {
                sessionStats.combo++;
                if (sessionStats.combo > sessionStats.maxCombo) {
                    sessionStats.maxCombo = sessionStats.combo;
                }
            } else {
                if (isComboBreaker(category)) {
                    if (sessionStats.combo >= 2) {
                        sessionStats.comboHistory.push(sessionStats.combo);
                    }
                    sessionStats.combo = 0;
                }
            }

            // Визуальная обратная связь
            showComboFeedback(sessionStats.combo, category, cpl);

            // ── Остальная логика ──
            if (cpl > 200&& blunderHistory[fenBefore]) sessionStats.repeatedBlunder = true;
            if (cpl > 200) {
                blunderHistory[fenBefore] = true;
                localStorage.setItem('blunderHistory', JSON.stringify(blunderHistory));
            }
            if (cpl >= 700 && move.piece === 'q') sessionStats.hangsQueen = true;

            sessionStats.moves.push({
                cpl: Math.round(cpl),
                moveNumber,
                popularityRank,
                fen: fenBefore,
                san: move.san,
                isBookMove,
                isUserMove: true,
                combo: sessionStats.combo
            });
            sessionStats.categories[category]++;

		// ── Обновляем нотацию ──
      appendMoveToHistory(move, moveNumber, category, true);
      updateLiveStats();
	
            console.log(`✅Ход записан: ${move.san} CPL=${Math.round(cpl)} cat=${category} | Всего ходов: ${sessionStats.moves.length}`);

        } catch (err) {
            console.error('Ошибка фонового анализа:', err);
        } finally {
            sessionStats.pendingAnalysis--;
            if (pendingEndSession && sessionStats.pendingAnalysis === 0) {
                pendingEndSession = false;
                endSession();
            }
        }
    })();
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
    if (cpl > 30&& !category.startsWith('theory')) {
        msg += `<small style="opacity:.7">−${Math.round(cpl)} сп</small>`;
    }

    // Комбо-бейдж
    if (combo >= 2) {
        const comboTier = getComboTier(combo);
        msg += ` <span class="combo-badge ${comboTier.cssClass}">${comboTier.icon}×${combo}</span>`;
    }

    // Сброс комбо
    if (combo === 0 && sessionStats.maxCombo >= 3&& isComboBreaker(category)) {
        msg += ` <span class="combo-break">💔Серия прервана</span>`;
    }

    updateStatus(msg);

    // ── Звуки (ОДИН РАЗ) ──
    if (category === 'catastrophe') {
        SoundEngine.catastrophe();
    } else if (category === 'blunder' || category === 'grossBlunder') {
        SoundEngine.blunder();
    }

    if (combo === 3|| combo === 5|| combo === 8 || combo === 12) {
        SoundEngine.comboUp(combo);
        pulseBoard(getComboTier(combo).color);
    }

    if (combo === 0&& sessionStats.maxCombo >= 3 && isComboBreaker(category)) {
        SoundEngine.comboBreak();
    }

    // Обновляем UI
    updateComboBar(combo);
    updateLiveStats();
}
function getComboTier(combo) {
    if (combo >= 12) return {
        icon: '🔥🔥🔥', label: 'НЕВЕРОЯТНО', cssClass: 'combo-legendary',
        color: '#ff4500', multiplier: 1.5 
    };
    if (combo >= 8) return { 
        icon: '🔥🔥', label: 'В УДАРЕ', cssClass: 'combo-epic', 
        color: '#ff8c00', multiplier: 1.35 
    };
    if (combo >= 5) return { 
        icon: '🔥', label: 'Отличная серия', cssClass: 'combo-great', 
        color: '#ffd700', multiplier: 1.2 
    };
    if (combo >= 3) return { 
        icon: '✨', label: 'Комбо', cssClass: 'combo-good', 
        color: '#90ee90', multiplier: 1.1 
    };
    return { 
        icon: '', label: '', cssClass: '',
        color: 'transparent', multiplier: 1.0 
    };
}

function pulseBoard(color) {
    const $board = $('#board');
    $board.css('box-shadow', `0 0 30px ${color}`);
    setTimeout(() => $board.css('box-shadow', 'none'), 800);
}


function applyOpponentReply(san) {
    const result = game.move(san);
    if (!result) {
        console.error('Нелегальный ход от сервера:', san);
        updateStatus('⚠️ Сервер вернул нелегальный ход');
        waitingForOpponent = false;
        return;
    }
    board.position(game.fen(), true);
	

	 if (result.san.includes('O-O')) {
        SoundEngine.moveCastle();
    } else if (result.captured) {
        SoundEngine.moveCapture();
    } else {
        SoundEngine.moveNormal();
    }
    if (result.san.includes('+') || result.san.includes('#')) {
        setTimeout(() => SoundEngine.moveCheck(), 100);
    }
// Записываем ход соперника в нотацию
  const oppMoveNumber = Math.ceil(game.history().length / 2);
  appendMoveToHistory(result, oppMoveNumber, 'opponent', false);
    waitingForOpponent = false;
    if (game.game_over()) {
        scheduleEndSession();
    } else {
        // Выполняем предход, если был
        setTimeout(tryExecutePremove, 50);
    }
}

// ============================================
// Ответ движка (когда книга закончилась)
// ============================================
async function makeEngineReply() {
    try {
        const fen = game.fen();
        const bestMove = await getEngineBestMove(fen, 8);
        if (bestMove) {
            const result = game.move({
                from: bestMove.slice(0, 2),
                to: bestMove.slice(2, 4),
                promotion: 'q'
            });
            if (result) {
                board.position(game.fen(), true);
                if (result.san.includes('O-O')) SoundEngine.moveCastle();
                else if (result.captured) SoundEngine.moveCapture();
                else SoundEngine.moveNormal();
                if (result.san.includes('+') || result.san.includes('#'))
                    setTimeout(() => SoundEngine.moveCheck(), 100);
            }
        }
        waitingForOpponent = false;
        if (game.game_over()) scheduleEndSession();
    } catch (e) {
        console.error('makeEngineReply:', e);
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

// ============================================
// Завершение сессии — ждёт окончания анализа всех ходов
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

    // Финализируем последнюю серию
    if (sessionStats.combo >= 2) {
        sessionStats.comboHistory.push(sessionStats.combo);
    }

    // Проверяем «идеальную партию»
    const allGood = userMoves.every(m => m.cpl <= 100);
    sessionStats.perfectStreak = allGood && userMoves.length >= 4;

    try {
        const resp = await fetch(API_BASE +'/api/rating/' + userId + '/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                moves: userMoves,
                openingDifficulty: sessionStats.openingDifficulty || userRating,
                recentDeltas,
                mateBlunder: sessionStats.mateBlunder,
                hangsQueen: sessionStats.hangsQueen,
                repeatedBlunder: sessionStats.repeatedBlunder,
                //── Новые поля ──
                maxCombo: sessionStats.maxCombo,
                comboHistory: sessionStats.comboHistory,
                perfectStreak: sessionStats.perfectStreak
            })
        });

        if (!resp.ok) throw new Error('HTTP ' + resp.status);
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
    }
}


// ============================================
// UI
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

    // Худший ход
    let worst = null;
    sessionStats.moves.forEach(m => { if (!worst || m.cpl > worst.cpl) worst = m; });

    //── Категории — компактная таблица ──
    const catRows = [
        ['📘','Теория',cats.theory,'#00e5ff'],
        ['✅','Хорошие',     cats.good,          '#39ff7a'],
        ['⚠️','Неточности',  cats.inaccuracy,    '#ffde59'],
        ['❌','Ошибки',      cats.mistake,        '#ffab40'],
        ['🔥','Зевки',       cats.blunder,        '#ff2e93'],
        ['💀','Грубые',      cats.grossBlunder,'#b24bf3'],
        ['☠️','Катастрофы',  cats.catastrophe,    '#ff4444']
    ];

    let catHtml = '';
    catRows.forEach(([icon, label, count, color]) => {
        if (count === 0) return; // скрываем нулевые
        catHtml += `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
                <span style="color:${color};font-size:0.82rem">${icon} ${label}</span>
                <span style="color:${color};font-family:Bungee,cursive;font-size:0.95rem">${count}</span>
            </div>`;
    });

    // ── Комбо (одна строка) ──
    let comboHtml = '';
    if (sessionStats.maxCombo >= 3) {
        const tier = getComboTier(sessionStats.maxCombo);
        comboHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:8px 12px;margin-top:12px;
                        background:rgba(255,222,89,0.08);border:1px solid rgba(255,222,89,0.25);
                        border-radius:10px;font-size:0.8rem">
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

    // ── Штрафы (одна строка каждый) ──
    let penaltyHtml = '';
    const penalties = [];
    if (sessionStats.repeatedBlunder) penalties.push('🔁 Повторный зевок');
    if (sessionStats.mateBlunder) penalties.push('😱 Пропущен мат');
    if (sessionStats.hangsQueen) penalties.push('👑 Зевок ферзя');
    if (penalties.length) {
        penaltyHtml = `<div style="margin-top:10px;font-size:0.78rem;color:#ff5c5c">
            ${penalties.join(' &nbsp;·&nbsp; ')}
        </div>`;
    }

    // ── Критический момент ──
    let critHtml = '';
    if (worst && worst.cpl > 200) {
        critHtml = `
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:8px 12px;margin-top:12px;
                        background:rgba(255,0,0,0.06);border:1px solid rgba(255,70,70,0.25);
                        border-radius:10px;font-size:0.8rem">
                <span>💀 Ход ${worst.moveNumber}:<b style="color:#fff">${worst.san}</b></span>
                <span style="color:#ff4444;font-family:Bungee,cursive">−${Math.round(worst.cpl)}</span>
            </div>`;
    }

    // ── Итог──
    const html = `
    <div>
        <!-- Заголовок -->
        <div style="text-align:center;margin-bottom:20px">
            <div style="font-family:Bungee,cursive;font-size:1.2rem;color:#d0b8ff;
                        letter-spacing:0.04em">Итоги партии</div>
            <div style="font-size:0.7rem;color:rgba(255,255,255,0.35);margin-top:4px">
                ${userMovesCount} ходов · партия #${gamesPlayed}
            </div>
        </div>

        <!-- Рейтинг — главный акцент -->
        <div style="text-align:center;padding:18px 0;margin-bottom:18px;
                    border-top:1px solid rgba(255,255,255,0.06);
                    border-bottom:1px solid rgba(255,255,255,0.06)">
            <div style="font-family:Bungee,cursive;font-size:2.4rem;color:${clr};
                        text-shadow:0 0 24px ${clr};line-height:1">
                ${sign}${ratingChange}
            </div>
            <div style="font-size:0.85rem;color:rgba(255,255,255,0.5);margin-top:8px">
                ${oldRating} → <b style="color:#fff">${userRating}</b>
            </div>
        </div>

        <!-- Категории -->
        <div style="margin-bottom:4px">
            ${catHtml}
        </div>

        ${comboHtml}
        ${penaltyHtml}
        ${critHtml}

        <!-- Кнопки -->
        <div style="display:flex;gap:10px;margin-top:22px">
            <button style="flex:1;padding:12px;font-family:Bungee,cursive;font-size:0.82rem;
                           border:none;border-radius:10px;cursor:pointer;color:#fff;
                           background:linear-gradient(135deg,#ff2e93,#b24bf3);
                           box-shadow:0 4px 16px rgba(255,46,147,0.35)"
                    onclick="closeModal(); startGame();">
                Ещё партия
            </button>
            <button style="flex:1;padding:12px;font-size:0.82rem;font-weight:700;
                           border:1px solid rgba(255,255,255,0.15);border-radius:10px;
                           cursor:pointer;background:transparent;color:rgba(255,255,255,0.6)"
                    onclick="closeModal();">
                Закрыть
            </button>
        </div>
    </div>`;

    showModal(html);
}
// ============================================
// Недостающие UI-функции
// ============================================

function updateStatus(msg) {
    var $status = $('#status');
    if ($status.length) {
        $status.html(msg);
    } else {
        console.log('STATUS:', msg);
    }
}

function updateRatingUI() {
    // Обновляем отображение рейтинга в карточке
    var $ratingValue = $('#rating-value');
    if ($ratingValue.length) {
        $ratingValue.text(userRating);
    }

    // НЕ трогаем #startRating — это выбор пользователя, не отображение

    var $games = $('#games-display');
    if ($games.length) {
        $games.text(gamesPlayed);
    }
}
async function makeFirstWhiteMove() {
    try {
        const response = await fetch(API_BASE +'/get-move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fen: game.fen(),
                rating: userRating
            })
        });
        const data = await response.json();
        if (data.move) {
            const result = game.move(data.move);
            if (result) {
                board.position(game.fen(), true);
            }
        }
    } catch (e) {
        console.error('makeFirstWhiteMove error:', e);
    }
    waitingForOpponent = false;
}


// ============================================
// Игровой цикл
// ============================================
function startGame() {
	selectedSquare = null;
    clearClickHighlight();
    if (!board) { alert('Доска ещё не загрузилась!'); return; }

    game.reset();
    sessionStats = createEmptyStats();
    sessionStats.openingDifficulty = userRating;
    sessionActive = true;
    pendingEndSession = false;
    movesOutOfBook = 0;

	premoveData = null;
    clearPremoveHighlight();
    playerColor = $('#playerColor').val();

    // ИСПРАВЛЕНО: НЕ перезаписываем рейтинг из поля ввода автоматически.
    // Поле customRating — только дляручного сброса/установки.
    // При нормальной игре рейтинг берётся с сервера.

    waitingForOpponent = false;
    board.orientation(playerColor);
    board.position('start', false);

    if (playerColor === 'black') {
        waitingForOpponent = true;
        setTimeout(makeFirstWhiteMove, 300);
    }
	// Очищаем UI правой панели
  $('#move-history').empty();
  $('#opening-badge').text('Начальная позиция');
  $('#kraken-message').text('🦑 Кракен наблюдает за вашими ходами...');
  updateComboBar(0);
  resetLiveStats();
    updateStatus('Тренировка дебюта началась!');
	SoundEngine.gameStart();
}

function onDragStart(source, piece) {
    dragStartTime = Date.now();
    // 🚀 ГЛАВНЫЙ СЕКРЕТ: Отключаем перетаскивание на мобильных экранах!
    // Это разблокирует идеальные нативные клики (тапы).
    if (window.matchMedia('(max-width: 900px)').matches || 'ontouchstart' in window) {
        return false;
    }

    if (!sessionActive || waitingForOpponent) return false;
    if (game.game_over()) return false;
    if (playerColor === 'white' && piece[0] === 'b') return false;
    if (playerColor === 'black' && piece[0] === 'w') return false;
    if (playerColor === 'white' && game.turn() === 'b') return false;
    if (playerColor === 'black' && game.turn() === 'w') return false;
    return true;
}
function onSnapEnd() { board.position(game.fen(), false); }


function showModal(contentHtml) {
    $('#session-modal').remove();

    const overlay = [
        'position:fixed',
        'top:0','left:0',
        'width:100%','height:100%',
        'background:rgba(5,2,20,0.92)',
        'backdrop-filter:blur(8px)',
        'z-index:9999',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'opacity:0',
        'transition:opacity 0.25s ease'].join(';');

    const card = [
        'background:#120a30',
        'border:1px solid rgba(178,75,243,0.3)',
        'border-radius:16px',
        'padding:28px 24px',
        'max-width:380px',
        'width:92%',
        'color:#fff',
        'font-family:Space Grotesk,sans-serif',
        'box-shadow:0 16px 60px rgba(0,0,0,0.7)',
        'max-height:88vh',
        'overflow-y:auto'
    ].join(';');

    $('body').append(
        `<div id="session-modal" style="${overlay}">` +
        `<div style="${card}">${contentHtml}</div></div>`
    );
    document.getElementById('session-modal').offsetHeight;
    $('#session-modal').css('opacity','1');
}

function closeModal() {
    $('#session-modal').css('opacity','0');
    setTimeout(() => $('#session-modal').remove(), 250);
}


// ============================================
// UI-функции правой панели
// ============================================

function appendMoveToHistory(move, moveNumber, category, isUserMove) {
  var $history = $('#move-history');
  if (!$history.length) return;

  var cssClass = isUserMove ? category : 'opponent';
  var san = move.san || move;

  // Белый ход — новая строка с номером
  if (move.color === 'w' || (!move.color && game.history().length % 2 === 1)) {
    var $pair = $('<div class="move-pair"></div>');
    $pair.append('<span class="move-number">' + moveNumber + '.</span>');
    $pair.append('<span class="move-san ' + cssClass + '">' + san + '</span>');
    $pair.attr('data-move-num', moveNumber);
    $history.append($pair);
  } else {
    // Чёрный ход — добавляем в последнюю строку
    var $lastPair = $history.find('.move-pair').last();
    if ($lastPair.length) {
      $lastPair.append('<span class="move-san ' + cssClass + '">' + san + '</span>');
    } else {
      var $pair = $('<div class="move-pair"></div>');
      $pair.append('<span class="move-number">' + moveNumber + '.</span>');
      $pair.append('<span class="move-san opponent">...</span>');
      $pair.append('<span class="move-san ' + cssClass + '">' + san + '</span>');
      $history.append($pair);
    }
  }

  // Автоскролл
  $history.scrollTop($history[0].scrollHeight);
}

function updateComboBar(combo) {
  var $fill = $('#combo-fill');
  var $mult = $('#combo-multiplier');
  if (!$fill.length) return;

  // Прогресс: 0→0%, 3→25%, 5→42%, 8→67%, 12→100%
  var pct = Math.min(100, (combo / 12) * 100);
  $fill.css('width', pct + '%');

  var tier = getComboTier(combo);
  if (combo >= 3) {
    $mult.text('x' + tier.multiplier.toFixed(1));
    $mult.css({ color: tier.color, textShadow: '0 0 12px ' + tier.color });
  } else {
    $mult.text('x1');
    $mult.css({ color: 'rgba(255,255,255,0.5)', textShadow: 'none' });
  }
}

function updateLiveStats() {
  var userMoves = sessionStats.moves.filter(function(m) { return m.isUserMove; });
  var moveCount = userMoves.length;

  $('#stat-moves').text(moveCount);
  $('#stat-best-combo').text(sessionStats.maxCombo);

  // Точность: %ходов с CPL ≤ 50
  if (moveCount > 0) {
    var goodMoves = userMoves.filter(function(m) { return m.cpl <= 50; }).length;
    var accuracy = Math.round((goodMoves / moveCount) * 100);
    $('#stat-accuracy').text(accuracy + '%');

    // Цвет точности
    var accColor = accuracy >= 90 ? '#39ff7a': accuracy >= 70 ? '#ffde59'
                 : accuracy >= 50 ? '#ffab40'
                 : '#ff5c5c';
    $('#stat-accuracy').css('color', accColor);
  } else {
    $('#stat-accuracy').text('—').css('color', '#fff');
  }

  // Зевки: CPL > 200
  var blunders = userMoves.filter(function(m) { return m.cpl > 200; }).length;
  $('#stat-blunders').text(blunders);
  $('#stat-blunders').css('color', blunders > 0 ? '#ff2e93' : '#fff');
}

function resetLiveStats() {
  $('#stat-moves').text('0');
  $('#stat-accuracy').text('—').css('color', '#fff');
  $('#stat-best-combo').text('0');
  $('#stat-blunders').text('0').css('color', '#fff');
}

function isOwnPiece(piece) {
    if (playerColor === 'white' && piece.color === 'w') return true;
    if (playerColor === 'black' && piece.color === 'b') return true;
    return false;
}

function getSquareFromElement(el) {
    const classes = el.className.split(/\s+/);
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
    moves.forEach(function (m) {
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


// ============================================
// Логика клика по клетке (Tap-to-move)
// ============================================

function onSquareClick(square) {
 // Пропускаем если это не тап (а например, начало drag)
    if ('ontouchstart' in window && justDragged) return;
    var now = Date.now();
    if (now - lastClickTime < 100) return;  // ← защита от двойного вызова
    lastClickTime = now;

    if (justDragged) return;
    if (!sessionActive) return;

    const piece = game.get(square);

    // Если уже выбрана клетка — пробуем сделать ход
    if (selectedSquare) {
        const from = selectedSquare;
        clearClickHighlight();
        selectedSquare = null;

        // Клик на ту же клетку — просто отмена выделения
        if (from === square) return;

        // Клик на другую свою фигуру — переключаем выбор
        if (piece && isOwnPiece(piece)) {
            selectedSquare = square;
            highlightClickSquare(square);
            highlightLegalMoves(square);
            return;
        }

        // Пробуем предход
        if (waitingForOpponent) {
            premoveData = { source: from, target: square };
            highlightPremove(from, square);
            updateStatus('⏩ Предход: ' + from + '→' + square);
            return;
        }

        // Пробуем сделать ход
        const fenBefore = game.fen();
        const move = game.move({ from: from, to: square, promotion: 'q' });
        if (move === null) {
            SoundEngine.illegal();
            board.position(game.fen(), false);
            return;
        }

        board.position(game.fen(), true);
        playMoveSound(move);
        waitingForOpponent = true;
        processPlayerMove(move, fenBefore);
        return;
    }

    // Первый клик — выбираем свою фигуру
    if (piece && isOwnPiece(piece) && !waitingForOpponent) {
        selectedSquare = square;
        highlightClickSquare(square);
        highlightLegalMoves(square);
    }
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
        appearSpeed: 0,
        moveSpeed: 120,
        snapSpeed: 40,
        snapbackSpeed: 150
    });

 // Автоматическое изменение размера доски при повороте телефона
    $(window).on('resize', function() {
        if (board) {
            board.resize();
        }
    });

// ═══ ИДЕАЛЬНЫЙ TAP-TO-MOVE (Touch + Mouse) ═══
    $('#board').on('touchstart mousedown', '.square-55d63, .piece-417db', function (e) {
        // Игнорируем правый клик мыши
        if (e.type === 'mousedown' && e.which !== 1) return;
        if (justDragged) return;

        // НАХОДИМ КЛЕТКУ: даже если кликнули по картинке фигуры, ищем её родительский div
        var $square = $(this).closest('.square-55d63');
        if (!$square.length) return;

        // Извлекаем ID клетки (например, 'e4')
        var square = $square.attr('data-square');
        
        // Резервный вариант поиска клетки, если data-square недоступен
        if (!square) {
            var match = $square.attr('class').match(/square-([a-h][1-8])/);
            if (match) square = match[1];
        }

        if (square) {
            // Если это мобильный тап, предотвращаем "фантомный" клик мыши (ghost click)
            if (e.type === 'touchstart') {
                e.preventDefault(); 
            }
            onSquareClick(square);
        }
    });
    // ═══ КОНЕЦ ═══

$(document).one('click touchstart', function () {
    SoundEngine.unlock();
});
    initEngines();

    // Загружаем рейтинг с сервера (с фоллбеком на localStorage)
    await loadRatingFromServer();
$('#applyRating').on('click', async function () {
        const newRating = parseInt($('#startRating').val());
        const ALLOWED = [1000, 1400, 1800, 2200];

        if (!ALLOWED.includes(newRating)) {
            updateStatus('⚠️ Недопустимый рейтинг');
            return;
        }

        // Если рейтинг уже такой — не дёргаем сервер
        if (newRating === userRating && gamesPlayed === 0) {
            updateStatus(`✅ Рейтинг уже ${newRating}`);
            return;
        }

        try {
            const resp = await fetch(API_BASE +'/api/rating/' + userId + '/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating: newRating })
            });

            if (!resp.ok) {
                const err = await resp.json();
                updateStatus('❌ Ошибка: ' + (err.error || resp.status));
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
            console.log(`🔄 Рейтинг сброшен: ${userRating}, партий: ${gamesPlayed}`);

        } catch (e) {
            console.error('Ошибка сброса рейтинга:', e);
            updateStatus('❌ Не удалось применить рейтинг');
        }
    });
    

    console.log('🦑 Kraken Opening Trainer v3.7 loaded');
    console.log('   userId:', userId);
});

//============================================
// TreasureHunt — Поиск сокровищ v2.1
// Перекалибровка: чаще видим, ценность сохранена
//============================================

const TreasureHunt = (function() {
    'use strict';

    // ==========================================
    // КОНСТАНТЫ — ПЕРЕКАЛИБРОВАННЫЕ
    // ==========================================

    // Глубина сканирования: облегчённая
    const SCAN_DEPTH_QUICK  = 10;
    const SCAN_DEPTH_FULL   = 16;
    const SCAN_DEPTH_VERIFY = 20;

    // Расширенное окно ходов
    const MIN_MOVE_NUMBER = 3;
    const MAX_MOVE_NUMBER = 30;

    // Сниженный кулдаун
    const BASE_COOLDOWN        = 1;
    const COOLDOWN_AFTER_FIND  = 1;
    const COOLDOWN_BORING      = 2;

    // Расширенные пороги потери оценки (cp)
    const EVAL_LOSS_GEM   = 25;
    const EVAL_LOSS_GOLD  = 45;
    const EVAL_LOSS_PEARL = 70;
    const EVAL_GAIN_BONUS = -5;

    // Расширенные пороги популярности (%)
    const POP_ULTRA_RARE = 1.0;
    const POP_RARE       = 5.0;
    const POP_UNCOMMON   = 12.0;

    // Сниженный минимум партий
    const MIN_GAMES_GEM   = 20;
    const MIN_GAMES_GOLD  = 12;
    const MIN_GAMES_PEARL = 5;

    // Сниженные пороги винрейта
    const WINRATE_GEM_MIN   = 50;
    const WINRATE_GOLD_MIN  = 48;
    const WINRATE_PEARL_MIN = 45;

    // Лимиты
    const MAX_TREASURES_PER_POSITION = 3;
    const ENGINE_CACHE_LIMIT = 500;
    const SCAN_HISTORY_LIMIT = 50;
    const MIN_COMPLEXITY = 20;

    // ==========================================
    // ТИПЫ СОКРОВИЩ
    // ==========================================

    const TREASURE_TYPES = {
        HIDDEN_GEM: {
            icon: '💎', label: 'Скрытый бриллиант',
            tier: 3, points: 50,
            desc: 'Ультраредкий ход, одобренный движком'
        },
        BURIED_GOLD: {
            icon: '🪙', label: 'Золото глубин',
            tier: 2, points: 30,
            desc: 'Редкий сильный ход, который мало кто играет'
        },
        PEARL: {
            icon: '🦪', label: 'Жемчужина',
            tier: 1, points: 15,
            desc: 'Необычный, но вполне достойный ход'
        }
    };
// ==========================================
    // СОСТОЯНИЕ
    // ==========================================

    let state = {};
    let DOM = {};

    function createFreshState() {
        return {
            active: false,
            currentTreasures: [],
            foundTreasures: [],
            missedTreasures: [],
            totalScanned: 0,
            sessionPoints: 0,
            streak: 0,
            maxStreak: 0,
            lastScanFen: null,
            movesSinceLastScan: 0,
            currentMoveNumber: 0,
            scanInProgress: false,
            consecutiveEmptyScans: 0,
            dynamicCooldown: BASE_COOLDOWN,
            positionComplexity: 0,
            scanHistory: [],
            engineCache: new Map()
        };
    }

    // ==========================================
    // ИНИЦИАЛИЗАЦИЯ
    // ==========================================

    function init() {
        state = createFreshState();
        state.active = true;
        cacheDOMElements();
        updateTreasureUI();
        console.log('🏴‍☠️ TreasureHunt v2.1 initialized (rebalanced)');
    }

    function cacheDOMElements() {
        DOM.panel   = document.getElementById('treasure-panel');
        DOM.counter = document.getElementById('treasure-counter');
        DOM.points  = document.getElementById('treasure-points');
        DOM.streak  = document.getElementById('treasure-streak');
        DOM.hint    = document.getElementById('treasure-hint');
        DOM.overlay = document.getElementById('treasure-overlay');
    }
// ==========================================
    // WILSON SCORE — консервативная оценка WR
    // ==========================================

    function wilsonLowerBound(p, n, z) {
        z = z || 1.645;
        if (n === 0) return 0;
        const d = 1 + z * z / n;
        const centre = p + z * z / (2 * n);
        const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
        return (centre - spread) / d;
    }

    // ==========================================
    // АДАПТИВНЫЙ КУЛДАУН
    // ==========================================

    function updateDynamicCooldown() {
        const lastFound = state.foundTreasures[state.foundTreasures.length - 1];
        const recentFind = lastFound && (Date.now() - lastFound.timestamp < 60000);

        if (state.consecutiveEmptyScans >= 5) {
            // Было >= 3 — даём больше шансов перед замедлением
            state.dynamicCooldown = COOLDOWN_BORING;
        } else if (recentFind) {
            state.dynamicCooldown = COOLDOWN_AFTER_FIND;
        } else {
            state.dynamicCooldown = BASE_COOLDOWN;
        }
    }

    // ==========================================
    // ОЦЕНКА СЛОЖНОСТИ ПОЗИЦИИ
    // ==========================================

    function estimateComplexity(fen) {
        const board = fen.split(/\s+/)[0];

        let pieces = 0, minors = 0, queens = 0;

        for (const ch of board) {
            const low = ch.toLowerCase();
            if ('pnbrqk'.includes(low)) pieces++;
            if (low === 'n' || low === 'b') minors++;
            if (low === 'q') queens++;
        }

        let score = 0;
        score += Math.min(pieces * 3, 60);
        score += queens * 15;
        score += minors * 5;

        if (pieces >= 20 && pieces <= 28) score += 20;

        // Бонус за раннюю стадию — больше фигур на доске = интереснее
        if (pieces >= 28) score += 10;

        state.positionComplexity = Math.min(score, 100);
        return state.positionComplexity;
    }

// ==========================================
// ПРЕДФИЛЬТР КАНДИДАТОВ
// Отсеивает заведомо неподходящие ходы
// до тяжёлой проверки движком
// ==========================================

function prefilterCandidates(moves) {
    if (!moves || moves.length === 0) return [];

    return moves.filter(move => {
        const pop = parseFloat(move.popularity);
        const games = parseInt(move.games) || 0;
        const winRate = parseFloat(move.winRate);

        // 1. Слишком популярные ходы — не сокровище
        //    Если ход играют > 12% игроков, он не «скрытый»
        if (pop >= POP_UNCOMMON) {
            return false;
        }

        // 2. Слишком мало партий — нет статистической значимости
        //    Даже для жемчужины нужно хотя бы MIN_GAMES_PEARL партий
        if (games < MIN_GAMES_PEARL) {
            return false;
        }

        // 3. Слишком низкий винрейт — ход скорее всего плохой
        //    Порог ниже, чем при финальной классификации,
        //    чтобы не отсечь пограничные случаи до проверки движком
        if (winRate < WINRATE_PEARL_MIN - 5) {
            return false;
        }

        // 4. Ход проходит предфильтр — отправляем на проверку движком
        return true;
    });
}


    // ==========================================
    // КЭШ ДВИЖКА
    // ==========================================

    async function getEngineEvalCached(fen, depth) {
        const key = fen + '|' + depth;

        if (state.engineCache.has(key)) {
            return state.engineCache.get(key);
        }

        for (let d = depth - 1; d >= SCAN_DEPTH_QUICK; d--) {
            const lowerKey = fen + '|' + d;
            if (state.engineCache.has(lowerKey)) {
                const cached = state.engineCache.get(lowerKey);
                if (cached.isMate) {
                    state.engineCache.set(key, cached);
                    return cached;
                }
            }
        }

        const result = await getEngineEvaluation(fen, depth);
        state.engineCache.set(key, result);

        if (state.engineCache.size > ENGINE_CACHE_LIMIT) {
            const oldest = state.engineCache.keys().next().value;
            state.engineCache.delete(oldest);
        }

        return result;
    }
// ==========================================
    // ГЛАВНЫЙ МЕТОД — СКАНИРОВАНИЕ ПОЗИЦИИ
    // ==========================================

    async function scanPosition(fen, playerColor) {
        TreasureDiag.log('SCAN', 'scanPosition called', {
            fen: fen.substring(0, 40) + '...',
            playerColor: playerColor
        });

        // --- Быстрые проверки ---
        if (!state.active) {
            TreasureDiag.log('GATE', '❌ Module not active');
            return [];
        }
        if (state.scanInProgress) {
            TreasureDiag.log('GATE', '❌ Scan already in progress');
            return [];
        }
        if (fen === state.lastScanFen) {
            TreasureDiag.log('GATE', '⏭️ Same FEN as last scan');
            return state.currentTreasures;
        }

        const fenParts = fen.split(/\s+/);
        const fullmove = parseInt(fenParts[5]) || 1;
        state.currentMoveNumber = fullmove;

        // Проверка хода игрока
        const sideToMove = fenParts[1];
        const isPlayerTurn =
            (playerColor === 'white' && sideToMove === 'w') ||
            (playerColor === 'black' && sideToMove === 'b');
        if (!isPlayerTurn) {
            TreasureDiag.log('GATE', '❌ Not player turn', {
                sideToMove, playerColor
            });
            return [];
        }

        // Окно ходов
        if (fullmove < MIN_MOVE_NUMBER || fullmove > MAX_MOVE_NUMBER) {
            TreasureDiag.log('GATE', '❌ Move out of range', {
                fullmove, min: MIN_MOVE_NUMBER, max: MAX_MOVE_NUMBER
            });
            return [];
        }

        // Кулдаун
        updateDynamicCooldown();
        state.movesSinceLastScan++;
        if (state.movesSinceLastScan < state.dynamicCooldown) {
            TreasureDiag.log('GATE', '❌ Cooldown active', {
                movesSince: state.movesSinceLastScan,
                cooldown: state.dynamicCooldown
            });
            return [];
        }

        // Сложность
        const complexity = estimateComplexity(fen);
        if (complexity < MIN_COMPLEXITY) {
            TreasureDiag.log('GATE', '❌ Position too simple', {
                complexity, threshold: MIN_COMPLEXITY
            });
            return [];
        }

        TreasureDiag.log('SCAN', '✅ All gates passed, starting scan', {
            move: fullmove, complexity: complexity
        });

        state.movesSinceLastScan = 0;
        state.lastScanFen = fen;
        state.scanInProgress = true;

        try {
            // Шаг 1: Сервер
            TreasureDiag.log('SERVER', 'Fetching book data...');
            const bookData = await fetchBookData(fen);

            if (!bookData) {
                TreasureDiag.log('SERVER', '❌ Server returned null/error');
                state.consecutiveEmptyScans++;
                state.currentTreasures = [];
                return [];
            }

            if (!bookData.treasures || bookData.treasures.length === 0) {
                TreasureDiag.log('SERVER', '❌ No treasures in response', {
                    keys: Object.keys(bookData),
                    raw: JSON.stringify(bookData).substring(0, 200)
                });
                state.consecutiveEmptyScans++;
                state.currentTreasures = [];
                return [];
            }

            TreasureDiag.log('SERVER', '✅ Got candidates from server', {
                count: bookData.treasures.length,
                moves: bookData.treasures.map(t => t.san + ' (' + t.popularity + '%)')
            });

            // Шаг 2: Предфильтр
            const candidates = prefilterCandidates(bookData.treasures);
            TreasureDiag.log('PREFILTER', 'Prefilter result', {
                before: bookData.treasures.length,
                after: candidates.length,
                rejected: bookData.treasures
                    .filter(m => !candidates.includes(m))
                    .map(m => m.san + ' (pop=' + m.popularity +
                         '%, games=' + m.games + ', wr=' + m.winRate + '%)')
            });

            if (candidates.length === 0) {
                state.consecutiveEmptyScans++;
                state.currentTreasures = [];
                return [];
            }

            // Шаг 3: Движок
            TreasureDiag.log('ENGINE', 'Starting engine evaluation', {
                candidates: candidates.map(c => c.san)
            });

            const treasures = await evaluateRareMoves(fen, candidates, playerColor);

            state.currentTreasures = treasures;
            state.totalScanned++;

            if (treasures.length > 0) {
                state.consecutiveEmptyScans = 0;
                TreasureDiag.log('RESULT', '🎉 TREASURES FOUND!', {
                    count: treasures.length,
                    treasures: treasures.map(t =>
                        t.icon + ' ' + t.san + ' (loss=' + t.evalLoss +
                        'cp, pop=' + t.popularity + '%)')
                });
                showTreasureHint(treasures);
                logScanResult(fen, treasures);
            } else {
                state.consecutiveEmptyScans++;
                TreasureDiag.log('ENGINE', '❌ All candidates rejected by engine');
            }

            return treasures;

        } catch (e) {
            TreasureDiag.log('ERROR', '💥 Scan crashed: ' + e.message, {
                stack: e.stack
            });
            return [];
        } finally {
            state.scanInProgress = false;
        }
    }

// ==========================================
    // ЗАПРОС К СЕРВЕРУ
    // ==========================================

    async function fetchBookData(fen) {
        try {
            const url = API_BASE + '/api/treasure/scan';
            TreasureDiag.log('SERVER', 'POST ' + url, {
                fen: fen.substring(0, 40),
                rating: typeof userRating !== 'undefined' ? userRating : 'UNDEFINED'
            });

            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fen, rating: userRating })
            });

            TreasureDiag.log('SERVER', 'Response status: ' + resp.status);

            if (!resp.ok) {
                TreasureDiag.log('SERVER', '❌ HTTP error ' + resp.status);
                return null;
            }

            const data = await resp.json();
            TreasureDiag.log('SERVER', 'Response body', {
                keys: Object.keys(data),
                treasureCount: data.treasures ? data.treasures.length : 0,
                sample: JSON.stringify(data).substring(0, 300)
            });

            return data;
        } catch (e) {
            TreasureDiag.log('ERROR', '💥 Fetch failed: ' + e.message);
            return null;
        }
    }

// ==========================================
    // ОЦЕНКА ДВИЖКОМ — ТРЁХСТУПЕНЧАТАЯ
    // ==========================================

    async function evaluateRareMoves(fen, candidates, playerColor) {
        const treasures = [];
        const sign = playerColor === 'white' ? 1 : -1;

        const baseEval  = await getEngineEvalCached(fen, SCAN_DEPTH_FULL);
        const baseScore = baseEval.score * sign;

        TreasureDiag.log('ENGINE', 'Base position eval', {
            rawScore: baseEval.score,
            adjusted: baseScore,
            isMate: baseEval.isMate || false
        });

        for (const candidate of candidates) {
            const testChess  = new Chess(fen);
            const moveResult = testChess.move(candidate.san);
            if (!moveResult) {
                TreasureDiag.log('ENGINE', '❌ Invalid move: ' + candidate.san);
                continue;
            }

            const afterFen = testChess.fen();

            // Ступень 1
            const quickEval  = await getEngineEvalCached(afterFen, SCAN_DEPTH_QUICK);
            const quickScore = -(quickEval.score * sign);
            const quickLoss  = baseScore - quickScore;

            if (quickLoss > EVAL_LOSS_PEARL + 30) {
                TreasureDiag.log('ENGINE', '❌ Quick reject: ' + candidate.san, {
                    quickLoss: Math.round(quickLoss),
                    threshold: EVAL_LOSS_PEARL + 30
                });
                continue;
            }

            // Ступень 2
            const fullEval  = await getEngineEvalCached(afterFen, SCAN_DEPTH_FULL);
            const fullScore = -(fullEval.score * sign);
            const evalLoss  = baseScore - fullScore;

            if (evalLoss > EVAL_LOSS_PEARL) {
                TreasureDiag.log('ENGINE', '❌ Full reject: ' + candidate.san, {
                    evalLoss: Math.round(evalLoss),
                    threshold: EVAL_LOSS_PEARL
                });
                continue;
            }

            // Классификация
            const pop   = parseFloat(candidate.popularity);
            const games = parseInt(candidate.games) || 0;
            const rawWR = parseFloat(candidate.winRate);
            const adjWR = wilsonLowerBound(rawWR / 100, games) * 100;

            let type = classifyTreasure({
                popularity: pop,
                evalLoss:   evalLoss,
                games:      games,
                adjustedWR: adjWR
            });

            TreasureDiag.log('CLASSIFY', candidate.san + ' classification', {
                pop, evalLoss: Math.round(evalLoss), games,
                rawWR, adjWR: Math.round(adjWR * 10) / 10,
                result: type || 'REJECTED'
            });

            if (!type) continue;

            // Ступень 3
            if (type === 'HIDDEN_GEM') {
                const verifyEval  = await getEngineEvalCached(afterFen, SCAN_DEPTH_VERIFY);
                const verifyScore = -(verifyEval.score * sign);
                const verifyLoss  = baseScore - verifyScore;

                TreasureDiag.log('ENGINE', '🔍 Gem verification: ' + candidate.san, {
                    verifyLoss: Math.round(verifyLoss),
                    gemThreshold: EVAL_LOSS_GEM
                });

                if (verifyLoss > EVAL_LOSS_GEM) {
                    if (verifyLoss <= EVAL_LOSS_GOLD) {
                        type = 'BURIED_GOLD';
                    } else if (verifyLoss <= EVAL_LOSS_PEARL) {
                        type = 'PEARL';
                    } else {
                        continue;
                    }
                    treasures.push(buildTreasure(candidate, type, verifyLoss));
                    continue;
                }
            }

            treasures.push(buildTreasure(candidate, type, evalLoss));
        }

        treasures.sort((a, b) => b.tier - a.tier || a.evalLoss - b.evalLoss);
        return treasures.slice(0, MAX_TREASURES_PER_POSITION);
    }

// ==========================================
    // КЛАССИФИКАЦИЯ СОКРОВИЩА
    // ==========================================

    function classifyTreasure({ popularity, evalLoss, games, adjustedWR }) {

        if (evalLoss > EVAL_LOSS_PEARL) return null;

        // 💎 HIDDEN_GEM
        if (popularity < POP_ULTRA_RARE &&
            evalLoss   <= EVAL_LOSS_GEM &&
            games      >= MIN_GAMES_GEM &&
            adjustedWR >= WINRATE_GEM_MIN) {
            return 'HIDDEN_GEM';
        }

        // 💎 Бонусный путь: ход улучшает позицию
        if (popularity < POP_RARE &&
            evalLoss   <= EVAL_GAIN_BONUS &&
            games      >= MIN_GAMES_GEM &&
            adjustedWR >= WINRATE_GOLD_MIN) {
            return 'HIDDEN_GEM';
        }

        // 🪙 BURIED_GOLD
        if (popularity < POP_RARE &&
            evalLoss   <= EVAL_LOSS_GOLD &&
            games      >= MIN_GAMES_GOLD &&
            adjustedWR >= WINRATE_GOLD_MIN) {
            return 'BURIED_GOLD';
        }

        // 🦪 PEARL
        if (popularity < POP_UNCOMMON &&
            evalLoss   <= EVAL_LOSS_PEARL &&
            games      >= MIN_GAMES_PEARL &&
            adjustedWR >= WINRATE_PEARL_MIN) {
            return 'PEARL';
        }

        return null;
    }

    // ==========================================
    // СБОРКА ОБЪЕКТА СОКРОВИЩА
    // ==========================================

    function buildTreasure(candidate, type, evalLoss) {
        const info = TREASURE_TYPES[type];
        return {
            san:        candidate.san,
            popularity: candidate.popularity,
            winRate:    candidate.winRate,
            games:      candidate.games,
            evalLoss:   Math.round(evalLoss),
            type:       type,
            icon:       info.icon,
            label:      info.label,
            tier:       info.tier,
            points:     info.points
        };
    }

// ==========================================
    // ПРОВЕРКА ХОДА ИГРОКА
    // ==========================================

    function checkPlayerMove(san) {
        if (!state.active || state.currentTreasures.length === 0) return null;

        const found = state.currentTreasures.find(t => t.san === san);

        if (found) {
            state.foundTreasures.push({
                ...found,
                moveNumber: state.currentMoveNumber,
                timestamp: Date.now()
            });

            state.sessionPoints += found.points;
            state.streak++;

            if (state.streak >= 2) {
                const bonus = Math.floor(found.points * 0.2 * (state.streak - 1));
                state.sessionPoints += bonus;
            }

            if (state.streak > state.maxStreak) {
                state.maxStreak = state.streak;
            }

            showTreasureFound(found);

            if (typeof SoundEngine !== 'undefined') {
                SoundEngine.comboUp(state.streak + 4);
            }

            updateTreasureUI();
            state.currentTreasures = [];
            return found;
        }

        // Сокровище пропущено
        const best = state.currentTreasures[0];
        state.missedTreasures.push({
            ...best,
            playerMove: san,
            moveNumber: state.currentMoveNumber
        });
        state.streak = 0;

        setTimeout(() => showTreasureMissed(best, san), 2500);

        state.currentTreasures = [];
        return null;
    }

// ==========================================
    // UI — ПОДСКАЗКА О НАЛИЧИИ СОКРОВИЩА
    // ==========================================

    function showTreasureHint(treasures) {
        if (!DOM.hint) return;

        const best = treasures[0];
        const level = getHintLevel();

        let text = '';
        if (level === 0) {
            text = '🗺️ Рядом что-то блестит...';
        } else if (level === 1) {
            text = best.icon + ' ' + best.label + ' скрыто в этой позиции!';
        } else {
            text = best.icon + ' Попробуйте необычный ход ' + getPieceHint(best.san);
        }

        DOM.hint.textContent = text;
        DOM.hint.classList.add('treasure-hint-visible', 'treasure-shimmer');
        setTimeout(() => DOM.hint.classList.remove('treasure-shimmer'), 2000);

        const duration = 4000 + state.positionComplexity * 20;
        setTimeout(() => DOM.hint.classList.remove('treasure-hint-visible'), duration);
    }

    // ==========================================
    // UI — СОКРОВИЩЕ НАЙДЕНО
    // ==========================================

    function showTreasureFound(treasure) {
        if (!DOM.overlay) return;

        const bonus = state.streak >= 2
            ? Math.floor(treasure.points * 0.2 * (state.streak - 1))
            : 0;

        const streakHTML = state.streak >= 2
            ? '<div class="treasure-streak-badge">' +
              '🔥 Серия: ' + state.streak + ' (+' + bonus + ' бонус)</div>'
            : '';

        DOM.overlay.innerHTML =
            '<div class="treasure-found-card treasure-tier-' + treasure.tier + '">' +
                '<div class="treasure-icon-large">' + treasure.icon + '</div>' +
                '<div class="treasure-title">Сокровище найдено!</div>' +
                '<div class="treasure-name">' + treasure.label + '</div>' +
                '<div class="treasure-move">' + treasure.san + '</div>' +
                '<div class="treasure-details">' +
                    '<span>Популярность: ' + treasure.popularity + '%</span>' +
                    '<span>Винрейт: ' + treasure.winRate + '%</span>' +
                    '<span>Партий: ' + treasure.games + '</span>' +
                    '<span>+' + treasure.points + ' очков</span>' +
                '</div>' +
                streakHTML +
            '</div>';

        DOM.overlay.classList.add('treasure-overlay-visible');
        setTimeout(() => DOM.overlay.classList.remove('treasure-overlay-visible'), 3500);
    }

    // ==========================================
    // UI — СОКРОВИЩЕ ПРОПУЩЕНО
    // ==========================================

    function showTreasureMissed(treasure, playerMove) {
        if (!DOM.hint) return;

        DOM.hint.innerHTML =
            '<span class="treasure-missed">' + treasure.icon +
            ' Пропущено: <b>' + treasure.san + '</b>' +
            ' (' + treasure.popularity + '% играют, ' +
            treasure.winRate + '% побед, ' +
            treasure.games + ' партий)</span>';

        DOM.hint.classList.add('treasure-hint-visible', 'treasure-missed-anim');
        setTimeout(() => {
            DOM.hint.classList.remove('treasure-hint-visible', 'treasure-missed-anim');
        }, 4000);
    }
// ==========================================
    // UI — ОБНОВЛЕНИЕ ПАНЕЛИ
    // ==========================================

    function updateTreasureUI() {
        if (DOM.counter) DOM.counter.textContent = state.foundTreasures.length;
        if (DOM.points)  DOM.points.textContent  = state.sessionPoints;

        if (DOM.streak) {
            if (state.streak >= 2) {
                DOM.streak.textContent = '🔥' + state.streak;
                DOM.streak.classList.add('visible');
            } else {
                DOM.streak.classList.remove('visible');
            }
        }
    }

    // ==========================================
    // УРОВЕНЬ ПОДСКАЗОК (по рейтингу)
    // ==========================================

    function getHintLevel() {
        if (typeof userRating === 'undefined') return 1;
        if (userRating < 1200) return 2;
        if (userRating < 1800) return 1;
        return 0;
    }

    function getPieceHint(san) {
        if (san.startsWith('N')) return 'конём';
        if (san.startsWith('B')) return 'слоном';
        if (san.startsWith('R')) return 'ладьёй';
        if (san.startsWith('Q')) return 'ферзём';
        if (san.startsWith('K')) return 'королём';
        if (san.startsWith('O')) return '(рокировка)';
        return 'пешкой';
    }

    // ==========================================
    // ЛОГИРОВАНИЕ
    // ==========================================

    function logScanResult(fen, treasures) {
        state.scanHistory.push({
            fen: fen,
            moveNumber: state.currentMoveNumber,
            complexity: state.positionComplexity,
            treasures: treasures.map(t => ({
                san: t.san, type: t.type,
                evalLoss: t.evalLoss, popularity: t.popularity,
                games: t.games
            })),
            timestamp: Date.now()
        });

        if (state.scanHistory.length > SCAN_HISTORY_LIMIT) {
            state.scanHistory.shift();
        }
    }

    // ==========================================
    // СТАТИСТИКА СЕССИИ
    // ==========================================

    function getStats() {
        const total = state.foundTreasures.length + state.missedTreasures.length;

        return {
            found:      state.foundTreasures.length,
            missed:     state.missedTreasures.length,
            total:      total,
            hitRate:    total > 0 ? Math.round(state.foundTreasures.length / total * 100) : 0,
            points:     state.sessionPoints,
            maxStreak:  state.maxStreak,
            scanned:    state.totalScanned,
            treasures:  state.foundTreasures,
            missedList: state.missedTreasures,
            history:    state.scanHistory
        };
    }

    function isActive()   { return state.active; }
    function deactivate() { state.active = false; }

    // ==========================================
    // ПУБЛИЧНЫЙ API
    // ==========================================

    return {
        init,
        scanPosition,
        checkPlayerMove,
        getStats,
        isActive,
        deactivate,
        get state() { return state; },
        TREASURE_TYPES
    };

})();

//============================================
// TreasureHunt Diagnostics — Диагностика
// Вставить после основного модуля
//============================================

const TreasureDiag = (function() {
    'use strict';

    let logs = [];
    const MAX_LOGS = 200;

    function log(stage, message, data) {
        const entry = {
            time: new Date().toLocaleTimeString(),
            stage: stage,
            message: message,
            data: data || null
        };
        logs.push(entry);
        if (logs.length > MAX_LOGS) logs.shift();

        const colors = {
            'INIT':      'color: #00bcd4',
            'GATE':      'color: #ff9800',
            'SCAN':      'color: #4caf50',
            'SERVER':    'color: #2196f3',
            'PREFILTER': 'color: #9c27b0',
            'ENGINE':    'color: #f44336',
            'CLASSIFY':  'color: #ffeb3b; background: #333',
            'RESULT':    'color: #00e676; font-weight: bold',
            'ERROR':     'color: #ff0000; font-weight: bold',
            'UI':        'color: #78909c'
        };

        const style = colors[stage] || 'color: #999';
        console.log(
            '%c[Treasure:' + stage + '] ' + message,
            style,
            data !== null && data !== undefined ? data : ''
        );
    }

    function getLog() {
        return logs.slice();
    }

    function printReport() {
        console.group('🏴‍☠️ TreasureHunt Diagnostic Report');

        // Проверяем существование модуля
        if (typeof TreasureHunt === 'undefined') {
            console.error('❌ TreasureHunt module NOT FOUND');
            console.groupEnd();
            return;
        }

        console.log('Module exists: ✅');
        console.log('init function:', typeof TreasureHunt.init);
        console.log('scanPosition function:', typeof TreasureHunt.scanPosition);
        console.log('isActive():', TreasureHunt.isActive());

        // Безопасный доступ к state
        const s = TreasureHunt.state;
        if (!s || typeof s.active === 'undefined') {
            console.error('❌ STATE NOT INITIALIZED — init() was never called!');
            console.log('Raw state:', s);
            console.log('');
            console.log('🔧 FIX: Call TreasureHunt.init() or check where it should be called');
            console.log('   Try running: TreasureHunt.init()');
            console.groupEnd();
            return;
        }

        console.log('--- State ---');
        console.log('Active:', s.active);
        console.log('Total scanned:', s.totalScanned);
        console.log('Found treasures:', s.foundTreasures ? s.foundTreasures.length : 0);
        console.log('Missed treasures:', s.missedTreasures ? s.missedTreasures.length : 0);
        console.log('Current treasures:', s.currentTreasures || []);
        console.log('Last scan FEN:', s.lastScanFen || 'none');
        console.log('Moves since scan:', s.movesSinceLastScan);
        console.log('Current move #:', s.currentMoveNumber);
        console.log('Dynamic cooldown:', s.dynamicCooldown);
        console.log('Empty scans streak:', s.consecutiveEmptyScans);
        console.log('Position complexity:', s.positionComplexity);
        console.log('Engine cache size:', s.engineCache ? s.engineCache.size : 0);
        console.log('Scan in progress:', s.scanInProgress);

        // Проверяем зависимости
        console.log('--- Dependencies ---');
        console.log('API_BASE:', typeof API_BASE !== 'undefined' ? API_BASE : '❌ UNDEFINED');
        console.log('userRating:', typeof userRating !== 'undefined' ? userRating : '❌ UNDEFINED');
        console.log('Chess:', typeof Chess !== 'undefined' ? '✅' : '❌ MISSING');
        console.log('getEngineEvaluation:', typeof getEngineEvaluation !== 'undefined' ? '✅' : '❌ MISSING');

        // Проверяем DOM
        console.log('--- DOM Elements ---');
        const domIds = [
            'treasure-panel', 'treasure-counter', 'treasure-points',
            'treasure-streak', 'treasure-hint', 'treasure-overlay'
        ];
        domIds.forEach(function(id) {
            const el = document.getElementById(id);
            console.log('#' + id + ':', el ? '✅ found' : '❌ MISSING');
        });

        // Статистика логов
        if (logs.length > 0) {
            console.log('--- Log Stats ---');
            const stages = {};
            logs.forEach(function(l) {
                stages[l.stage] = (stages[l.stage] || 0) + 1;
            });
            console.log('Entries by stage:', stages);

            var gates = logs.filter(function(l) { return l.stage === 'GATE'; });
            if (gates.length > 0) {
                console.group('Last 10 gate blocks:');
                gates.slice(-10).forEach(function(g) {
                    console.log(g.time, g.message, g.data || '');
                });
                console.groupEnd();
            }
        } else {
            console.log('--- No log entries yet ---');
            console.log('This means scanPosition() was never called');
        }

        console.groupEnd();
    }

    function clear() {
        logs = [];
        console.log('🧹 TreasureHunt logs cleared');
    }

    // Быстрый тест — пытается запустить скан вручную
    function testScan(fen, color) {
        if (!fen) {
            console.log('Usage: TreasureDiag.testScan("fen_string", "white"|"black")');
            console.log('Example FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
            return;
        }

        console.log('🧪 Manual scan test...');

        if (!TreasureHunt.isActive()) {
            console.log('⚠️ Module not active, calling init()...');
            TreasureHunt.init();
        }

        TreasureHunt.scanPosition(fen, color || 'white')
            .then(function(result) {
                console.log('🧪 Test result:', result);
                if (result.length === 0) {
                    console.log('No treasures found. Check GATE/SERVER/ENGINE logs above.');
                }
            })
            .catch(function(e) {
                console.error('🧪 Test crashed:', e);
            });
    }

    return { log, getLog, printReport, clear, testScan };
})();

window.TreasureDiag = TreasureDiag;

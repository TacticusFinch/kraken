//============================================
// TreasureHunt — Поиск сокровищ v1.1
// Действительно редкие и сильные ходы
//============================================

const TreasureHunt = (function() {
    'use strict';

    // --- Константы ---
    const TREASURE_SCAN_DEPTH = 16;
    const SCAN_COOLDOWN_MOVES = 3;        // Сканируем только каждые 3 хода
    const MIN_MOVE_NUMBER = 3;            // Не сканируем первые 2 хода (слишком теоретические)
    const MAX_MOVE_NUMBER = 15;           // После 15 хода книга слишком разреженная
    const EVAL_LOSS_MAX = 40;             // Максимальная потеря оценки для сокровища (0.4 пешки)

    // Типы сокровищ
    const TREASURE_TYPES = {
        HIDDEN_GEM:  { icon: '💎', label: 'Скрытый бриллиант', tier: 3, points: 50 },
        BURIED_GOLD: { icon: '🪙', label: 'Золото глубин',     tier: 2, points: 30 },
        PEARL:       { icon: '🦪', label: 'Жемчужина',         tier: 1, points: 15 }
    };

    // --- Состояние ---
    let state = {
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
        scanInProgress: false
    };

    let DOM = {};

    // ============================================
    // Инициализация
    // ============================================

    function init() {
        state = {
            active: true,
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
            scanInProgress: false
        };

        cacheDOMElements();
        updateTreasureUI();
        console.log('🏴‍☠️ TreasureHunt v1.1 initialized (strict mode)');
    }

    function cacheDOMElements() {
        DOM.panel = document.getElementById('treasure-panel');
        DOM.counter = document.getElementById('treasure-counter');
        DOM.points = document.getElementById('treasure-points');
        DOM.streak = document.getElementById('treasure-streak');
        DOM.hint = document.getElementById('treasure-hint');
        DOM.overlay = document.getElementById('treasure-overlay');
    }

    // ============================================
    // Основной алгоритм сканирования
    // ============================================

    async function scanPosition(fen, playerColor) {
        if (!state.active) return [];
        if (state.scanInProgress) return [];
        if (fen === state.lastScanFen) return state.currentTreasures;

        // Определяем номер хода из FEN
        const fenParts = fen.split(/\s+/);
        const fullmove = parseInt(fenParts[5]) || 1;
        state.currentMoveNumber = fullmove;

        // Не сканируем слишком ранние ходы (чистая теория)
        if (fullmove < MIN_MOVE_NUMBER) {
            return [];
        }

        // Не сканируем слишком поздние ходы (книга разреженная)
        if (fullmove > MAX_MOVE_NUMBER) {
            return [];
        }

        // Кулдаун: сканируем не каждый ход
        state.movesSinceLastScan++;
        if (state.movesSinceLastScan < SCAN_COOLDOWN_MOVES) {
            return [];
        }

        state.movesSinceLastScan = 0;
        state.lastScanFen = fen;
        state.scanInProgress = true;

        try {
            // Шаг 1: Получаем данные книги с сервера
            const bookData = await fetchBookData(fen);
            if (!bookData || !bookData.treasures || bookData.treasures.length === 0) {
                state.currentTreasures = [];
                return [];
            }

            // Шаг 2: Проверяем каждый редкий ход движком
            const treasures = await evaluateRareMoves(fen, bookData.treasures, playerColor);

            state.currentTreasures = treasures;
            state.totalScanned++;

            // Шаг 3: Если есть сокровища — показываем подсказку
            if (treasures.length > 0) {
                showTreasureHint(treasures);
            }

            return treasures;
        } catch (e) {
            console.error('TreasureHunt scan error:', e);
            return [];
        } finally {
            state.scanInProgress = false;
        }
    }

    async function fetchBookData(fen) {
        try {
            const resp = await fetch(API_BASE + '/api/treasure/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fen, rating: userRating })
            });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (e) {
            console.warn('TreasureHunt: server unavailable', e.message);
            return null;
        }
    }

    async function evaluateRareMoves(fen, rareMoves, playerColor) {
        const treasures = [];
        const sign = playerColor === 'white' ? 1 : -1;

        // Оценка текущей позиции
        const baseEval = await getEngineEvaluation(fen, TREASURE_SCAN_DEPTH);
        const baseScore = baseEval.score * sign;

        for (let i = 0; i < rareMoves.length; i++) {
            const rareMove = rareMoves[i];

            const testChess = new Chess(fen);
            const moveResult = testChess.move(rareMove.san);
            if (!moveResult) continue;

            const afterFen = testChess.fen();
            const afterEval = await getEngineEvaluation(afterFen, TREASURE_SCAN_DEPTH);
            // После хода — оценка с точки зрения СОПЕРНИКА, поэтому инвертируем
            const afterScore = -(afterEval.score * sign);

            // Потеря оценки: положительная = ход ухудшает позицию
            const evalLoss = baseScore - afterScore;

            // СТРОГИЙ ФИЛЬТР: ход не должен терять больше 0.4 пешки
            if (evalLoss > EVAL_LOSS_MAX) continue;

            const type = classifyTreasure({
                popularity: parseFloat(rareMove.popularity),
                evalLoss: evalLoss,
                afterScore: afterScore,
                winRate: parseFloat(rareMove.winRate),
                treasureScore: parseFloat(rareMove.treasureScore || 0)
            });

            if (!type) continue;

            treasures.push({
                san: rareMove.san,
                popularity: rareMove.popularity,
                winRate: rareMove.winRate,
                games: rareMove.games,
                evalLoss: Math.round(evalLoss),
                type: type,
                icon: TREASURE_TYPES[type].icon,
                label: TREASURE_TYPES[type].label,
                tier: TREASURE_TYPES[type].tier,
                points: TREASURE_TYPES[type].points
            });
        }

        treasures.sort((a, b) => b.tier - a.tier || a.evalLoss - b.evalLoss);
        return treasures;
    }

    function classifyTreasure(data) {
        const { popularity, evalLoss, afterScore, winRate, treasureScore } = data;

        // Ход не должен быть плохим
        if (evalLoss > EVAL_LOSS_MAX) return null;

        // Скрытый бриллиант: очень редкий + движок одобряет + высокий WR
        if (popularity < 1 && evalLoss <= 10 && winRate > 54 && treasureScore > 10) {
            return 'HIDDEN_GEM';
        }

        // Золото глубин: редкий + сильный по движку
        if (popularity < 2 && evalLoss <= 20 && winRate > 51 && treasureScore > 5) {
            return 'BURIED_GOLD';
        }

        // Жемчужина: умеренно редкий + хороший
        if (popularity < 3 && evalLoss <= 30 && winRate > 49) {
            return 'PEARL';
        }

        return null;
    }

    // ============================================
    // Проверка хода игрока
    // ============================================

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
            if (state.streak > state.maxStreak) state.maxStreak = state.streak;

            showTreasureFound(found);

            if (typeof SoundEngine !== 'undefined') {
                SoundEngine.comboUp(state.streak + 4);
            }

            updateTreasureUI();
            state.currentTreasures = [];
            return found;
        } else {
            if (state.currentTreasures.length > 0) {
                const best = state.currentTreasures[0];
                state.missedTreasures.push({
                    ...best,
                    playerMove: san,
                    moveNumber: state.currentMoveNumber
                });
                state.streak = 0;

                setTimeout(() => showTreasureMissed(best, san), 2000);
            }
        }

        state.currentTreasures = [];
        return null;
    }

    // ============================================
    // UI
    // ============================================

    function showTreasureHint(treasures) {
        if (!DOM.hint) return;

        const best = treasures[0];
        const hintLevel = getHintLevel();

        let hintText = '';
        switch (hintLevel) {
            case 0:
                hintText = '🗺️ Рядом что-то блестит...';
                break;
            case 1:
                hintText = best.icon + ' ' + best.label + ' скрыто в этой позиции!';
                break;
            case 2:
                hintText = best.icon + ' Попробуйте необычный ход ' + getPieceHint(best.san);
                break;
        }

        DOM.hint.textContent = hintText;
        DOM.hint.classList.add('treasure-hint-visible');
        DOM.hint.classList.add('treasure-shimmer');
        setTimeout(() => DOM.hint.classList.remove('treasure-shimmer'), 2000);

        // Автоскрытие через 5 секунд
        setTimeout(() => {
            DOM.hint.classList.remove('treasure-hint-visible');
        }, 5000);
    }

    function showTreasureFound(treasure) {
        if (!DOM.overlay) return;

        DOM.overlay.innerHTML =
            '<div class="treasure-found-card treasure-tier-' + treasure.tier + '">' +
                '<div class="treasure-icon-large">' + treasure.icon + '</div>' +
                '<div class="treasure-title">Сокровище найдено!</div>' +
                '<div class="treasure-name">' + treasure.label + '</div>' +
                '<div class="treasure-move">' + treasure.san + '</div>' +
                '<div class="treasure-details">' +
                    '<span>Популярность: ' + treasure.popularity + '%</span>' +
                    '<span>Винрейт: ' + treasure.winRate + '%</span>' +
                    '<span>+' + treasure.points + ' очков</span>' +
                '</div>' +
                (state.streak >= 2 ?
                    '<div class="treasure-streak-badge">🔥 Серия: ' + state.streak + '</div>' : '') +
            '</div>';

        DOM.overlay.classList.add('treasure-overlay-visible');

        // Скрываем через 3.5 секунды
        setTimeout(() => {
            DOM.overlay.classList.remove('treasure-overlay-visible');
        }, 3500);
    }

    function showTreasureMissed(treasure, playerMove) {
        if (!DOM.hint) return;

        DOM.hint.innerHTML =
            '<span class="treasure-missed">' + treasure.icon +
            ' Пропущено: <b>' + treasure.san + '</b>' +
            ' (' + treasure.popularity + '% играют, ' +
            treasure.winRate + '% побед)</span>';

        DOM.hint.classList.add('treasure-hint-visible', 'treasure-missed-anim');

        setTimeout(() => {
            DOM.hint.classList.remove('treasure-hint-visible', 'treasure-missed-anim');
        }, 4000);
    }

    function updateTreasureUI() {
        if (DOM.counter) {
            DOM.counter.textContent = state.foundTreasures.length;
        }
        if (DOM.points) {
            DOM.points.textContent = state.sessionPoints;
        }
        if (DOM.streak && state.streak >= 2) {
            DOM.streak.textContent = '🔥' + state.streak;
            DOM.streak.classList.add('visible');
        } else if (DOM.streak) {
            DOM.streak.classList.remove('visible');
        }
    }

    function getHintLevel() {
        if (typeof userRating === 'undefined') return 1;
        if (userRating < 1200) return 2;
        if (userRating < 1600) return 1;
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

    // ============================================
    // Статистика
    // ============================================

    function getStats() {
        return {
            found: state.foundTreasures.length,
            missed: state.missedTreasures.length,
            total: state.foundTreasures.length + state.missedTreasures.length,
            points: state.sessionPoints,
            maxStreak: state.maxStreak,
            treasures: state.foundTreasures,
            missedList: state.missedTreasures,
            scanned: state.totalScanned
        };
    }

    function isActive() {
        return state.active;
    }

    function deactivate() {
        state.active = false;
    }

    // ============================================
    // Публичный API
    // ============================================

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
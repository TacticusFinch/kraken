//============================================
// Kraken — Модуль «Поиск Сокровищ» v3.0 (Zero-Lag)
//============================================

const TreasureHunt = (function() {
    'use strict';

    let state = {
        active: true,
        availableTreasures: [], // Сокровища в текущей позиции
        foundTreasures: [],     // Найденные за сессию
        sessionScore: 0,
        streak: 0
    };

    const DOM = {};

    function init() {
        DOM.panel = document.getElementById('treasure-panel');
        DOM.counter = document.getElementById('treasure-counter');
        DOM.points = document.getElementById('treasure-points');
        DOM.streak = document.getElementById('treasure-streak');
        DOM.hint = document.getElementById('treasure-hint');
        DOM.overlay = document.getElementById('treasure-overlay');

        reset();
        console.log('🏴‍☠️ Система сокровищ v3.0 готова');
    }

    function reset() {
        state.availableTreasures = [];
        state.foundTreasures = [];
        state.sessionScore = 0;
        state.streak = 0;
        updateUI();
    }

    // Принимает сокровища от сервера (из /play-move)
    function setAvailableTreasures(treasures) {
        if (!treasures || treasures.length === 0) {
            state.availableTreasures = [];
            hideHint();
            return;
        }

        state.availableTreasures = treasures;
        showSubtleHint(treasures[0]);
    }

    // Проверка хода игрока
    function checkPlayerMove(san, moveCPL) {
        if (!state.availableTreasures.length) return null;

        const cleanSan = san.replace(/[+#!?]/g, '');
        const match = state.availableTreasures.find(t => t.san.replace(/[+#!?]/g, '') === cleanSan);

        // Сокровище засчитывается только если игрок угадал ход И движок не считает это грубым зевком (CPL <= 50)
        if (match && (moveCPL === undefined || moveCPL <= 50)) {
            state.foundTreasures.push(match);
            state.sessionScore += match.points;
            state.streak++;

            triggerFoundCelebration(match);
            state.availableTreasures = [];
            updateUI();
            return match;
        } else if (match && moveCPL > 50) {
            console.log(`⚠️ Ход ${san} был редким, но движок посчитал его слабым (CPL: ${moveCPL})`);
        }

        // Если игрок сделал другой ход, сокровища позиции сгорают
        state.availableTreasures = [];
        hideHint();
        return null;
    }

    function showSubtleHint(treasure) {
        if (!DOM.hint) return;
        DOM.hint.innerHTML = `<span class="compass-icon">🧭</span> В этой позиции скрыто сокровище! (${treasure.label})`;
        DOM.hint.classList.add('visible');
    }

    function hideHint() {
        if (DOM.hint) DOM.hint.classList.remove('visible');
    }

    function triggerFoundCelebration(treasure) {
        if (typeof SoundEngine !== 'undefined' && SoundEngine.comboUp) {
            SoundEngine.comboUp(6);
        }

        if (DOM.overlay) {
            DOM.overlay.innerHTML = `
                <div class="treasure-popup animate-pop">
                    <div class="treasure-icon">${treasure.icon}</div>
                    <div class="treasure-title">СОКРОВИЩЕ НАЙДЕНО!</div>
                    <div class="treasure-name">${treasure.label}: <b>${treasure.san}</b></div>
                    <div class="treasure-meta">
                        Редкость: ${treasure.popularity}% игроков • Побед: ${treasure.winRate}%
                    </div>
                    <div class="treasure-reward">+${treasure.points} очков экспедиции</div>
                </div>
            `;
            DOM.overlay.classList.add('visible');
            setTimeout(() => DOM.overlay.classList.remove('visible'), 3200);
        }
    }

    function updateUI() {
        if (DOM.counter) DOM.counter.textContent = state.foundTreasures.length;
        if (DOM.points) DOM.points.textContent = state.sessionScore;
        if (DOM.streak) {
            DOM.streak.textContent = state.streak > 1 ? `x${state.streak}` : '';
        }
    }

    return {
        init,
        reset,
        setAvailableTreasures,
        checkPlayerMove,
        getStats: () => ({ ...state })
    };
})();
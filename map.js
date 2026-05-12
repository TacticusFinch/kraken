/*═══════════════════════════════════════════════════════VOYAGE MAP — Единая карта экспедиции по дебютамОбъединяет визуал карты + логику экспедиции
   ═══════════════════════════════════════════════════════ */

const VoyageMap = (() => {
    'use strict';

    // ═══ DOM-элементы ═══
    let container, mapImage, toggleBtn, toggleText;
    let portsLayer, routesSvg, shipEl, portPanel, starsCounter;

    // ═══ Состояние UI ═══
    let isVisible = false;
    let isBackground = true;
    let isPanelOpen = false;
    let activeOpening = null;

    // ═══ Порты с дебютами ═══
    const PORTS = [
        {
            id: 'spain',
            name: 'Испания',
            x: 30, y: 60,
            icon: '🇪🇸',
            description: 'Родина Руя Лопеса',
            openings: [
                {
                    eco: 'C60',
                    name: 'Испанская партия',
                    description: 'Один из старейших и глубочайших дебютов',
                    forcedMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
                    playerColor: 'white',
                    difficulty: 1400,
                    requiredStars: 0
                },
                {
                    eco: 'C65',
                    name: 'Берлинская защита',
                    description: 'Непробиваемая стена Крамника',
                    forcedMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'],
                    playerColor: 'black',
                    difficulty: 1600,
                    requiredStars: 2
                }
            ],
            unlockCondition: null,
            totalStarsNeeded: 0
        },
        {
            id: 'france',
            name: 'Франция',
            x: 42, y: 42,
            icon: '🇫🇷',
            description: 'Страна изысканной защиты',
            openings: [
                {
                    eco: 'C00',
                    name: 'Французская защита',
                    description: 'Солидная контригра чёрными',
                    forcedMoves: ['e4', 'e6'],
                    playerColor: 'black',
                    difficulty: 1300,
                    requiredStars: 0
                },
                {
                    eco: 'C11',
                    name: 'Вариант Стейница',
                    description: 'Классическая пешечная структура',
                    forcedMoves: ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6', 'e5'],
                    playerColor: 'black',
                    difficulty: 1500,
                    requiredStars: 1
                }
            ],
            unlockCondition: 'spain',
            totalStarsNeeded: 2
        },
        {
            id: 'italy',
            name: 'Италия',
            x: 62, y: 53,
            icon: '🇮🇹',
            description: 'Колыбель шахматной теории',
            openings: [
                {
                    eco: 'C50',
                    name: 'Итальянская партия',
                    description: 'Активное развитие и борьба за центр',
                    forcedMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
                    playerColor: 'white',
                    difficulty: 1200,
                    requiredStars: 0
                },
                {
                    eco: 'C51',
                    name: 'Гамбит Эванса',
                    description: 'Жертва пешки за бурную атаку',
                    forcedMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'],
                    playerColor: 'white',
                    difficulty: 1500,
                    requiredStars: 2
                }
            ],
            unlockCondition: 'france',
            totalStarsNeeded: 2
        },
        {
            id: 'sicily',
            name: 'Сицилия',
            x: 55, y: 75,
            icon: '🏝️',
            description: 'Остров острейших вариантов',
            openings: [
                {
                    eco: 'B20',
                    name: 'Сицилианская защита',
                    description: 'Самый острый ответ на 1.e4',
                    forcedMoves: ['e4', 'c5'],
                    playerColor: 'black',
                    difficulty: 1400,
                    requiredStars: 0
                },
                {
                    eco: 'B33',
                    name: 'Вариант Найдорфа',
                    description: 'Любимое оружие Фишера и Каспарова',
                    forcedMoves: ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'],
                    playerColor: 'black',
                    difficulty: 1800,
                    requiredStars: 3
                }
            ],
            unlockCondition: 'italy',
            totalStarsNeeded: 2
        }
    ];

    // ═══ Морские маршруты ═══
    const ROUTES = [
        {
            from: 'spain', to: 'france',
            waypoints: [
                { x: 30, y: 60 }, { x: 30, y: 50 },
                { x: 40, y: 40 }, { x: 42, y: 42 }
            ]
        },
        {
            from: 'france', to: 'italy',
            waypoints: [
                { x: 42, y: 42 }, { x: 52, y: 35 },
                { x: 54, y: 33 }, { x: 62, y: 53 }
            ]
        },
        {
            from: 'italy', to: 'sicily',
            waypoints: [
                { x: 52, y: 45 }, { x: 53, y: 52 },
                { x: 54, y: 58 }, { x: 55, y: 65 }
            ]
        }
    ];

    const STORAGE_KEY = 'voyageMap_v2';
    let progress = null;

// ═══════════════════════════════════════
    //  ПРОГРЕСС — загрузка / сохранение
    // ═══════════════════════════════════════

    function loadProgress() {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) return JSON.parse(saved);
        } catch (e) {
            console.warn('Ошибка загрузки прогресса:', e);
        }
        return createDefaultProgress();
    }

    function createDefaultProgress() {
        const p = {
            currentPort: 'spain',
            shipPosition: { x: 12, y: 52 },
            ports: {},
            totalStars: 0,
            openingsCompleted: {}
        };PORTS.forEach(port => {
            p.ports[port.id] = {
                unlocked: port.unlockCondition === null,
                visited: port.unlockCondition === null,
                stars: 0,
                maxStars: port.openings.length * 3
            };

            port.openings.forEach(op => {
                const key = port.id + ':' + op.eco;
                p.openingsCompleted[key] = {
                    bestStars: 0,
                    attempts: 0,
                    bestRatingDelta: 0,
                    lastPlayed: null
                };
            });
        });

        return p;
    }

    function saveProgress() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
        } catch (e) {
            console.warn('Ошибка сохранения прогресса:', e);
        }
    }

    // ═══ Вспомогательные функции прогресса ═══

    function findPort(portId) {
        return PORTS.find(p => p.id === portId) || null;
    }

    function isPortUnlocked(portId) {
        const port = findPort(portId);
        if (!port) return false;
        if (!port.unlockCondition) return true;
        const prevPort = progress.ports[port.unlockCondition];
        return prevPort && prevPort.stars >= port.totalStarsNeeded;
    }

    function isOpeningUnlocked(portId, openingEco) {
        const port = findPort(portId);
        if (!port) return false;
        if (!isPortUnlocked(portId)) return false;

        const opening = port.openings.find(o => o.eco === openingEco);
        if (!opening) return false;

        return progress.ports[portId].stars >= opening.requiredStars;
    }

    function getDifficultyLabel(rating) {
        if (rating <= 1200) return { text: 'Лёгкий', cls: 'diff-easy' };
        if (rating <= 1400) return { text: 'Средний', cls: 'diff-medium' };
        if (rating <= 1600) return { text: 'Сложный', cls: 'diff-hard' };
        if (rating <= 1800) return { text: 'Трудный', cls: 'diff-expert' };
        return { text: 'Мастер', cls: 'diff-master' };
    }

    function recalculatePortStars(portId) {
        const port = findPort(portId);
        if (!port) return;

        let total = 0;
        port.openings.forEach(op => {
            const key = portId + ':' + op.eco;
            const rec = progress.openingsCompleted[key];
            if (rec) total += rec.bestStars;
        });
        progress.ports[portId].stars = total;

        // Пересчёт общих
        progress.totalStars = Object.values(progress.ports)
            .reduce((sum, p) => sum + p.stars, 0);
    }

    function checkUnlocks() {
        PORTS.forEach(port => {
            const pp = progress.ports[port.id];
            if (!pp.unlocked && isPortUnlocked(port.id)) {
                pp.unlocked = true;
                showToast('🔓 Новый порт: ' + port.icon + ' ' + port.name + '!');
                if (typeof SoundEngine !== 'undefined') SoundEngine.comboUp(5);
            }
        });
    }

// ═══════════════════════════════════════
    //  ИНИЦИАЛИЗАЦИЯ
    // ═══════════════════════════════════════

    function init() {
        container = document.getElementById('opening-map-container');
        mapImage = document.getElementById('opening-map-img');
        toggleBtn = document.getElementById('toggle-map-btn');
        toggleText = document.getElementById('map-toggle-text');

        if (!container || !toggleBtn) {
            console.warn('⚠️ VoyageMap: DOM-элементы не найдены');
            return;
        }

        progress = loadProgress();
        createInteractiveLayers();

        // По умолчанию — карта как полупрозрачный фон
        container.classList.add('as-background', 'visible');

        toggleBtn.addEventListener('click', toggleMap);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (isPanelOpen) closePortPanel();
                else if (isVisible && !isBackground) hideMap();
            }
        });

        // Первичный рендер
        renderRoutes();
        renderPorts();
        renderShip();
        updateStarsCounter();

        console.log('🗺️ VoyageMap initialized');
    }

    function createInteractiveLayers() {
        // SVG-слой маршрутов
        routesSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        routesSvg.classList.add('voyage-routes-layer');
        routesSvg.setAttribute('viewBox', '0 0 100 100');
        routesSvg.setAttribute('preserveAspectRatio', 'none');
        container.appendChild(routesSvg);

        // Слой портов
        portsLayer = document.createElement('div');
        portsLayer.classList.add('voyage-ports-layer');
        container.appendChild(portsLayer);

        // Корабль
        shipEl = document.createElement('div');
        shipEl.classList.add('voyage-ship');
        shipEl.textContent = '⛵';
        container.appendChild(shipEl);

        // Счётчик звёзд
        starsCounter = document.createElement('div');
        starsCounter.classList.add('voyage-stars-counter');
        container.appendChild(starsCounter);

        // Панель порта
        portPanel = document.createElement('div');
        portPanel.classList.add('voyage-port-panel', 'hidden');
        portPanel.innerHTML = `
            <div class="vpp-header" id="vpp-header"></div>
            <div class="vpp-body" id="vpp-body"></div>
            <button class="vpp-close-btn" id="vpp-close">✕</button>
        `;
        container.appendChild(portPanel);

        portPanel.querySelector('#vpp-close').addEventListener('click', closePortPanel);}

// ═══════════════════════════════════════
    //  ПЕРЕКЛЮЧЕНИЕ ВИДИМОСТИ
    // ═══════════════════════════════════════

    function toggleMap() {
        if (isBackground) {
            // Фон → интерактивная карта
            container.classList.remove('as-background');
            container.classList.add('visible', 'interactive');
            isBackground = false;
            isVisible = true;
            toggleBtn.classList.add('active');
            toggleText.textContent = 'Доска';
            showLayers();
        } else if (isVisible) {
            // Интерактивная → фон
            closePortPanel();
            container.classList.remove('interactive');
            container.classList.add('as-background');
            isBackground = true;
            isVisible = false;
            toggleBtn.classList.remove('active');
            toggleText.textContent = 'Карта';
            hideLayers();
        }
    }

    function showMap() {
        container.classList.remove('as-background');
        container.classList.add('visible', 'interactive');
        isVisible = true;
        isBackground = false;
        toggleBtn.classList.add('active');
        toggleText.textContent = 'Доска';
        showLayers();
    }

    function hideMap() {
        closePortPanel();
        container.classList.remove('interactive');
        container.classList.add('as-background', 'visible');
        isVisible = false;
        isBackground = true;
        toggleBtn.classList.remove('active');
        toggleText.textContent = 'Карта';
        hideLayers();
    }

    function showLayers() {
        portsLayer.classList.add('active');
        routesSvg.classList.add('active');
        shipEl.classList.add('active');
        starsCounter.classList.add('active');}

    function hideLayers() {
        portsLayer.classList.remove('active');
        routesSvg.classList.remove('active');
        shipEl.classList.remove('active');
        starsCounter.classList.remove('active');
    }

    // Маленький тост для сообщений
    function showToast(msg) {
        if (typeof updateStatus === 'function') {
            updateStatus(msg);
        } else {
            console.log(msg);
        }
    }

// ═══════════════════════════════════════
    //  РЕНДЕРИНГ ПОРТОВ
    // ═══════════════════════════════════════

    function renderPorts() {portsLayer.innerHTML = '';

        PORTS.forEach(port => {
            const pp = progress.ports[port.id];
            const unlocked = pp.unlocked;
            const isCurrent = (progress.currentPort === port.id);

            const el = document.createElement('div');
            el.className = 'voyage-port'+ (unlocked ? ' unlocked' : ' locked')
                + (isCurrent ? ' current' : '');
            el.style.left = port.x + '%';
            el.style.top = port.y + '%';

            let starsHtml = '';
            for (let s = 0; s < pp.maxStars; s++) {
                starsHtml += (s < pp.stars) ? '⭐' : '☆';
            }

            el.innerHTML = `
                <div class="vport-icon">${port.icon}</div>
                <div class="vport-name">${port.name}</div>
                <div class="vport-stars">${starsHtml}</div>
                ${!unlocked ? '<div class="vport-lock">🔒</div>' : ''}
            `;

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                onPortClick(port);
            });

            portsLayer.appendChild(el);
        });
    }

    // ═══════════════════════════════════════
    //  РЕНДЕРИНГ МАРШРУТОВ
    // ═══════════════════════════════════════

    function renderRoutes() {
        while (routesSvg.firstChild) routesSvg.removeChild(routesSvg.firstChild);

        ROUTES.forEach(route => {
            const fromOk = progress.ports[route.from]?.unlocked;
            const toOk = progress.ports[route.to]?.unlocked;
            const active = fromOk && toOk;

            const wp = route.waypoints;
            if (wp.length < 2) return;

            let d = `M ${wp[0].x} ${wp[0].y}`;
            for (let j = 1; j < wp.length; j++) {
                d += ` L ${wp[j].x} ${wp[j].y}`;
            }

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', active ? '#c8a96e' : '#555');
            path.setAttribute('stroke-width', '0.6');
            path.setAttribute('stroke-dasharray', active ? '2,1' : '1,2');
            path.setAttribute('opacity', active ? '0.9' : '0.3');

            routesSvg.appendChild(path);
        });
    }

    // ═══════════════════════════════════════
    //  КОРАБЛЬ
    // ═══════════════════════════════════════

    function renderShip() {
        const pos = progress.shipPosition;
        shipEl.style.left = pos.x + '%';
        shipEl.style.top = pos.y + '%';
    }

    function animateShipTo(portId, callback) {
        const route = ROUTES.find(r => r.to === portId);

        if (!route) {
            const port = findPort(portId);
            if (port) {
                progress.shipPosition = { x: port.x, y: port.y };
                progress.currentPort = portId;
                saveProgress();
                renderShip();
            }
            if (callback) callback();
            return;
        }

        const waypoints = route.waypoints;
        let idx = 0;

        function step() {
            if (idx >= waypoints.length) {
                progress.shipPosition = { ...waypoints[waypoints.length - 1] };
                progress.currentPort = portId;
                progress.ports[portId].visited = true;
                saveProgress();
                if (callback) callback();
                return;
            }

            const wp = waypoints[idx];
            shipEl.style.transition = 'left 0.7s ease, top 0.7s ease';
            shipEl.style.left = wp.x + '%';
            shipEl.style.top = wp.y + '%';
            idx++;
            setTimeout(step, 800);
        }

        step();
    }

    function updateStarsCounter() {
        starsCounter.textContent = '⭐ ' + (progress.totalStars || 0);
    }

// ═══════════════════════════════════════
    //  ПАНЕЛЬ ПОРТА
    // ═══════════════════════════════════════

    function onPortClick(port) {
        const pp = progress.ports[port.id];

        if (!pp.unlocked) {
            const prevPort = findPort(port.unlockCondition);
            const needed = port.totalStarsNeeded;
            const have = progress.ports[port.unlockCondition]?.stars || 0;
            showToast(`🔒Ещё ${needed - have} ⭐ в ${prevPort?.icon || ''} ${prevPort?.name || ''}`);
            return;
        }

        openPortPanel(port);
    }

    function openPortPanel(port) {
        const pp = progress.ports[port.id];
        const header = portPanel.querySelector('#vpp-header');
        const body = portPanel.querySelector('#vpp-body');

        header.innerHTML = `
            <span class="vpp-icon">${port.icon}</span>
            <span class="vpp-name">${port.name}</span>
            <span class="vpp-stars">⭐ ${pp.stars}/${pp.maxStars}</span>
        `;

        body.innerHTML = '';

        port.openings.forEach((opening, index) => {
            body.appendChild(createOpeningCard(port, opening, index));
        });

        portPanel.classList.remove('hidden');
        portPanel.classList.add('visible');
        isPanelOpen = true;
    }

    function closePortPanel() {
        portPanel.classList.remove('visible');
        portPanel.classList.add('hidden');
        isPanelOpen = false;
    }

    function createOpeningCard(port, opening, index) {
        const key = port.id + ':' + opening.eco;
        const record = progress.openingsCompleted[key] || { bestStars: 0, attempts: 0 };
        const unlocked = isOpeningUnlocked(port.id, opening.eco);

        const card = document.createElement('div');
        card.className = 'voyage-opening-card' + (unlocked ? ' unlocked' : ' locked');

        let starsHtml = '';
        for (let s = 0; s < 3; s++) {
            starsHtml += (s < record.bestStars) ? '⭐' : '☆';
        }

        const colorIcon = opening.playerColor === 'white' ? '⬜' : '⬛';
        const diff = getDifficultyLabel(opening.difficulty);

        card.innerHTML = `
            <div class="voc-top">
                <span class="voc-eco">${opening.eco}</span>
                <span class="voc-color">${colorIcon}</span>
                <span class="voc-diff ${diff.cls}">${diff.text}</span>
            </div>
            <div class="voc-name">${opening.name}</div>
            <div class="voc-desc">${opening.description}</div>
            <div class="voc-bottom">
                <span class="voc-stars">${starsHtml}</span>
                ${record.attempts > 0 ? `<span class="voc-attempts">×${record.attempts}</span>` : ''}
            </div>${!unlocked ? `<div class="voc-lock">🔒 Нужно ${opening.requiredStars} ⭐</div>` : ''}
        `;

        if (unlocked) {
            card.addEventListener('click', () => launchOpening(port, index));
        }

        return card;
    }

// ═══════════════════════════════════════
    //  ЗАПУСК ТРЕНИРОВКИ
    // ═══════════════════════════════════════

    function launchOpening(port, openingIndex) {
        const opening = port.openings[openingIndex];
        if (!opening) return;

        if (progress.currentPort !== port.id) {
            animateShipTo(port.id, () => startTraining(port, opening));} else {
            startTraining(port, opening);
        }
    }

    function startTraining(port, opening) {
        hideMap();
        closePortPanel();

        // Записываем попытку
        const key = port.id + ':' + opening.eco;
        if (!progress.openingsCompleted[key]) {
            progress.openingsCompleted[key] = {
                bestStars: 0, attempts: 0,
                bestRatingDelta: 0, lastPlayed: null
            };
        }
        progress.openingsCompleted[key].attempts++;
        progress.openingsCompleted[key].lastPlayed = Date.now();
        saveProgress();

        // Контекст для recordResult
        activeOpening = {
            portId: port.id,
            eco: opening.eco,
            name: opening.name
        };

        // Запуск
        executeForcedMoves(opening);

        // Бейдж
        const badge = document.getElementById('opening-badge');
        if (badge) badge.textContent = port.icon + ' ' + opening.name;}

    function executeForcedMoves(opening) {
        if (typeof game === 'undefined' || typeof board === 'undefined') {
            console.error('[VoyageMap] game/board не найдены');
            return;
        }

        game.reset();

        // Сброс переменных из script.js
        if (typeof selectedSquare !== 'undefined') selectedSquare = null;
        if (typeof clearClickHighlight === 'function') clearClickHighlight();

        if (typeof createEmptyStats === 'function') {
            sessionStats = createEmptyStats();
        }
        if (typeof sessionStats !== 'undefined') {
            sessionStats.openingDifficulty = opening.difficulty || 1400;
        }

        sessionActive = true;
        pendingEndSession = false;
        movesOutOfBook = 0;
        notationHalfMoves = 0;
        premoveData = null;
        if (typeof clearPremoveHighlight === 'function') clearPremoveHighlight();

        playerColor = opening.playerColor;
        $('#playerColor').val(playerColor);
        waitingForOpponent = false;
        board.orientation(playerColor);

        // Очистка UI
        $('#move-history').empty();
        if (typeof updateComboBar === 'function') updateComboBar(0);
        if (typeof resetLiveStats === 'function') resetLiveStats();

        const lichessBtn = document.getElementById('lichess-analysis-btn');
        if (lichessBtn) {
            lichessBtn.classList.remove('visible');
            lichessBtn.onclick = null;
        }

        if (typeof VoyageEngine !== 'undefined' && VoyageEngine.init) {
            VoyageEngine.init(15);
        }

        // Воспроизведение forced moves
        const moves = opening.forcedMoves;
        let moveIndex = 0;

        function playNext() {
            if (moveIndex >= moves.length) {
                // Все вступительные ходы сделаны
                board.position(game.fen(), true);
                waitingForOpponent = false;
                if (typeof SoundEngine !== 'undefined') SoundEngine.gameStart();

                const turn = game.turn();
                const isPlayerTurn =
                    (playerColor === 'white' && turn === 'w') ||
                    (playerColor === 'black' && turn === 'b');

                if (!isPlayerTurn) {
                    waitingForOpponent = true;
                    showToast('⏳ Соперник думает...');
                    setTimeout(() => {
                        if (typeof makeEngineReplyFromPosition === 'function') {
                            makeEngineReplyFromPosition();
                        } else if (typeof makeEngineReply === 'function') {
                            makeEngineReply();
                        }
                    }, 300);
                } else {
                    showToast('♟ Ваш ход! Продолжите дебют.');
                }
                return;
            }

            const san = moves[moveIndex];
            const result = game.move(san);
            if (!result) {
                console.error('[VoyageMap] Невозможный ход:', san);
                return;
            }

            if (typeof appendMoveToNotation === 'function') {
                appendMoveToNotation(result,'theory', false);
            }

            moveIndex++;
            board.position(game.fen(), true);
            if (typeof playMoveSound === 'function') playMoveSound(result);
            setTimeout(playNext, 400);
        }

        board.position('start', false);
        setTimeout(playNext, 500);
    }

// ═══════════════════════════════════════
    //  РЕЗУЛЬТАТ ПАРТИИ
    // ═══════════════════════════════════════

    function recordResult(ratingDelta, stats) {
        if (!activeOpening) return null;

        const key = activeOpening.portId + ':' + activeOpening.eco;
        const record = progress.openingsCompleted[key];
        if (!record) return null;

        // Анализ ходов игрока
        const userMoves = stats.moves.filter(m => m.isUserMove);
        const totalMoves = userMoves.length;
        if (totalMoves === 0) return null;

        let goodMoves = 0;
        let hasBlunders = false;
        let hasErrors = false;

        userMoves.forEach(m => {
            if (m.cpl <= 50) goodMoves++;
            if (m.cpl > 200) hasBlunders = true;
            if (m.cpl > 100) hasErrors = true;
        });

        const accuracy = goodMoves / totalMoves;

        // Подсчёт звёзд
        let stars = 0;
        if (totalMoves >= 3) stars = 1;                // ⭐ — сыграл
        if (stars >= 1&& accuracy >= 0.7&& !hasBlunders) stars = 2;  // ⭐⭐ — хорошо
        if (stars >= 2 && accuracy >= 0.9 && !hasErrors) stars = 3;    // ⭐⭐⭐ — отлично

        // Обновляем рекорды
        if (stars > record.bestStars) record.bestStars = stars;
        if (ratingDelta > record.bestRatingDelta) record.bestRatingDelta = ratingDelta;

        // Пересчёт звёзд порта и общих
        recalculatePortStars(activeOpening.portId);

        // Проверяем разблокировки
        checkUnlocks();

        saveProgress();

        // Обновляем визуал
        renderPorts();
        renderRoutes();
        updateStarsCounter();

        // Показываем результат
        const portData = findPort(activeOpening.portId);
        const portIcon = portData ? portData.icon : '🗺️';
        let starsDisplay = '';
        for (let s = 0; s < 3; s++) {
            starsDisplay += (s < stars) ? '⭐' : '☆';
        }
        showToast(`${portIcon} ${activeOpening.name}: ${starsDisplay} (${Math.round(accuracy * 100)}%)`);

        // Сбрасываем контекст
        const result = {
            stars: stars,
            accuracy: Math.round(accuracy * 100),
            openingName: activeOpening.name,
            portId: activeOpening.portId
        };

        activeOpening = null;

        return result;
    }

// ═══════════════════════════════════════
    //  СБРОС ПРОГРЕССА (отладка)
    // ═══════════════════════════════════════

    function resetProgress() {
        progress = createDefaultProgress();
        saveProgress();
        renderPorts();
        renderRoutes();
        renderShip();
        updateStarsCounter();
        closePortPanel();
        console.log('🗺️ Прогресс карты сброшен');
    }

    // ═══════════════════════════════════════
    //  ПУБЛИЧНЫЙ API
    // ═══════════════════════════════════════

    return {
        init,
        toggle: toggleMap,
        show: showMap,
        hide: hideMap,

        // Результат партии — вызывается из script.js
        recordResult,

        // Для проверок из script.js
        hasActiveOpening: () => !!activeOpening,
        getActiveOpening: () => activeOpening,

        // Данные
        getProgress: () => progress,
        getPorts: () => PORTS,

        // Отладка
        resetProgress,

        // Ручное обновление маркера (совместимость со старым кодом)
        updateMarker: (openingName) => {
            // Подсвечиваем карту при смене дебюта
            if (container && isBackground) {
                container.classList.add('flash-hint');
                setTimeout(() => container.classList.remove('flash-hint'), 1500);
            }
        }
    };

})();

// ═══ Запуск ═══
document.addEventListener('DOMContentLoaded', () => {
    VoyageMap.init();
});

console.log('🗺️ VoyageMap module loaded');


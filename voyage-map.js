//============================================
// VoyageMapEngine — Карта экспедиции по дебютам
//============================================

var VoyageMapEngine = (function () {

    // ═══ Конфигурация портов ═══
    var PORTS = [
        {
            id: 'spain',
            name: 'Испания',
            x: 15, y: 55,
            icon: '🇪🇸',
            openings: [
                {
                    eco: 'C60',
                    name: 'Испанская партия',
                    description: 'Один из старейших и глубочайших дебютов',
                    startFEN: null,
                    forcedMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
                    playerColor: 'white',
                    difficulty: 1400,
                    requiredStars: 0
                },
                {
                    eco: 'C65',
                    name: 'Берлинская защита',
                    description: 'Непробиваемая стена Крамника',
                    startFEN: null,
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
            x: 35, y: 35,
            icon: '🇫🇷',
            openings: [
                {
                    eco: 'C00',
                    name: 'Французская защита',
                    description: 'Солидная контригра чёрными',
                    startFEN: null,
                    forcedMoves: ['e4', 'e6'],
                    playerColor: 'black',
                    difficulty: 1300,
                    requiredStars: 0
                },
                {
                    eco: 'C11',
                    name: 'Вариант Стейница',
                    description: 'Классическая пешечная структура',
                    startFEN: null,
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
            x: 52, y: 48,
            icon: '🇮🇹',
            openings: [
                {
                    eco: 'C50',
                    name: 'Итальянская партия',
                    description: 'Активное развитие и борьба за центр',
                    startFEN: null,
                    forcedMoves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
                    playerColor: 'white',
                    difficulty: 1200,
                    requiredStars: 0
                },
                {
                    eco: 'C51',
                    name: 'Гамбит Эванса',
                    description: 'Жертва пешки за бурную атаку',
                    startFEN: null,
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
            x: 55, y: 68,
            icon: '🏝️',
            openings: [
                {
                    eco: 'B20',
                    name: 'Сицилианская защита',
                    description: 'Самый острый ответ на 1.e4',
                    startFEN: null,
                    forcedMoves: ['e4', 'c5'],
                    playerColor: 'black',
                    difficulty: 1400,
                    requiredStars: 0
                },
                {
                    eco: 'B33',
                    name: 'Вариант Найдорфа',
                    description: 'Любимое оружие Фишера и Каспарова',
                    startFEN: null,
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

    // ═══ Маршруты между портами ═══
    var ROUTES = [
        {
            from: 'spain', to: 'france',
            waypoints: [
                { x: 15, y: 55 }, { x: 20, y: 45 },
                { x: 25, y: 38 }, { x: 35, y: 35 }
            ]
        },
        {
            from: 'france', to: 'italy',
            waypoints: [
                { x: 35, y: 35 }, { x: 40, y: 38 },
                { x: 45, y: 42 }, { x: 52, y: 48 }
            ]
        },
        {
            from: 'italy', to: 'sicily',
            waypoints: [
                { x: 52, y: 48 }, { x: 53, y: 55 },
                { x: 54, y: 62 }, { x: 55, y: 68 }
            ]
        }
    ];

    // ═══ Прогресс (localStorage) ═══
    var STORAGE_KEY = 'voyageMapProgress';
    var progress = loadProgress();
    var isMapOpen = false;

    function loadProgress() {
        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved) return JSON.parse(saved);
        } catch (e) {
            console.warn('Ошибка загрузки прогресса карты:', e);
        }
        return createDefaultProgress();
    }

    function createDefaultProgress() {
        var p = {
            currentPort: 'spain',
            shipPosition: { x: 15, y: 55 },
            ports: {},
            totalStars: 0,
            openingsCompleted: {}
        };

        for (var i = 0; i < PORTS.length; i++) {
            var port = PORTS[i];
            p.ports[port.id] = {
                unlocked: port.unlockCondition === null,
                visited: port.unlockCondition === null,
                stars: 0,
                maxStars: port.openings.length * 3
            };
            for (var j = 0; j < port.openings.length; j++) {
                var op = port.openings[j];
                var key = port.id + ':' + op.eco;
                p.openingsCompleted[key] = {
                    bestStars: 0,
                    attempts: 0,
                    bestRatingDelta: 0,
                    lastPlayed: null
                };
            }
        }
        return p;
    }

    function saveProgress() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
        } catch (e) {
            console.warn('Ошибка сохранения прогресса:', e);
        }
    }

    function findPort(portId) {
        for (var i = 0; i < PORTS.length; i++) {
            if (PORTS[i].id === portId) return PORTS[i];
        }
        return null;
    }

    // ═══ Логика разблокировки ═══

    function isPortUnlocked(portId) {
        var port = findPort(portId);
        if (!port) return false;
        if (!port.unlockCondition) return true;
        var prevPort = progress.ports[port.unlockCondition];
        return prevPort && prevPort.stars >= port.totalStarsNeeded;
    }

    function isOpeningUnlocked(portId, openingEco) {
        var port = findPort(portId);
        if (!port) return false;
        var opening = null;
        for (var i = 0; i < port.openings.length; i++) {
            if (port.openings[i].eco === openingEco) {
                opening = port.openings[i];
                break;
            }
        }
        if (!opening) return false;
        if (!isPortUnlocked(portId)) return false;
        return progress.ports[portId].stars >= opening.requiredStars;
    }

    function getDifficultyLabel(rating) {
        if (rating <= 1200) return { text: 'Лёгкий', cls: 'diff-easy' };
        if (rating <= 1400) return { text: 'Средний', cls: 'diff-medium' };
        if (rating <= 1600) return { text: 'Сложный', cls: 'diff-hard' };
        if (rating <= 1800) return { text: 'Трудный', cls: 'diff-expert' };
        return { text: 'Мастер', cls: 'diff-master' };
    }

    // ═══ Запуск тренировки дебюта ═══

    function startOpeningTraining(portId, openingIndex) {
        var port = findPort(portId);
        if (!port) return;
        var opening = port.openings[openingIndex];
        if (!opening) return;

        if (!isOpeningUnlocked(portId, opening.eco)) {
            if (typeof updateStatus === 'function') {
                updateStatus('🔒 Нужно ' + opening.requiredStars + ' ⭐ для "' + opening.name + '"');
            }
            return;
        }

        closeMap();

        // Записываем попытку
        var key = portId + ':' + opening.eco;
        if (!progress.openingsCompleted[key]) {
            progress.openingsCompleted[key] = {
                bestStars: 0, attempts: 0,
                bestRatingDelta: 0, lastPlayed: null
            };
        }
        progress.openingsCompleted[key].attempts++;
        progress.openingsCompleted[key].lastPlayed = Date.now();
        saveProgress();

        // Сохраняем контекст для recordResult
        VoyageMapEngine._activeOpening = {
            portId: portId,
            openingIndex: openingIndex,
            eco: opening.eco,
            name: opening.name
        };

        // Запуск
        if (opening.forcedMoves && opening.forcedMoves.length > 0) {
            startGameWithForcedMoves(opening);
        } else if (opening.startFEN && typeof startGameFromFEN === 'function') {
            startGameFromFEN(opening.startFEN, opening.playerColor);
        } else {
            $('#playerColor').val(opening.playerColor);
            if (typeof startGame === 'function') startGame();
        }

        $('#opening-badge').text(port.icon + ' ' + opening.name);
    }

    function startGameWithForcedMoves(opening) {
        if (typeof game === 'undefined' || typeof board === 'undefined') return;

        game.reset();

        if (typeof selectedSquare !== 'undefined') selectedSquare = null;
        if (typeof clearClickHighlight === 'function') clearClickHighlight();

        sessionStats = createEmptyStats();
        sessionStats.openingDifficulty = opening.difficulty || userRating;
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

        // Очищаем UI
        $('#move-history').empty();
        if (typeof updateComboBar === 'function') updateComboBar(0);
        if (typeof resetLiveStats === 'function') resetLiveStats();

        var lichessBtn = document.getElementById('lichess-analysis-btn');
        if (lichessBtn) {
            lichessBtn.classList.remove('visible');
            lichessBtn.onclick = null;
        }

        if (typeof VoyageEngine !== 'undefined' && VoyageEngine.init) {
            VoyageEngine.init(15);
        }

        // Анимация вступительныхходов
        var moves = opening.forcedMoves;
        var moveIndex = 0;

        function playNextForcedMove() {
            if (moveIndex >= moves.length) {
                // Все forced moves сделаны — передаём управление
                board.position(game.fen(), true);
                waitingForOpponent = false;
                if (typeof SoundEngine !== 'undefined') SoundEngine.gameStart();

                var currentTurn = game.turn();
                var isPlayerTurn =
                    (playerColor === 'white' && currentTurn === 'w') ||
                    (playerColor === 'black' && currentTurn === 'b');

                if (!isPlayerTurn) {
                    waitingForOpponent = true;
                    if (typeof updateStatus === 'function') {
                        updateStatus('⏳ Соперник думает...');
                    }
                    setTimeout(function () {
                        if (typeof makeEngineReplyFromPosition === 'function') {
                            makeEngineReplyFromPosition();
                        } else if (typeof makeEngineReply === 'function') {
                            makeEngineReply();
                        }
                    }, 300);
                } else {
                    if (typeof updateStatus === 'function') {
                        updateStatus('♟ Ваш ход! Продолжите дебют.');
                    }
                }return;
            }

            var san = moves[moveIndex];
            var result = game.move(san);

            if (!result) {
                console.error('[MAP] Невозможный forced move:', san);
                return;
            }

            if (typeof appendMoveToNotation === 'function') {
                appendMoveToNotation(result,'theory', false);
            }

            moveIndex++;
            board.position(game.fen(), true);
            if (typeof playMoveSound === 'function') playMoveSound(result);

            setTimeout(playNextForcedMove, 400);
        }

        board.position('start', false);
        setTimeout(playNextForcedMove, 500);
    }

    // ═══ Обработка результата═══

    function recordResult(ratingDelta, stats) {
        var active = VoyageMapEngine._activeOpening;
        if (!active) return null;

        var key = active.portId + ':' + active.eco;
        var record = progress.openingsCompleted[key];
        if (!record) return null;

        // Считаем статистику
        var userMoves = [];
        var i;
        for (i = 0; i < stats.moves.length; i++) {
            if (stats.moves[i].isUserMove) userMoves.push(stats.moves[i]);
        }

        var totalMoves = userMoves.length;
        if (totalMoves === 0) return null;

        var goodMoves = 0;
        var hasBlunders = false;
        var hasErrors = false;

        for (i = 0; i < userMoves.length; i++) {
            if (userMoves[i].cpl <= 50) goodMoves++;
            if (userMoves[i].cpl > 200) hasBlunders = true;
            if (userMoves[i].cpl > 100) hasErrors = true;
        }

        var accuracy = goodMoves / totalMoves;

        // Звёзды
        var stars = 0;
        if (totalMoves >= 3) stars = 1;
        if (stars >= 1 && accuracy >= 0.7 && !hasBlunders) stars = 2;
        if (stars >= 2 && accuracy >= 0.9 && !hasErrors) stars = 3;

        // Обновляем рекорд
        if (stars > record.bestStars) record.bestStars = stars;
        if (ratingDelta > record.bestRatingDelta) record.bestRatingDelta = ratingDelta;

        recalculatePortStars(active.portId);
        checkUnlocks();
        saveProgress();

        VoyageMapEngine._activeOpening = null;

        return { stars: stars, accuracy: Math.round(accuracy * 100) };
    }

    function recalculatePortStars(portId) {
        var port = findPort(portId);
        if (!port) return;

        var totalStars = 0;
        for (var i = 0; i < port.openings.length; i++) {
            var key = portId + ':' + port.openings[i].eco;
            var rec = progress.openingsCompleted[key];
            if (rec) totalStars += rec.bestStars;
        }
        progress.ports[portId].stars = totalStars;

        // Пересчёт общих звёзд
        progress.totalStars = 0;
        var portIds = Object.keys(progress.ports);
        for (var j = 0; j < portIds.length; j++) {
            progress.totalStars += progress.ports[portIds[j]].stars;
        }
    }

    function checkUnlocks() {
        for (var i = 0; i < PORTS.length; i++) {
            var port = PORTS[i];
            var pp = progress.ports[port.id];
            if (!pp.unlocked && isPortUnlocked(port.id)) {
                pp.unlocked = true;
                if (typeof updateStatus === 'function') {
                    updateStatus('🔓 Новый порт: ' + port.icon + ' ' + port.name + '!');
                }
                if (typeof SoundEngine !== 'undefined') SoundEngine.comboUp(5);
            }
        }
    }

    // ═══ Открытие / закрытие карты ═══

    function openMap() {
        if (isMapOpen) { closeMap(); return; }
        isMapOpen = true;
        renderMap();
    }

    function closeMap() {
        isMapOpen = false;
        var $overlay = $('#voyage-map-overlay');
        $overlay.removeClass('show');
        setTimeout(function () { $overlay.remove(); }, 300);
    }

    // ═══ Рендеринг карты ═══

    function renderMap() {
        $('#voyage-map-overlay').remove();

        var totalStars = progress.totalStars || 0;

        var overlayHtml =
            '<div id="voyage-map-overlay" class="voyage-map-overlay">' +
              '<div class="voyage-map-container">' +
                '<div class="voyage-map-header">' +
                  '<h2 class="voyage-map-title">🗺️ Карта Экспедиции</h2>' +
                  '<div class="voyage-map-stars-total">⭐ ' + totalStars + '</div>' +
                  '<button class="voyage-map-close" id="map-close-btn">✕</button>' +
                '</div>' +
                '<div class="voyage-map-body">' +
                  '<div class="voyage-map-sea" id="voyage-map-sea">' +
                    '<svg class="voyage-map-routes" id="map-routes-svg"></svg>' +
                    '<div id="map-ports-container"></div>' +
                    '<div class="voyage-ship" id="voyage-ship">⛵</div>' +
                  '</div>' +
                '</div>' +
                '<div class="voyage-port-panel hidden" id="voyage-port-panel">' +
                  '<div class="voyage-port-panel-header" id="port-panel-header"></div>' +
                  '<div class="voyage-port-panel-openings" id="port-panel-openings"></div>' +
                '</div>' +
              '</div>' +
            '</div>';

        $('body').append(overlayHtml);
        renderPorts();
        renderRoutes();
        positionShip();

        $('#map-close-btn').on('click', closeMap);
        $('#voyage-map-overlay').on('click', function (e) {
            if ($(e.target).is('#voyage-map-overlay')) closeMap();
        });

        requestAnimationFrame(function () {
            $('#voyage-map-overlay').addClass('show');
        });
    }

    // ═══ Рендеринг портов ═══

    function renderPorts() {
        var $container = $('#map-ports-container');
        $container.empty();

        for (var i = 0; i < PORTS.length; i++) {
            renderSinglePort(PORTS[i]);
        }
    }

    function renderSinglePort(port) {
        var pp = progress.ports[port.id];
        var unlocked = pp.unlocked;
        var stars = pp.stars;
        var isCurrent = (progress.currentPort === port.id);

        var starsStr = '';
        for (var s = 0; s < 3; s++) {
            starsStr += (s < stars) ? '⭐' : '☆';
        }

        var cls = 'voyage-port';
        if (unlocked) cls += ' unlocked'; else cls += ' locked';
        if (isCurrent) cls += ' current';

        var lockHtml = unlocked ? '' : '<div class="voyage-port-lock">🔒</div>';

        var html =
            '<div class="' + cls + '" data-port-id="' + port.id + '" ' +'style="left:' + port.x + '%;top:' + port.y + '%;">' +
              '<div class="voyage-port-icon">' + port.icon + '</div>' +
              '<div class="voyage-port-name">' + port.name + '</div>' +
              '<div class="voyage-port-stars">' + starsStr + '</div>' +
              lockHtml +
            '</div>';

        var $port = $(html);

        $port.on('click', function () {
            if (unlocked) {
                showPortPanel(port);
            } else {
                var prevPort = findPort(port.unlockCondition);
                var needed = port.totalStarsNeeded;
                var have = progress.ports[port.unlockCondition]
                    ? progress.ports[port.unlockCondition].stars : 0;
                var msg = '🔒Ещё ' + (needed - have) + ' ⭐ в ';
                if (prevPort) msg += prevPort.icon + ' ' + prevPort.name;
                if (typeof updateStatus === 'function') updateStatus(msg);
            }
        });

        $('#map-ports-container').append($port);
    }

    // ═══ Рендеринг маршрутов (SVG) ═══

    function renderRoutes() {
        var svg = document.getElementById('map-routes-svg');
        if (!svg) return;

        while (svg.firstChild) svg.removeChild(svg.firstChild);

        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');

        for (var i = 0; i < ROUTES.length; i++) {
            var route = ROUTES[i];
            var fromOk = progress.ports[route.from] && progress.ports[route.from].unlocked;
            var toOk = progress.ports[route.to] && progress.ports[route.to].unlocked;
            var active = fromOk && toOk;

            var wp = route.waypoints;
            if (wp.length < 2) continue;

            var d = 'M ' + wp[0].x + ' ' + wp[0].y;
            for (var j = 1; j < wp.length; j++) {
                d += ' L ' + wp[j].x + ' ' + wp[j].y;
            }

            var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', active ? '#c8a96e' : '#555');
            path.setAttribute('stroke-width', '0.5');
            path.setAttribute('stroke-dasharray', active ? '2,1' : '1,2');
            path.setAttribute('opacity', active ? '0.8' : '0.3');

            svg.appendChild(path);
        }
    }

    // ═══ Корабль═══

    function positionShip() {
        var $ship = $('#voyage-ship');
        var pos = progress.shipPosition;
        $ship.css({ left: pos.x + '%', top: pos.y + '%' });
    }

    function animateShipToPort(portId, callback) {
        var route = null;
        for (var i = 0; i < ROUTES.length; i++) {
            if (ROUTES[i].to === portId) { route = ROUTES[i]; break; }
        }

        if (!route) {
            var port = findPort(portId);
            if (port) {
                progress.shipPosition = { x: port.x, y: port.y };
                progress.currentPort = portId;
                saveProgress();
                positionShip();
            }
            if (callback) callback();
            return;
        }

        var $ship = $('#voyage-ship');
        var waypoints = route.waypoints;
        var wpIdx = 0;

        function moveNext() {
            if (wpIdx >= waypoints.length) {
                var last = waypoints[waypoints.length - 1];
                progress.shipPosition = { x: last.x, y: last.y };
                progress.currentPort = portId;
                progress.ports[portId].visited = true;
                saveProgress();
                if (callback) callback();
                return;
            }

            var wp = waypoints[wpIdx];
            $ship.css({
                transition: 'left 0.8s ease, top 0.8s ease',
                left: wp.x + '%',
                top: wp.y + '%'
            });

            wpIdx++;
            setTimeout(moveNext, 900);
        }

        moveNext();
    }

    // ═══ Панель дебютов порта ═══

    function showPortPanel(port) {
        var $panel = $('#voyage-port-panel');
        var $header = $('#port-panel-header');
        var $openings = $('#port-panel-openings');

        var pp = progress.ports[port.id];

        $header.html(
            '<span class="port-panel-icon">' + port.icon + '</span>' +
            '<span class="port-panel-name">' + port.name + '</span>' +
            '<span class="port-panel-stars">⭐ ' + pp.stars + '/' + pp.maxStars + '</span>'
        );

        $openings.empty();

        for (var i = 0; i < port.openings.length; i++) {
            renderOpeningCard(port, i);
        }

        $panel.removeClass('hidden');
    }

    function renderOpeningCard(port, index) {
        var opening = port.openings[index];
        var key = port.id + ':' + opening.eco;
        var record = progress.openingsCompleted[key];
        if (!record) {
            record = { bestStars: 0, attempts: 0, bestRatingDelta: 0 };
        }
        var unlocked = isOpeningUnlocked(port.id, opening.eco);

        var starsStr = '';
        for (var s = 0; s < 3; s++) {
            starsStr += (s < record.bestStars) ? '⭐' : '☆';
        }

        var colorIcon = (opening.playerColor === 'white') ? '⬜' : '⬛';
        var diff = getDifficultyLabel(opening.difficulty);

        var lockHtml = '';
        if (!unlocked) {
            lockHtml =
                '<div class="opening-card-lock">🔒 Нужно ' +
                opening.requiredStars + ' ⭐</div>';
        }

        var attemptsHtml = '';
        if (record.attempts > 0) {
            attemptsHtml =
                '<div class="opening-card-attempts">Попыток: ' +
                record.attempts + '</div>';
        }

        var cardCls = 'opening-card';
        if (unlocked) {
            cardCls += ' unlocked';
        } else {
            cardCls += ' locked';
        }

        var html =
            '<div class="' + cardCls + '">' +
              '<div class="opening-card-top">' +
                '<span class="opening-card-eco">' + opening.eco + '</span>' +
                '<span class="opening-card-color">' + colorIcon + '</span>' +
              '</div>' +
              '<div class="opening-card-name">' + opening.name + '</div>' +
              '<div class="opening-card-desc">' + opening.description + '</div>' +
              '<div class="opening-card-bottom">' +
                '<span class="opening-card-stars">' + starsStr + '</span>' +
                '<span class="opening-card-diff ' + diff.cls + '">' +diff.text +
                '</span>' +
              '</div>' +
              lockHtml +
              attemptsHtml +
            '</div>';

        var $card = $(html);

        if (unlocked) {
            attachCardClick($card, port.id, index);
        }

        $('#port-panel-openings').append($card);
    }

    function attachCardClick($card, portId, openingIndex) {
        $card.on('click', function () {
            if (progress.currentPort !== portId) {
                animateShipToPort(portId, function () {
                    startOpeningTraining(portId, openingIndex);
                });
            } else {
                startOpeningTraining(portId, openingIndex);
            }
        });
    }

// ═══ Сброс прогресса (для отладки) ═══

    function resetProgress() {
        progress = createDefaultProgress();
        saveProgress();
        console.log('🗺️ Прогресс карты сброшен');
    }

    // ═══ Публичный API ═══

    return {
        openMap: openMap,
        closeMap: closeMap,
        recordResult: recordResult,

        isMapOpen: function () {
            return isMapOpen;
        },

        getProgress: function () {
            return progress;
        },

        getPorts: function () {
            return PORTS;
        },

        resetProgress: resetProgress,

        hasActiveOpening: function () {
            return !!VoyageMapEngine._activeOpening;
        },

        getActiveOpening: function () {
            return VoyageMapEngine._activeOpening;
        },

        _activeOpening: null
    };

})();

console.log('🗺️ VoyageMapEngine загружен');
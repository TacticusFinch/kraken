//============================================
// voyage.js — Система корабля, HP и Кракена
// BALANCED HARD — жёстко, но справедливо
// ============================================

const VoyageEngine = {

//===== СОСТОЯНИЕ =====
state: {
    maxHP: 4,
    currentHP: 4,
    voyageProgress: 0,
    totalExpectedMoves: 15,
    movesMade: 0,
    combo: 0,
    maxCombo: 0,
    repairPoints: 0,
    repairCost: 4,
    timesRepaired: 0,
    isGameOver: false,
    achievements: [],
    checkpointsReached: [],
    itemsCollected: [],
    activeShield: false,
    weather: 'calm',
    stormActive: false,
    _refutationCount: 0,
    _lastOpponentPopularity: 100,
    damageLog: [],
    leakTimer: 0,
    leakDamage: 0,
    comboPenalty: 0,
    criticalHitsReceived: 0,
    lastDamageMove: 0,
    hullBreached: false,
    baseRepairCost: 4,
    goodMovesInRow: 0,
},

// ===== ИНИЦИАЛИЗАЦИЯ =====
init(estimatedMoves) {
    estimatedMoves = estimatedMoves || 15;

    if (typeof SoundEngine !== 'undefined') {
        if (SoundEngine.stopWeatherSound) {
            SoundEngine.stopWeatherSound();
        }
    }

    // Также останавливаем молнии от предыдущего шторма
    this._stopLightning();

    this.state = {
        maxHP: 4,
        currentHP: 4,
        voyageProgress: 0,
        totalExpectedMoves: estimatedMoves,
        movesMade: 0,
        combo: 0,
        maxCombo: 0,
        repairPoints: 0,
        repairCost: 4,
        timesRepaired: 0,
        isGameOver: false,
        achievements: [],
        checkpointsReached: [],
        itemsCollected: [],
        activeShield: false,
        weather: 'calm',
        stormActive: false,
        _refutationCount: 0,
        _lastOpponentPopularity: 100,
        damageLog: [],
        leakTimer: 0,
        leakDamage: 0,
        comboPenalty: 0,
        criticalHitsReceived: 0,
        lastDamageMove: 0,
        hullBreached: false,
        baseRepairCost: 4,
        goodMovesInRow: 0,
    };

    console.log('%c⛵ VoyageEngine.init() [BALANCED HARD]', 'color: #ff6d00; font-weight: bold; font-size: 14px');
    console.log('⛵ Ожидаемых ходов:', estimatedMoves);
    console.log('⛵ HP:', this.state.currentHP + '/' + this.state.maxHP);
    console.log('⛵ Стоимость починки:', this.state.repairCost);
    console.log('─────────────────────────────────');

    this.renderHP();
    this.renderVoyage();
    this.renderRepairProgress();
    this.hideKraken();
    this.resetCheckpoints();
    this.updateWeatherDisplay();
},

// ===== ГЛАВНЫЙ МЕТОД: обработка хода игрока =====
processPlayerMove(moveData) {
    if (this.state.isGameOver) return null;

    this.state.movesMade++;

    // Течь тикает ПЕРЕД ходом
    this.processLeak();

    // Погода каждые 4 хода
    if (this.state.movesMade % 4 === 0) {
        this.rollWeather();
    }

    var result = this.evaluateMove(moveData);

    // Шторм УСИЛИВАЕТ урон от ошибок (не наносит сам)
    if (result.damage > 0 && this.state.stormActive) {
        var stormBonus = Math.ceil(result.damage * 0.5);
        result.damage += stormBonus;
        result.message += '\n🌧️ Шторм усилил удар! (+' + stormBonus + ')';
    }

    // Щит — снижает на 1, не блокирует полностью
    if (result.damage > 0 && this.state.activeShield) {
        result.damage = Math.max(1, result.damage - 1);this.state.activeShield = false;
        result.message += '\n⚓ Якорь смягчил удар! (-1)';
    }

    // Модификатор зоны — только на урон
    if (result.damage > 0) {
        var zoneMod = this.getZoneModifier();
        result.damage = Math.ceil(result.damage * zoneMod.damageMult);
    }

    // Погода влияет на починку
    var weatherMod = this.getWeatherModifier();
    if (result.repairPoints > 0) {
        result.repairPoints = Math.max(1, Math.floor(result.repairPoints * weatherMod.repairMult));
    }

    // Пробоина замедляет починку
    if (this.state.hullBreached && result.repairPoints > 0) {
        result.repairPoints = Math.max(1, Math.floor(result.repairPoints * 0.5));
        result.message += '\n🕳️ Пробоина замедляет починку!';
    }

    // Применяем урон
    if (result.damage > 0) {
        this.takeDamage(result.damage);this.state.goodMovesInRow =0;
    }

    // Применяем починку
    if (result.repairPoints > 0) {
        this.addRepairPoints(result.repairPoints);
    }

    // Комбо
    if (result.comboBreak) {
        this.breakCombo();
    } else if (result.comboAdd) {
        this.state.goodMovesInRow++;
        if (this.state.comboPenalty > 0) {
            this.state.comboPenalty--;
            if (this.state.comboPenalty === 0) {
                result.message += '\n🔧 Экипаж оправился.';
            } else {
                result.message += '\n😰 Деморализация... (ещё ' + this.state.comboPenalty + ')';
            }
        } else {
            this.addCombo();
        }
    } else {
        // inaccuracy — не ломает комбо, но сбрасывает goodMovesInRow
        this.state.goodMovesInRow = 0;
    }

    // Пробоина заживает после 6 хороших ходов подряд
    if (this.state.hullBreached && this.state.goodMovesInRow >= 6) {
        this.repairBreach();
        result.message += '\n🔧 Пробоина заделана упорной работой!';
    }

    this.advanceVoyage();
    this.checkAchievements(moveData, result);
    this.showMessage(result.message, result.type);

    if (this.state.currentHP <= 0) {
        this.gameOver('sunk');
    }

    return result;
},

// ===== ОЦЕНКА ХОДА =====
evaluateMove(moveData) {
    var result = {
        damage: 0,
        repairPoints: 0,
        comboBreak: false,
        comboAdd: false,
        message: '',
        type: 'neutral'
    };

    var cat = moveData.category;

    switch (cat) {
        case 'theory':
            result.repairPoints = 2;
            result.comboAdd = true;
            result.message = 'Теоретический ход. Корабль на верном курсе.';
            result.type = 'good';
            break;

        case 'good':
            result.repairPoints = 1;
            result.comboAdd = true;
            result.message = 'Хороший ход. Плывём дальше.';
            result.type = 'good';
            break;

        case 'inaccuracy':
            // Не даёт починку, неломает комбо, но1 урон
            result.damage = 1;
            result.comboBreak = false;
            result.comboAdd = false;
            result.message = 'Неточность! Кракен царапает борт.';
            result.type = 'warning';
            break;

        case 'mistake':
            result.damage = 2;
            result.comboBreak = true;
            result.message = '💥ОШИБКА! Кракен бьёт по обшивке!';
            result.type = 'bad';
            this.state.comboPenalty = Math.max(this.state.comboPenalty, 2);
            break;

        case 'blunder':
            result.damage = 3;
            result.comboBreak = true;
            result.isCritical = true;
            result.message = '🔥 ЗЕВОК! Кракен рвёт корпус!';
            result.type = 'terrible';
            this.inflictHullBreach(2);
            this.startLeak(3, 1);
            this.state.comboPenalty = Math.max(this.state.comboPenalty, 3);
            this.state.criticalHitsReceived++;
            // Теряем половину починки
            var lostRepair = Math.ceil(this.state.repairPoints * 0.5);
            if (lostRepair > 0) {
                this.state.repairPoints = Math.max(0, this.state.repairPoints - lostRepair);
                result.message += '\n🔨 Потеряно ' + lostRepair + ' очков починки!';
            }
            break;

        case 'grossBlunder':
            result.damage = 4;
            result.comboBreak = true;
            result.isCritical = true;
            result.message = '💀 ГРУБЫЙ ЗЕВОК! Кракен крушит борт!';
            result.type = 'terrible';
            this.inflictHullBreach(3);
            this.startLeak(2, 1);
            this.state.comboPenalty = Math.max(this.state.comboPenalty, 3);
            this.state.criticalHitsReceived++;
            // Полная потеря починки
            if (this.state.repairPoints > 0) {
                result.message += '\n🔨 Все очки починки уничтожены!';
                this.state.repairPoints = 0;
            }
            break;

        case 'catastrophe':
            result.damage = 5;
            result.comboBreak = true;
            result.isCritical = true;
            result.message = '☠️ КАТАСТРОФА! Кракен ТОПИТ корабль!';
            result.type = 'terrible';
            this.inflictHullBreach(3);
            this.startLeak(2, 2);
            this.state.comboPenalty = Math.max(this.state.comboPenalty, 4);
            this.state.repairPoints = 0;
            this.state.criticalHitsReceived++;
            if (this.state.maxHP > 2) {
                this.state.maxHP--;
                result.message += '\n💀 Макс HP снижен навсегда!';
            }
            break;
    }

    //===== БОНУСЫ =====

    // Опровержение ловушки
    var oppPop = moveData.opponentLastPopularity;
    if (oppPop !== undefined && oppPop < 15&&
        (cat === 'theory' || cat === 'good')) {
        result.repairPoints += 1;
        result.message += '\n🗡️ Ловушка опровергнута! +1 починки.';
        this.state._refutationCount++;
    }

    // Попался наловушку
    if (oppPop !== undefined && oppPop < 15 &&
        (cat === 'mistake' || cat === 'blunder' || cat === 'grossBlunder' || cat === 'catastrophe')) {
        result.damage += 1;
        result.message += '\n🪤Ловушка сработала! +1 урон!';
    }

    // Редкий ход
    var popRank = moveData.popularityRank || 99;
    if (popRank > 5&& (cat === 'theory' || cat === 'good')) {
        result.repairPoints += 1;
        result.message += '\n🧭 Нестандартный курс. +1 починки.';
    }

    // Комбо-бонус: каждые 6 ходов +1
    if (this.state.combo > 0 && this.state.combo % 6 === 0 && result.comboAdd) {
        result.repairPoints += 1;
        result.message += '\n🔥COMBO x' + this.state.combo + '! +1 починки.';
    }

    return result;
},

// ===== СИСТЕМА ПРОБОИН =====
inflictHullBreach(severity) {
    this.state.hullBreached = true;
    this.state.repairCost = Math.min(8, this.state.repairCost + severity);
    this.state.goodMovesInRow = 0;
    this.renderRepairProgress();
    console.log('⛵ 🕳️ ПРОБОИНА! Стоимость починки:', this.state.repairCost);
},

repairBreach() {
    this.state.hullBreached = false;
    // Стоимость снижается, но не до базовой — каждыйремонт оставляет след
    this.state.repairCost = Math.max(this.state.baseRepairCost, this.state.repairCost - 2);
    this.state.leakTimer = 0;
    this.state.leakDamage = 0;
    this.renderRepairProgress();
    console.log('⛵ 🔧 Пробоина заделана.');
},

// ===== СИСТЕМА ТЕЧИ =====
startLeak(turnsUntilDamage, damage) {
    if (this.state.leakTimer > 0) {
        // Усиливается
        this.state.leakDamage = Math.min(3, this.state.leakDamage + damage);
        this.state.leakTimer = Math.min(this.state.leakTimer, turnsUntilDamage);
    } else {
        this.state.leakTimer = turnsUntilDamage;
        this.state.leakDamage = damage;
    }
    console.log('⛵ 🌊 ТЕЧЬ! Через', this.state.leakTimer, 'ходов -' + this.state.leakDamage + ' HP');
},

processLeak() {
    if (this.state.leakTimer <= 0) return;
    this.state.leakTimer--;
    if (this.state.leakTimer <= 0 && this.state.leakDamage > 0) {
        var leakDmg = this.state.leakDamage;
        this.state.leakDamage = 0;
        this.takeDamage(leakDmg);
        this.showMessage('🌊 Течь прорвалась! -' + leakDmg + ' HP', 'terrible');
    }
},

// ===== ПОГОДА =====
rollWeather() {
    var roll = Math.random();
    var prevWeather = this.state.weather;

    if (roll < 0.25) {
        this.state.weather = 'calm';
        this.state.stormActive = false;
    } else if (roll < 0.50) {
        this.state.weather = 'wind';
        this.state.stormActive = false;
    } else if (roll < 0.75) {
        this.state.weather = 'fog';
        this.state.stormActive = false;
    } else {
        this.state.weather = 'storm';
        this.state.stormActive = true;
        this.showMessage('⛈️ ШТОРМ!Ошибки будут стоить дороже!', 'warning');
    }

    // Показываем переход погоды
    if (prevWeather !== this.state.weather) {
        this.animateWeatherTransition(prevWeather, this.state.weather);
    }

    this.updateWeatherDisplay();

    // Звук погоды
    if (typeof SoundEngine !== 'undefined' && SoundEngine.playWeatherSound) {
        SoundEngine.playWeatherSound(this.state.weather);

	        // Дополнительные звуковые акценты при смене
        if (prevWeather !== this.state.weather) {
            if (this.state.weather === 'wind') {
                SoundEngine.windGust && SoundEngine.windGust();
            } else if (this.state.weather === 'fog') {
                SoundEngine.fogHorn && SoundEngine.fogHorn();
            } else if (this.state.weather === 'storm') {
                SoundEngine.playThunder && SoundEngine.playThunder();
            }
        }
    }
},

// Анимация перехода между погодами
animateWeatherTransition(from, to) {
    var scene = document.querySelector('.sea-scene');
    if (!scene) return;

    // Добавляем класс перехода
    scene.classList.add('weather-transitioning');

    // Сообщения о смене погоды
    var transitions = {
        'calm_wind': '💨 Поднимается ветер...',
        'calm_fog': '🌫️ Туман наползает...',
        'calm_storm': '⛈️ Небо темнеет! Шторм!',
        'wind_calm': '☀️ Ветер стихает.',
        'wind_fog': '🌫️ Ветер принёс туман...',
        'wind_storm': '⛈️ Ветер крепчает! Шторм!',
        'fog_calm': '☀️ Туман рассеивается.',
        'fog_wind': '💨 Ветер разгоняет туман.',
        'fog_storm': '⛈️ Из тумана — в шторм!',
        'storm_calm': '☀️ Шторм прошёл. Штиль.',
        'storm_wind': '💨 Шторм ослабевает до ветра.',
        'storm_fog': '🌫️ После шторма — туман.'
    };

    var key = from + '_' + to;
    var msg = transitions[key];
    if (msg && to !== 'storm') { // Шторм уже показывает своё сообщение
        this.showMessage(msg, 'neutral');
    }

    setTimeout(function() {
        scene.classList.remove('weather-transitioning');
    }, 2000);
},

getWeatherModifier() {
    var mods = {
        calm:  { repairMult: 1.0, progressMult: 1.0 },
        wind:  { repairMult: 1.0, progressMult: 1.15 },
        fog:   { repairMult: 0.6, progressMult: 0.85 },
        storm: { repairMult: 0.3, progressMult: 0.7 }
    };
    return mods[this.state.weather] || mods.calm;
},

updateWeatherDisplay() {
    var weather = this.state.weather;
    var scene = document.querySelector('.sea-scene');
    var indicator = document.getElementById('weather-indicator');
    var iconEl = document.getElementById('weather-icon');
    var nameEl = document.getElementById('weather-name');

    // Убираем все погодные классы
    if (scene) {
        scene.classList.remove('weather-calm', 'weather-wind', 'weather-fog', 'weather-storm');
        scene.classList.add('weather-' + weather);
    }

    // Обновляем индикатор
    var weatherData = {
        calm:{ icon: '', name: 'Штиль' },
        wind:  { icon: '', name: 'Ветер' },
        fog:   { icon: '', name: 'Туман' },
        storm: { icon: '', name: 'ШТОРМ' }
    };

    var data = weatherData[weather] || weatherData.calm;

    if (iconEl) iconEl.textContent = data.icon;
    if (nameEl) {
        nameEl.textContent = data.name;
        nameEl.style.color = weather === 'storm' ? '#c62828' : '';nameEl.style.fontWeight = weather === 'storm' ? '700' : '600';
    }

    if (indicator) {
        if (this.state.movesMade > 0) {
            indicator.classList.add('visible');
        }}

    // Молния при шторме — случайные вспышки
    if (weather === 'storm') {
        this._startLightning();
    } else {
        this._stopLightning();
    }

    // Обновляем badge
    var badge = document.getElementById('opening-badge');
    if (badge && this.state.movesMade > 0) {
        // Убираем старую погоду из текста
        var text = badge.textContent.replace(/\s*[☀️💨🌫️⛈️🌧️]\s*\S*/g, '').trim();
        badge.textContent = text + ' ' + data.icon + ' ' + data.name;
    }
},

_lightningInterval: null,

_startLightning() {
    if (this._lightningInterval) return;
    var self = this;
    this._lightningInterval = setInterval(function() {
        var flash = document.querySelector('.lightning-flash');
        if (flash && self.state.weather === 'storm') {
            flash.style.animation = 'none';
            flash.offsetHeight; // reflow
            flash.style.animation = '';
        }
    }, 4000 + Math.random() * 5000);
},

_stopLightning() {
    if (this._lightningInterval) {
        clearInterval(this._lightningInterval);
        this._lightningInterval = null;
    }
},

// ===== ЗОНЫ =====
getZoneModifier() {
    var p = this.state.voyageProgress;
    if (p < 20) return { name: 'Прибрежные воды', damageMult: 0.8 };
    if (p < 50) return { name: 'Открытое море', damageMult: 1.0 };
    if (p < 75) return { name: 'Глубины Кракена', damageMult: 1.4 };
    return { name: 'Пасть бездны', damageMult: 1.8 };
},

// ===== УРОН =====
takeDamage(amount) {
    this.state.currentHP = Math.max(0, this.state.currentHP - amount);
    this.state.damageLog.push({ amount: amount, time: Date.now() });
    this.state.lastDamageMove = this.state.movesMade;

    this.renderHP();
    this.showKrakenAttack(amount);
    this.shakeScreen();
    this.shakeShip();

    if (typeof SoundEngine !== 'undefined') {
        if (amount >= 3) {
            SoundEngine.catastrophe && SoundEngine.catastrophe();
        } else if (amount >= 2) {
            SoundEngine.blunder && SoundEngine.blunder();
        }
    }
},

// ===== ПОЧИНКА =====
addRepairPoints(points) {
    this.state.repairPoints += points;

    while (this.state.repairPoints >= this.state.repairCost && this.state.currentHP < this.state.maxHP) {
        this.state.repairPoints -= this.state.repairCost;
        this.state.currentHP++;
        this.state.timesRepaired++;
        // Каждый ремонт делает следующий дороже
        this.state.repairCost = Math.min(8, this.state.baseRepairCost + this.state.timesRepaired);
        this.showRepairEffect();
        console.log('⛵ 💚 +1 HP! Следующий ремонт стоит:', this.state.repairCost);

        if (typeof SoundEngine !== 'undefined' && SoundEngine.comboUp) {
            SoundEngine.comboUp(3);
        }
    }

    this.renderHP();
    this.renderRepairProgress();
},

// ===== КОМБО =====
addCombo() {
    this.state.combo++;
    this.state.maxCombo = Math.max(this.state.maxCombo, this.state.combo);
    console.log('⛵ 🔥 Комбо: ' + this.state.combo);
},

breakCombo() {
    if (this.state.combo >= 4) {
        this.showMessage('💔 Комбо x' + this.state.combo + ' прервано!', 'bad');}
    this.state.combo = 0;
},

// ===== ПРОДВИЖЕНИЕ =====
advanceVoyage() {
    var progressPerMove = 100 / this.state.totalExpectedMoves;

    // Комбо: +4% за каждый ход в серии
    var comboBonus = 1+ (this.state.combo * 0.04);

    // Пробоина замедляет
    var breachPenalty = this.state.hullBreached ? 0.65 : 1.0;

    // Погода
    var weatherMod = this.getWeatherModifier();
    var weatherBonus = weatherMod.progressMult || 1.0;

    // Критическое HP
    var hpPenalty = 1.0;
    if (this.state.currentHP ===1) hpPenalty = 0.6;
    else if (this.state.currentHP === 2) hpPenalty = 0.8;

    this.state.voyageProgress = Math.min(
        100,
        this.state.voyageProgress + (progressPerMove * comboBonus * weatherBonus * breachPenalty * hpPenalty)
    );

    this.renderVoyage();
    this.checkCheckpoints();

    if (this.state.voyageProgress >= 100 && !this.state.isGameOver) {
        this.gameOver('victory');
    }
},

// ===== ЧЕКПОИНТЫ =====
checkCheckpoints() {
    var thresholds = [25, 50, 75, 100];
    var self = this;

    thresholds.forEach(function(threshold, index) {
        if (self.state.voyageProgress >= threshold &&
            self.state.checkpointsReached.indexOf(threshold) === -1) {

            self.state.checkpointsReached.push(threshold);
            self.markCheckpointReached(index);

            if (threshold< 100) {
                self.giveCheckpointReward(threshold);
            }
        }
    });
},

markCheckpointReached(index) {
    var checkpoints = document.querySelectorAll('.checkpoint');
    if (checkpoints[index]) {
        checkpoints[index].classList.add('reached');
    }
},

resetCheckpoints() {
    var checkpoints = document.querySelectorAll('.checkpoint');
    checkpoints.forEach(function(cp) {
        cp.classList.remove('reached');
    });
},

giveCheckpointReward(threshold) {
    var rewards = {
        25: { id: 'rope', name: '🪢 Верёвка', desc: 'Течь замедлена на 2 хода', action: 'slowleak' },
        50: { id: 'anchor', name: '⚓ Якорь', desc: 'Следующий удар ослаблен на 1', action: 'shield' },
        75: { id: 'tar', name: '🛢️ Смола', desc: 'Пробоина заделана, стоимость -2', action: 'patch' }
    };

    var reward = rewards[threshold];
    if (!reward) return;

    this.state.itemsCollected.push(reward.id);

    switch (reward.action) {
        case 'slowleak':
            if (this.state.leakTimer > 0) {
                this.state.leakTimer += 2;
            }
            break;
        case 'shield':
            this.state.activeShield = true;
            break;
        case 'patch':
            this.repairBreach();
            break;
    }

    this.showAchievement(reward.name.split(' ')[0], reward.name.slice(2), reward.desc);
},

// ===== ДОСТИЖЕНИЯ =====
checkAchievements(moveData, result) {
    var a = this.state.achievements;

    if (moveData.category === 'theory' &&
        a.indexOf('first_blood') === -1 && this.state.movesMade <= 2) {
        a.push('first_blood');
        this.showAchievement('🎯', 'Первая кровь', 'Точный дебют.');
    }

    if (this.state.currentHP === this.state.maxHP &&
        this.state.damageLog.length >= 3 &&
        a.indexOf('unsinkable') === -1) {
        a.push('unsinkable');
        this.showAchievement('🛡️', 'Непотопляемый', 'Полный корпус после шторма!');
    }

    if (this.state._refutationCount >= 3 && a.indexOf('kraken_slayer') === -1) {
        a.push('kraken_slayer');
        this.showAchievement('⚔️', 'Кракеноборец', '3ловушки опровергнуты.');
    }

    if (this.state.combo >= 10 && a.indexOf('navigator') === -1) {
        a.push('navigator');
        this.showAchievement('🧭', 'Sail!', '10 точных ходов подряд!');
	const sailSound = new Audio('sound/sail.mp3');
        sailSound.play().catch(e => console.log("Ошибка воспроизведения:", e));
    }

    if (moveData.popularityRank > 5 &&
        (moveData.category === 'theory' || moveData.category === 'good') &&
        a.indexOf('explorer') === -1) {
        a.push('explorer');
        this.showAchievement('🗺️', 'Исследователь', 'Редкий верный курс.');
    }

    if (this.state.currentHP === 1 && this.state.damageLog.length >= 4 &&
        a.indexOf('survivor') === -1) {
        a.push('survivor');
        this.showAchievement('💪', 'Живучий', 'На волоске от гибели!');
    }
},

// ===== КОНЕЦ ИГРЫ =====
gameOver(reason) {
    if (this.state.isGameOver) return;
    this.state.isGameOver = true;

    // Визуальные эффекты без окна
    if (reason === 'sunk') {
        var ship = document.getElementById('ship');
        if (ship) ship.classList.add('sinking');
    }

    // НЕ показываем отдельное окно — всё покажет showSessionResults()
    console.log('⛵ Game over:', reason);
},

// ===== РЕНДЕРИНГ =====

renderHP() {
    var hp = this.state.currentHP;
    var max = this.state.maxHP;

    for (var i = 1; i <= 4; i++) {
        var seg = document.getElementById('hull-' + i);
        if (!seg) continue;

        seg.className = 'hull-segment';

        if (i > max) {
            seg.classList.add('destroyed');
            seg.style.opacity = '0.3';
        } else if (i <= hp) {
            if (hp <= 1) {
                seg.classList.add('critical');
            } else if (hp <= 2) {
                seg.classList.add('warning');
            } else {
                seg.classList.add('active');
            }
        } else {
            seg.classList.add('destroyed');
        }
    }

    var hullText = document.getElementById('hull-text');
    if (hullText) {
        hullText.textContent = hp + ' / ' + max;
        hullText.style.color = hp <= 1 ? '#f44336' : hp <= 2 ? '#ff9800' : '#4caf50';
    }

    var scene = document.getElementById('sea-scene');
    if (scene) {
        scene.classList.remove('hp-critical', 'hp-warning');
        if (hp <= 1) scene.classList.add('hp-critical');
        else if (hp <= 2) scene.classList.add('hp-warning');
    }
},

renderVoyage() {
    var fill = document.getElementById('voyage-fill');
    if (fill) {
        fill.style.width = this.state.voyageProgress + '%';
    }
},

renderRepairProgress() {
    var fill = document.getElementById('repair-fill');
    var text = document.getElementById('repair-text');

    if (fill) {
        var pct = (this.state.repairPoints / this.state.repairCost) * 100;
        fill.style.width = Math.min(100, pct) + '%';}if (text) {
        text.textContent = this.state.repairPoints + ' / ' + this.state.repairCost;
    }
},

// ===== ВИЗУАЛЬНЫЕ ЭФФЕКТЫ =====

showKrakenAttack(intensity) {
    var severity = 'mistake';
    if (intensity >= 4) {
        severity = 'catastrophe';
    } else if (intensity >= 3) {
        severity = 'blunder';
    } else if (intensity >= 2) {
        severity = 'mistake';
    }

    if (typeof SoundEngine !== 'undefined' && SoundEngine.krakenAttack) {
        var vol = Math.min(1.0, 0.4 + intensity * 0.15);
        SoundEngine.krakenAttack(vol);
    }

    if (typeof KrakenSprite !== 'undefined' && KrakenSprite.sprite) {
        KrakenSprite.play(severity);
    } else {
        var kraken = document.getElementById('kraken-attack');
        if (!kraken) return;

        kraken.classList.remove('hidden');
        kraken.classList.add('active');

        setTimeout(function() {
            kraken.classList.remove('active');
            kraken.classList.add('hidden');
        }, 2500);
    }
},

hideKraken() {
    var kraken = document.getElementById('kraken-attack');
    if (kraken) {
        kraken.classList.remove('visible');
        kraken.classList.add('hidden');
    }
},

shakeScreen() {
    document.body.classList.add('screen-shake');
    setTimeout(function() {
        document.body.classList.remove('screen-shake');
    }, 400);
},

shakeShip() {
    var ship = document.getElementById('ship');
    if (ship) {
        ship.classList.add('damaged');
        setTimeout(function() {
            ship.classList.remove('damaged');
        }, 600);
    }
},

showRepairEffect() {
    var ship = document.getElementById('ship');
    if (!ship) return;

    var flash = document.createElement('div');
    flash.className = 'repair-flash';
    ship.appendChild(flash);
    setTimeout(function() { flash.remove(); }, 800);
},

showAchievement(icon, title, desc) {
    var container = document.getElementById('achievement-container');
    if (!container) container = document.body;

    var toast = document.createElement('div');
    toast.className = 'achievement-toast';
    toast.innerHTML =
        '<span class="achievement-icon">' + icon + '</span>' +
        '<div>' +
        '<div class="achievement-title">' + title + '</div>' +
        '<div class="achievement-desc">' + desc + '</div>' +
        '</div>';
    container.appendChild(toast);

    requestAnimationFrame(function() {
        toast.classList.add('show');
    });
    setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() { toast.remove(); }, 500);
    }, 3000);
},

showMessage(text, type) {
    var msgEl = document.getElementById('kraken-message');
    if (msgEl) {
        msgEl.innerHTML = text.replace(/\n/g, '<br>');
        msgEl.className = 'kraken-message msg-' + type;
    }
},


showVictoryScreen() {
    var s = this.state;
    var stars = s.currentHP === s.maxHP ? 3 : s.currentHP >=3 ? 2 : 1;
    var starIcons = '⭐'.repeat(stars) + '☆'.repeat(3 - stars);

    var achieveHtml = '';
    if (s.achievements.length > 0) {
        achieveHtml = '<div class="game-over-achievements">';
        var iconMap = {
            first_blood: '🎯', unsinkable: '🛡️', kraken_slayer: '⚔️',
            navigator: '🧭', explorer: '🗺️', survivor: '💪'
        };
        s.achievements.forEach(function(a) {
            achieveHtml += '<span class="achievement-badge">' + (iconMap[a] || '🏆') + '</span>';
        });
        achieveHtml += '</div>';
    }

    var itemsHtml = '';
    if (s.itemsCollected.length > 0) {
        var itemIcons = { rope: '🪢', anchor: '⚓', tar: '🛢️' };
        itemsHtml = '<div class="game-over-items">';
        s.itemsCollected.forEach(function(item) {
            itemsHtml += '<span class="item-badge">' + (itemIcons[item] || '📦') + '</span>';
        });
        itemsHtml += '</div>';
    }

    var weatherLog = '';
    if (s.weather !== 'calm') {
        var weatherNames = { calm: '☀️ Штиль', wind: '💨 Ветер', fog: '🌫️ Туман', storm: '🌧️ Шторм' };
        weatherLog = '<div class="voyage-stat-row">' +
            '<span class="voyage-stat-icon">🌤️</span>' +
            '<span class="voyage-stat-label">Последняя погода</span>' +
            '<span class="voyage-stat-value">' + (weatherNames[s.weather] || '☀️') + '</span>' +
            '</div>';
    }

    var overlay = document.getElementById('voyage-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'voyage-overlay';
        document.body.appendChild(overlay);
    }

    overlay.className = 'game-over-overlay victory show';
    overlay.innerHTML =
        '<div class="game-over-card newspaper-style">' +
            '<div class="newspaper-header">' +
                '<div class="newspaper-meta">Экстренный выпуск • №' + s.movesMade + '</div>' +
                '<h1 class="newspaper-brand">ВЕСТНИК ГАВАНИ</h1>' +
            '</div>' +
            '<div class="newspaper-divider-thick"></div>' +
            '<div class="game-over-stars">' + starIcons + '</div>' +
            '<h2 class="game-over-title">КРАКЕН ПОВЕРЖЕН: КОРАБЛЬ В ПОРТУ!</h2>' +
            '<div class="newspaper-main-content">' +
                '<p class="game-over-subtitle">' +
                    'Сегодня на рассвете судно под вашим командованием бросило якорь в родной бухте. ' +
                    'Несмотря на яростный шторм и козни бездны, экипаж празднует победу.' +
                '</p>' +
                '<div class="newspaper-divider-thin"></div>' +
                '<div class="game-over-stats">' +
                    '<div class="voyage-stat-row">' +
                        '<span class="voyage-stat-label">Продолжительность похода</span>' +
                        '<span class="voyage-stat-value">' + s.movesMade + ' дн.</span>' +
                    '</div>' +
                    '<div class="voyage-stat-row">' +
                        '<span class="voyage-stat-label">Боевой дух (Макс. комбо)</span>' +
                        '<span class="voyage-stat-value">x' + s.maxCombo + '</span>' +
                    '</div>' +
                    '<div class="voyage-stat-row">' +
                        '<span class="voyage-stat-label">Состояние обшивки</span>' +
                        '<span class="voyage-stat-value">' + s.currentHP + '/' + s.maxHP + '</span>' +
                    '</div>' +
                    '<div class="voyage-stat-row">' +
                        '<span class="voyage-stat-label">Ремонтов проведено</span>' +
                        '<span class="voyage-stat-value">' + s.timesRepaired + '</span>' +
                    '</div>' +
                    
                    weatherLog +
                '</div>' +
                '<div class="newspaper-divider-thin"></div>' +
                achieveHtml +
                itemsHtml +
            '</div>' +
            '<div class="game-over-buttons">' +
                '<button class="btn-newspaper-main" onclick="VoyageEngine.closeOverlay(); startGame();">НОВЫЙ ПОХОД</button>' +
                '<button class="btn-newspaper-sub" onclick="VoyageEngine.closeOverlay();">АРХИВ</button>' +
            '</div>' +
        '</div>';

    requestAnimationFrame(function() {
        overlay.classList.add('show');
    });

    if (typeof SoundEngine !== 'undefined' && SoundEngine.gameEnd) {
        SoundEngine.gameEnd();
    }
},


showDefeatScreen() {
    var s = this.state;

    var tips = [
        'Неточность =1 урон. Ошибка = 2 + деморализация. Зевок = 3 + течь + пробоина.',
        'Починка стоит 4 очка и дорожает. Теория = 2, хороший = 1. Считайте.',
        'После50% пути урон x1.4, после 75% — x1.8. Берегите HP.',
        'Шторм не бьёт сам, но усиливает ошибки на 50%. Не зевайте в шторм.',
        'Пробоина заживает за 6 хороших ходов подряд. Одна неточность — счётчик сброшен.',
        'Комбо x6 = +1 починки. Стабильность важнее гениальности.',
        'Катастрофа снижает макс HP навсегда. Это невозможно починить.',
        'Течь от зевка = отложенный урон. Два зевка = двойная течь.'
    ];
    var tip = tips[Math.floor(Math.random() * tips.length)];

    var overlay = document.getElementById('voyage-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'voyage-overlay';
        document.body.appendChild(overlay);
    }

    overlay.className = 'game-over-overlay defeat';
    overlay.innerHTML =
        '<div class="game-over-card newspaper-style">' +
            '<div class="newspaper-meta">МОРСКОЙ ВЕСТНИК • СРОЧНОЕ СООБЩЕНИЕ!</div>' +
            '<img src="animation/krakenwin.gif" class="game-over-kraken-img" alt="Кракен атакует">' +
            '<h2 class="game-over-title">Кракен потопил корабль!</h2>' +
            '<div class="newspaper-divider-thin"></div>' +
            '<p class="game-over-subtitle" style="font-family: Georgia, serif; font-style: italic; font-size: 0.95rem; color: #333; margin-bottom: 16px;">' +
                'Судно потеряно на отметке ' + Math.round(s.voyageProgress) + '% маршрута. ' +
                'Критических ударов: ' + s.criticalHitsReceived +
            '</p>' +
            '<div class="game-over-stats" style="border-top: 1px solid #1a1a1a; border-bottom: 1px solid #1a1a1a; padding: 12px 0; margin: 16px 0;">' +
                '<div class="voyage-stat-row">' +
                    '<span class="voyage-stat-icon">🧭</span>' +
                    '<span class="voyage-stat-label">Ходов сделано</span>' +
                    '<span class="voyage-stat-value" style="font-weight: 700;">' + s.movesMade + '</span>' +
                '</div>' +
                '<div class="voyage-stat-row">' +
                    '<span class="voyage-stat-icon">🔥</span>' +
                    '<span class="voyage-stat-label">Макс. комбо</span>' +
                    '<span class="voyage-stat-value" style="font-weight: 700;">x' + s.maxCombo + '</span>' +
                '</div>' +
                '<div class="voyage-stat-row">' +
                    '<span class="voyage-stat-icon">📍</span>' +
                    '<span class="voyage-stat-label">Прогресс</span>' +
                    '<span class="voyage-stat-value" style="font-weight: 700;">' + Math.round(s.voyageProgress) + '%</span>' +
                '</div>' +
                '<div class="voyage-stat-row">' +
                    '<span class="voyage-stat-icon">💀</span>' +
                    '<span class="voyage-stat-label">Критических ударов</span>' +
                    '<span class="voyage-stat-value" style="font-weight: 700;">' + s.criticalHitsReceived + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="defeat-tip" style="font-family: Georgia, serif; font-style: italic; font-size: 0.85rem; color: #444; border-left: 3px solid #1a1a1a; padding: 10px 14px; margin: 18px 0; text-align: left;">' +
                '<span>💀</span> ' +
                '<span>' + tip + '</span>' +
            '</div>' +
            '<div class="newspaper-divider-thin"></div>' +
            '<div class="game-over-buttons" style="display: flex; gap: 12px; margin-top: 20px;">' +
                '<button class="btn-newspaper-main" onclick="VoyageEngine.closeOverlay(); startGame();">🚀 Попробовать снова</button>' +
                '<button class="btn-newspaper-sub" onclick="VoyageEngine.closeOverlay();">Закрыть</button>' +
            '</div>' +
        '</div>';

    requestAnimationFrame(function() {
        overlay.classList.add('show');
    });

    if (typeof SoundEngine !== 'undefined' && SoundEngine.gameEnd) {
        SoundEngine.gameEnd();
    }
},

closeOverlay() {
    var overlay = document.getElementById('voyage-overlay');
    if (overlay) {
        overlay.classList.remove('show');
        setTimeout(function() {
            overlay.className = '';overlay.innerHTML = '';
        }, 500);
    }
},

//===== ВСПОМОГАТЕЛЬНЫЕ =====

setOpponentMovePopularity(percent) {
    this.state._lastOpponentPopularity = percent;
},

getOpponentLastPopularity() {
    return this.state._lastOpponentPopularity;
},

getStats() {
    return {
        hp: this.state.currentHP,
        maxHP: this.state.maxHP,
        progress: this.state.voyageProgress,
        combo: this.state.maxCombo,
        timesRepaired: this.state.timesRepaired,
        achievements: this.state.achievements.slice(),
        items: this.state.itemsCollected.slice(),
        damageTotal: this.state.damageLog.reduce(function(sum, d) { return sum + d.amount; }, 0),
        criticalHits: this.state.criticalHitsReceived,
        isVictory: this.state.voyageProgress >= 100 && this.state.currentHP > 0,
        isSunk: this.state.currentHP <= 0
    };
}

}; // === КОНЕЦ VoyageEngine ===


// ============================================
// KrakenSprite — Спрайтовая анимация атаки
// ============================================

const KrakenSprite = {
    container: null,
    sprite: null,
    shipEl: null,
    isPlaying: false,

    init() {
        this.container = document.getElementById('kraken-attack');
        this.sprite = document.getElementById('kraken-sprite');
        this.shipEl = document.getElementById('ship');
    },

    play(severity) {
        severity = severity || 'mistake';
        if (this.isPlaying) return;
        if (!this.sprite || !this.container) {
        console.warn('KrakenSprite: элементы не найдены!');
        return;
    }

	console.log('Kraken attack!', severity);
    	console.log('Sprite size:', this.sprite.offsetWidth, this.sprite.offsetHeight);
    	console.log('Container visible:', !this.container.classList.contains('hidden'));
        this.isPlaying = true;

        this.scaleToShip(severity);
        this.positionOverShip();

        this.sprite.classList.remove('blunder');
        if (severity === 'blunder' || severity === 'grossBlunder' || severity === 'catastrophe') {
            this.sprite.classList.add('blunder');
        }

        this.sprite.style.animation = 'none';
        this.sprite.offsetHeight;
        this.sprite.style.animation = '';

        this.container.classList.remove('hidden');
        this.container.classList.add('active');

        var shipBob = document.querySelector('.ship-bob');
        if (shipBob) {
            shipBob.classList.add('under-attack');
        }

        var vignette = document.getElementById('damage-vignette');
        if (vignette) {
            vignette.classList.add('active');
        }

        var seaScene = document.querySelector('.sea-scene');
        if (seaScene) {
            seaScene.classList.add('under-attack');
        }

        var duration;
        switch (severity) {
            case 'catastrophe': duration = 5000; break;
            case 'grossBlunder': duration = 3500; break;
            case 'blunder': duration = 3200; break;
            default: duration = 3000; break;
        }

        var self = this;
        setTimeout(function() {
            self.hide();
        }, duration);
    },

    scaleToShip(severity) {
        var ship = this.shipEl;
        if (!ship) {
            this.sprite.style.width = '100px';
            this.sprite.style.height = '100px';
            return;
        }

        var shipRect = ship.getBoundingClientRect();
        var shipSize = Math.max(shipRect.width, shipRect.height);

        if (shipSize < 10) shipSize = 80;

        var scale;
        switch (severity) {
            case 'catastrophe': scale = 1.5; break;
            case 'grossBlunder': scale = 1.3; break;
            case 'blunder':scale = 1.2; break;
            case 'mistake':      scale = 1.0; break;
            default:             scale = 1.2; break;
        }

        var spriteSize = Math.round(shipSize * scale);
        this.sprite.style.width = spriteSize + 'px';
        this.sprite.style.height = spriteSize + 'px';
    },

   positionOverShip() {
    if (!this.shipEl || !this.sprite) return;

    var ship = this.shipEl;
    var scene = document.querySelector('.sea-scene');
    if (!ship || !scene) return;

    var shipRect = ship.getBoundingClientRect();
    var sceneRect = scene.getBoundingClientRect();

    // Центр корабля по X относительно сцены
    var shipCenterX = shipRect.left + shipRect.width / 2 - sceneRect.left;
    var percentX = (shipCenterX / sceneRect.width) * 100;

    // Низ корабля — кракен атакует СНИЗУ
    var shipBottomY = shipRect.bottom - sceneRect.top;

    this.sprite.style.left = percentX + '%';
    this.sprite.style.bottom = (sceneRect.height - shipBottomY + 5) + 'px';
    this.sprite.style.top = 'auto';
    this.sprite.style.transform = 'translateX(-50%)'; /* только центровка по X */
    this.sprite.classList.add('positioned');
},

    hide() {
        this.container.classList.remove('active');
        this.container.classList.add('hidden');

        var shipBob = document.querySelector('.ship-bob');
        if (shipBob) {
            shipBob.classList.remove('under-attack');
        }

        var vignette = document.getElementById('damage-vignette');
        if (vignette) {
            vignette.classList.remove('active');
        }

        var seaScene = document.querySelector('.sea-scene');
        if (seaScene) {
            seaScene.classList.remove('under-attack');
        }

        this.sprite.classList.remove('positioned', 'blunder');
        this.isPlaying = false;
    }
};

document.addEventListener('DOMContentLoaded', function() {
    KrakenSprite.init();
});


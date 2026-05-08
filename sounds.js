//============================================
// Kraken Sound System — генерация звуков через Web Audio API
// Не требует внешних файлов
// ============================================

const SoundEngine = (function () {
    let ctx = null;
    let enabled = true;
    let volume = 0.4;

    function getCtx() {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (ctx.state === 'suspended') {
            ctx.resume();
        }
        return ctx;
    }

    function playTone(freq, duration, type, vol, ramp) {
        if (!enabled) return;
        try {
            const c = getCtx();
            const osc = c.createOscillator();
            const gain = c.createGain();
            osc.type = type || 'sine';
            osc.frequency.setValueAtTime(freq, c.currentTime);
            gain.gain.setValueAtTime((vol || 1) * volume, c.currentTime);
            if (ramp !== false) {
                gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
            }
            osc.connect(gain);
            gain.connect(c.destination);
            osc.start(c.currentTime);
            osc.stop(c.currentTime + duration);
        } catch (e) {
            console.warn('Sound error:', e);
        }
    }

    function playNoise(duration, vol) {
        if (!enabled) return;
        try {
            const c = getCtx();
            const bufferSize = c.sampleRate * duration;
            const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = (Math.random() * 2 - 1) * 0.3;
            }
            const source = c.createBufferSource();
            source.buffer = buffer;
            const gain = c.createGain();
            gain.gain.setValueAtTime((vol || 0.3) * volume, c.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
            const filter = c.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = 800;
            source.connect(filter);
            filter.connect(gain);
            gain.connect(c.destination);
            source.start();
        } catch (e) {
            console.warn('Noise error:', e);
        }
    }

    //── Звуки ходов ──

    function moveNormal() {
        playNoise(0.08, 0.5);
        playTone(400, 0.06, 'triangle', 0.3);
    }

    function moveCapture() {
        playNoise(0.12, 0.7);
        playTone(250, 0.1, 'sawtooth', 0.25);
        setTimeout(() => playTone(180, 0.08, 'triangle', 0.15), 30);
    }

    function moveCheck() {
        playTone(600, 0.12, 'square', 0.2);
        setTimeout(() => playTone(800, 0.15, 'square', 0.25), 80);
    }

    function moveCastle() {
        playNoise(0.06, 0.4);
        setTimeout(() => playNoise(0.06, 0.5), 100);
        playTone(350, 0.08, 'triangle', 0.2);
    }

    function movePromotion() {
        playTone(400, 0.15, 'sine', 0.2);
        setTimeout(() => playTone(500, 0.15, 'sine', 0.2), 60);
        setTimeout(() => playTone(650, 0.2, 'sine', 0.25), 120);
    }

    function comboUp(level) {
        const baseFreq = 500 + (level || 3) * 40;
        playTone(baseFreq, 0.1, 'sine', 0.2);
        setTimeout(() => playTone(baseFreq * 1.25, 0.15, 'sine', 0.25), 70);
    }

    function comboBreak() {
        playTone(400, 0.15, 'sine', 0.2);
        setTimeout(() => playTone(280, 0.2, 'sine', 0.2), 100);
        setTimeout(() => playTone(200, 0.25, 'triangle', 0.15), 200);
    }

    function blunder() {
        playTone(150, 0.3, 'sawtooth', 0.2);
        setTimeout(() => playTone(120, 0.4, 'sawtooth', 0.15), 100);
    }

    function catastrophe() {
        playTone(80, 0.5, 'sawtooth', 0.3);
        setTimeout(() => playTone(60, 0.6, 'sawtooth', 0.25), 150);
        setTimeout(() => playNoise(0.3, 0.4), 200);
    }

    function gameStart() {
        playTone(330, 0.15, 'sine', 0.15);
        setTimeout(() => playTone(415, 0.15, 'sine', 0.15), 80);
        setTimeout(() => playTone(523, 0.2, 'sine', 0.2), 160);
        setTimeout(() => playTone(660, 0.25, 'sine', 0.2), 240);
    }

    function gameEnd() {
        playTone(523, 0.2, 'sine', 0.15);
        setTimeout(() => playTone(415, 0.2, 'sine', 0.15), 120);
        setTimeout(() => playTone(330, 0.3, 'sine', 0.2), 240);
    }

    function ratingUp() {
        playTone(523, 0.1, 'sine', 0.2);
        setTimeout(() => playTone(659, 0.1, 'sine', 0.2), 80);
        setTimeout(() => playTone(784, 0.2, 'sine', 0.25), 160);
    }

    function ratingDown() {
        playTone(400, 0.15, 'sine', 0.15);
        setTimeout(() => playTone(320, 0.15, 'sine', 0.15), 100);
        setTimeout(() => playTone(260, 0.25, 'sine', 0.2), 200);
    }

    function illegal() {
        playTone(150, 0.1, 'square', 0.15);
    }

    // ═══ ЗВУК АТАКИ КРАКЕНА (MP3 файл) ═══
    let krakenAudio = null;
    let krakenAudioLoaded = false;

    function krakenAttack(intensityVolume) {
        if (!enabled) return;
        const vol = Math.min(1.0, Math.max(0.2, intensityVolume || 0.6)) * volume * 2;
        try {
            if (!krakenAudio) {
                krakenAudio = new Audio('sound/kraken-attack.mp3');
                krakenAudio.preload = 'auto';
                krakenAudio.addEventListener('canplaythrough', function () {
                    krakenAudioLoaded = true;
                });
            }
            krakenAudio.volume = Math.min(1, vol);
            krakenAudio.currentTime = 0;
            krakenAudio.play().catch(function (e) {
                console.warn('Kraken sound blocked:', e);
                krakenAttackSynth(intensityVolume);
            });
        } catch (e) {
            console.warn('Kraken audio error:', e);
            krakenAttackSynth(intensityVolume);
        }
    }

    function krakenAttackSynth(intensityVolume) {
        const vol = (intensityVolume || 0.6) * 0.8;
        playTone(55, 0.8, 'sawtooth', vol * 0.4);
        setTimeout(() => playTone(45, 1.0, 'sawtooth', vol * 0.35), 100);
        setTimeout(() => playNoise(0.4, vol * 0.6), 200);setTimeout(() => playTone(90, 0.5, 'square', vol * 0.2), 350);
        setTimeout(() => playTone(70, 0.6, 'sawtooth', vol * 0.25), 500);
    }

    function preloadKraken() {
        if (!krakenAudio) {
            krakenAudio = new Audio('sound/kraken-attack.mp3');
            krakenAudio.preload = 'auto';
            krakenAudio.volume = 0;
            krakenAudio.play().then(() => {
                krakenAudio.pause();
                krakenAudio.currentTime = 0;
                krakenAudioLoaded = true;
            }).catch(() => {});
        }
    }

    // ═══ ЗВУКИ ПОГОДЫ ═══
    let weatherSource = null;
    let weatherGain = null;
    let currentWeatherType = null;

    function playWeatherSound(weather) {
        if (!enabled) return;

        // Если погода не изменилась — не перезапускаем
        if (weather === currentWeatherType) return;
        currentWeatherType = weather;

        // Останавливаем предыдущий звук погоды
        stopWeatherSound();

        // Штиль — тишина
        if (weather === 'calm') return;

        try {
            const c = getCtx();

            // Создаём белый шум (4 секунды loop)
            const bufferSize = c.sampleRate * 4;
            const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
            const data = buffer.getChannelData(0);

            for (let i = 0; i < bufferSize; i++) {
                data[i] = (Math.random() * 2 - 1);
            }

            weatherSource = c.createBufferSource();
            weatherSource.buffer = buffer;
            weatherSource.loop = true;

            // Фильтр — разная погода = разный тембр
            const filter = c.createBiquadFilter();
            weatherGain = c.createGain();

            switch (weather) {
                case 'wind':
                    filter.type = 'bandpass';
                    filter.frequency.value = 300;
                    filter.Q.value = 0.5;
                    weatherGain.gain.setValueAtTime(0, c.currentTime);
                    weatherGain.gain.linearRampToValueAtTime(0.04 * volume, c.currentTime + 2);
                    break;

                case 'fog':
                    filter.type = 'lowpass';
                    filter.frequency.value = 150;
                    filter.Q.value = 1;
                    weatherGain.gain.setValueAtTime(0, c.currentTime);
                    weatherGain.gain.linearRampToValueAtTime(0.02 * volume, c.currentTime + 3);
                    break;

                case 'storm':
                    filter.type = 'lowpass';
                    filter.frequency.value = 600;
                    filter.Q.value = 0.3;
                    weatherGain.gain.setValueAtTime(0, c.currentTime);
                    weatherGain.gain.linearRampToValueAtTime(0.08 * volume, c.currentTime + 1.5);
                    break;

                default:
                    return;
            }

            weatherSource.connect(filter);
            filter.connect(weatherGain);
            weatherGain.connect(c.destination);
            weatherSource.start();

            // Для шторма — добавляем периодические раскаты грома
            if (weather === 'storm') {
                startThunderLoop();
            }

        } catch (e) {
            console.warn('Weather sound error:', e);
        }
    }

    function stopWeatherSound() {
        try {
            if (weatherSource) {
                weatherSource.stop();
                weatherSource.disconnect();
                weatherSource = null;
            }
            if (weatherGain) {
                weatherGain.disconnect();
                weatherGain = null;
            }
        } catch (e) {}
        stopThunderLoop();currentWeatherType = null;
    }

    // Раскаты грома при шторме
    let thunderInterval = null;

    function startThunderLoop() {
        stopThunderLoop();
        scheduleNextThunder();
    }

    function scheduleNextThunder() {
        const delay = 4000 + Math.random() * 4000;
        thunderInterval = setTimeout(function () {
            if (!enabled || currentWeatherType !== 'storm') {
                stopThunderLoop();
                return;
            }
            if (Math.random() < 0.6) {
                playThunder();
            }
            scheduleNextThunder();
        }, delay);
    }

    function stopThunderLoop() {
        if (thunderInterval) {
            clearTimeout(thunderInterval);
            thunderInterval = null;
        }
    }

    function playThunder() {
        if (!enabled) return;
        try {
            const c = getCtx();

            // Низкочастотный раскат
            const osc = c.createOscillator();
            const gain = c.createGain();
            const filter = c.createBiquadFilter();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(40 + Math.random() * 30, c.currentTime);
            osc.frequency.exponentialRampToValueAtTime(20, c.currentTime + 1.5);

            filter.type = 'lowpass';
            filter.frequency.value = 100;

            const thunderVol = (0.1 + Math.random() * 0.15) * volume;
            gain.gain.setValueAtTime(0, c.currentTime);
            gain.gain.linearRampToValueAtTime(thunderVol, c.currentTime + 0.05);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 1.5);

            osc.connect(filter);
            filter.connect(gain);
            gain.connect(c.destination);
            osc.start(c.currentTime);
            osc.stop(c.currentTime + 1.5);

            // Шум удара
            setTimeout(function () {
                playNoise(0.3, thunderVol * 1.5);
            }, 50);

        } catch (e) {}
    }

    // Звук порыва ветра (для чекпоинтов/событий)
    function windGust() {
        if (!enabled) return;
        try {
            const c = getCtx();
            const bufferSize = c.sampleRate * 1;
            const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = (Math.random() * 2 - 1) * 0.5;
            }
            const source = c.createBufferSource();
            source.buffer = buffer;

            const filter = c.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 400;
            filter.Q.value = 2;

            const gain = c.createGain();
            gain.gain.setValueAtTime(0, c.currentTime);
            gain.gain.linearRampToValueAtTime(0.12 * volume, c.currentTime + 0.2);
            gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 1);

            source.connect(filter);
            filter.connect(gain);
            gain.connect(c.destination);
            source.start();
        } catch (e) {}
    }

    // Звук туманного горна
    function fogHorn() {
        if (!enabled) return;
        playTone(85, 1.5, 'sine', 0.08);
        setTimeout(() => playTone(80, 1.2, 'sine', 0.06), 800);
    }

    // ── API ──

    return {
        moveNormal,
        moveCapture,
        moveCheck,
        moveCastle,
        movePromotion,
        comboUp,
        comboBreak,
        blunder,
        catastrophe,
        gameStart,
        gameEnd,
        ratingUp,
        ratingDown,
        illegal,
        krakenAttack,
        preloadKraken,

        // Погода
        playWeatherSound,
        stopWeatherSound,
        windGust,
        fogHorn,
        playThunder,

        setEnabled(val) { enabled = !!val; },
        isEnabled() { return enabled; },
        setVolume(val) { volume = Math.max(0, Math.min(1, val)); },

        unlock() {
            try {
                getCtx();
                preloadKraken();
            } catch (e) {}
        }
    };
})();
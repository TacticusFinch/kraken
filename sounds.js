// ============================================
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
                data[i] = (Math.random() * 2 - 1) *0.3;
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
            source.start();} catch (e) {
            console.warn('Noise error:', e);
        }
    }

    //── Звуки ──

    function moveNormal() {
        // Деревянный «клик» фигуры
        playNoise(0.08, 0.5);
        playTone(400, 0.06, 'triangle', 0.3);}

    function moveCapture() {
        // Удар — более резкий
        playNoise(0.12, 0.7);
        playTone(250, 0.1, 'sawtooth', 0.25);
        setTimeout(() => playTone(180, 0.08, 'triangle', 0.15), 30);
    }

    function moveCheck() {
        // Тревожный двойной тон
        playTone(600, 0.12, 'square', 0.2);
        setTimeout(() => playTone(800, 0.15, 'square', 0.25), 80);
    }

    function moveCastle() {
        // Двойной стук
        playNoise(0.06, 0.4);
        setTimeout(() => playNoise(0.06, 0.5), 100);
        playTone(350, 0.08, 'triangle', 0.2);
    }

    function movePromotion() {
        // Восходящий аккорд
        playTone(400, 0.15, 'sine', 0.2);
        setTimeout(() => playTone(500, 0.15, 'sine', 0.2), 60);
        setTimeout(() => playTone(650, 0.2, 'sine', 0.25), 120);
    }

    function comboUp(level) {
        // Нарастающий тон в зависимости от уровня комбо
        const baseFreq = 500+ (level || 3) * 40;
        playTone(baseFreq, 0.1, 'sine', 0.2);
        setTimeout(() => playTone(baseFreq * 1.25, 0.15, 'sine', 0.25), 70);
    }

    function comboBreak() {
        // Грустный нисходящий
        playTone(400, 0.15, 'sine', 0.2);
        setTimeout(() => playTone(280, 0.2, 'sine', 0.2), 100);
        setTimeout(() => playTone(200, 0.25, 'triangle', 0.15), 200);
    }

    function blunder() {
        // Низкий тревожный гудок
        playTone(150, 0.3, 'sawtooth', 0.2);
        setTimeout(() => playTone(120, 0.4, 'sawtooth', 0.15), 100);
    }

    function catastrophe() {
        // Кракен рычит
        playTone(80, 0.5, 'sawtooth', 0.3);
        setTimeout(() => playTone(60, 0.6, 'sawtooth', 0.25), 150);
        setTimeout(() => playNoise(0.3, 0.4), 200);
    }

    function gameStart() {
        // Бодрый аккорд
        playTone(330, 0.15, 'sine', 0.15);
        setTimeout(() => playTone(415, 0.15, 'sine', 0.15), 80);
        setTimeout(() => playTone(523, 0.2, 'sine', 0.2), 160);
        setTimeout(() => playTone(660, 0.25, 'sine', 0.2), 240);
    }

    function gameEnd() {
        // Завершающий аккорд
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
        // Короткий «бзз»
        playTone(150, 0.1, 'square', 0.15);
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

        setEnabled(val) { enabled = !!val; },
        isEnabled() { return enabled; },
        setVolume(val) { volume = Math.max(0, Math.min(1, val)); },

        // Разблокировка AudioContext при первом клике
        unlock() {
            try { getCtx(); } catch (e) {}}
    };
})();
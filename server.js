// ============================================
// Kraken — сервер дебютного тренажёра v7
// Node.js 22+, Express, Lichess Explorer API
// Rating: Kraken v7 — eval-destination, path-quality, combo-depth
// ============================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Chess } = require('chess.js');

const app = express();
const PORT = 3000;

app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// COOP/COEP — только для файлов Stockfish
app.get('/sf-worker2.js', (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'sf-worker2.js'));
});

app.get('/stockfish-18-lite-single.js', (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'stockfish-18-lite-single.js'));
});
app.get(/.*\.wasm$/, (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');    
    const fileName = path.basename(req.url);
    const requestedFile = path.join(__dirname, fileName);
    console.log('🔍WASM запрос:', req.url, '→ищем:', requestedFile);

    if (fs.existsSync(requestedFile)) {
        res.setHeader('Content-Type', 'application/wasm');
        res.sendFile(requestedFile);
    } else {
        const wasmFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.wasm'));
        console.log('🔍 Доступные .wasm файлы:', wasmFiles);
        if (wasmFiles.length > 0) {
            console.log(`⚠️ ${fileName} не найден, отдаю ${wasmFiles[0]}`);
            res.setHeader('Content-Type', 'application/wasm');
            res.sendFile(path.join(__dirname, wasmFiles[0]));
        } else {
            console.error('❌ Нет .wasm файлов в папке!');
            res.status(404).end();
        }
    }
});

app.use(express.static(__dirname));

// ============================================
// Конфигурация
// ============================================

const token = process.env.LICHESS_TOKEN;
const CACHE_TTL = 1000 * 60 * 60;
const CACHE_MAX_SIZE = 2000;
const LICHESS_TIMEOUT = 2500;
const PREFETCH_ENABLED = true;
const PREFETCH_TOP_N = 4;
const PREFETCH_MIN_SHARE = 0.05;
const MIN_GAMES_FOR_BOOK = 25;
const MIN_GAMES_FOR_MOVE = 10;
const MIN_GAMES_TOTAL = 50;

const RATINGS_FILE = path.join(__dirname, 'data', 'ratings.json');

// ============================================
// Хранилище рейтингов
// ============================================
let ratings = {};
try {
    if (!fs.existsSync(path.dirname(RATINGS_FILE))) {
        fs.mkdirSync(path.dirname(RATINGS_FILE), { recursive: true });
    }
    if (fs.existsSync(RATINGS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
        for (const [uid, val] of Object.entries(raw)) {
            if (typeof val === 'number') {
                ratings[uid] = { rating: val, games: 0, lastDeltas: [], updatedAt: Date.now() };
            } else {
                ratings[uid] = val;
            }
        }
        console.log(`📊 Загружено рейтингов: ${Object.keys(ratings).length}`);
    }
} catch (e) {
    console.error('Ошибка загрузки рейтингов:', e.message);
    ratings = {};
}

let saveTimer = null;
function saveRatingsDebounced() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2));
        } catch (e) {
            console.error('Ошибка сохранения рейтингов:', e.message);
        }
    }, 500);
}

// ============================================
// Кэш Lichess + дедупликация
// ============================================
const lichessCache = new Map();
const inflight = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function getCached(key) {
    const entry = lichessCache.get(key);
    if (!entry) { cacheMisses++; return null; }
    if (Date.now() - entry.time > CACHE_TTL) {
        lichessCache.delete(key);
        cacheMisses++;
        return null;
    }
    cacheHits++;
    return entry.data;
}

function setCached(key, data) {
    lichessCache.set(key, { data, time: Date.now() });
    if (lichessCache.size > CACHE_MAX_SIZE) {
        const firstKey = lichessCache.keys().next().value;
        lichessCache.delete(firstKey);
    }
}

// ============================================
// Ограничитель параллельных запросов
// ============================================
function createLimiter(maxConcurrent) {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= maxConcurrent || queue.length === 0) return;
        active++;
        const { fn, resolve, reject } = queue.shift();
        fn().then(resolve, reject).finally(() => {
            active--;
            next();
        });
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}
const lichessLimit = createLimiter(6);

// ============================================
// Рейтинговые группы Lichess
// ============================================
function getLichessRatingBands(rating) {
    const allBands = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
    if (rating < 1100) return [1000, 1200];

    let idx = 0;
    for (let i = 0; i < allBands.length; i++) {
        if (allBands[i] <= rating) idx = i;
        else break;
    }

    const main = allBands[idx];
    const next = allBands[idx + 1];
    const prev = allBands[idx - 1];
    const result = [main];
    const step = next !== undefined ? next - main : 200;
    const distToTop = next !== undefined ? next - rating : Infinity;
    const distToBottom = rating - main;

    if (next !== undefined && distToTop <= step / 3) {
        result.push(next);
    } else if (prev !== undefined && distToBottom <= step / 3) {
        result.push(prev);
    } else if (next === undefined && prev !== undefined) {
        result.push(prev);
    }

    return result.sort((a, b) => a - b);
}

// ============================================
// Запрос к Lichess Explorer
// ============================================
async function fetchLichessRaw(fen, bands) {
    const cacheKey = `${fen}|${bands.join(',')}`;
    const cached = getCached(cacheKey);
    if (cached) {
        const total = (cached.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
        console.log(`📚 [CACHE] bands=[${bands.join(',')}] | партий: ${total}`);
        return cached;
    }

    if (inflight.has(cacheKey)) {
        console.log(`⏳ [INFLIGHT] bands=[${bands.join(',')}]`);
        return inflight.get(cacheKey);
    }

    console.log(`🌐 [FETCH] bands=[${bands.join(',')}] | FEN: ${fen.split(' ').slice(0, 2).join(' ')}`);

    const url = new URL('https://explorer.lichess.ovh/lichess');
    url.searchParams.set('variant', 'standard');
    url.searchParams.set('fen', fen);
    url.searchParams.set('speeds', 'blitz,rapid,classical');
    url.searchParams.set('moves', '20');
    url.searchParams.set('ratings', bands.join(','));

    const p = lichessLimit(() => axios.get(url.toString(), {
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'KrakenChessTrainer/3.3'
        },
        timeout: LICHESS_TIMEOUT
    })).then(response => {
        const total = (response.data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
        console.log(`✅ [FETCH OK] bands=[${bands.join(',')}] | ${total} партий`);
        setCached(cacheKey, response.data);
        return response.data;
    }).catch(err => {
        if (err.response) console.error('Lichess API:', err.response.status, err.response.statusText);
        else console.error('Lichess API:', err.message);
        return { moves: [] };
    }).finally(() => {
        inflight.delete(cacheKey);
    });

    inflight.set(cacheKey, p);
    return p;
}

function expandBands(bands) {
    const allBands = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
    const set = new Set(bands);
    const minIdx = allBands.indexOf(bands[0]);
    const maxIdx = allBands.indexOf(bands[bands.length - 1]);
    if (minIdx > 0) set.add(allBands[minIdx - 1]);
    if (maxIdx < allBands.length - 1) set.add(allBands[maxIdx + 1]);
    return [...set].sort((a, b) => a - b);
}

async function fetchLichessExplorer(fen, rating) {
    let bands = getLichessRatingBands(rating);
    let data = await fetchLichessRaw(fen, bands);
    let total = (data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);

    let attempts = 0;
    while (total < MIN_GAMES_FOR_BOOK && attempts < 2) {
        const expanded = expandBands(bands);
        if (expanded.length === bands.length) break;
        console.log(`⚠ Мало партий (${total} < ${MIN_GAMES_FOR_BOOK}), расширяем bands → [${expanded.join(',')}]`);
        bands = expanded;
        data = await fetchLichessRaw(fen, bands);
        total = (data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
        attempts++;
    }

    return data;
}

// ============================================
// Утилиты для ходов
// ============================================
function normalizeSan(san) {
    if (!san) return '';
    return san.replace(/[!?+#]/g, '').trim();
}

function pickWeightedMove(moves) {
    if (!moves || moves.length === 0) return null;

    const withCounts = moves.map(m => ({
        move: m,
        count: m.white + m.draws + m.black
    }));

    const total = withCounts.reduce((s, m) => s + m.count, 0);
    if (total === 0) return moves[0];

    const filtered = withCounts.filter(m => (m.count / total >= 0.02) && m.count >= MIN_GAMES_FOR_MOVE);
    const pool = filtered.length > 0 ? filtered : withCounts;

    const poolTotal = pool.reduce((s, m) => s + m.count, 0);
    let rand = Math.random() * poolTotal;

    for (const m of pool) {
        rand -= m.count;
        if (rand <= 0) return m.move;
    }
    return pool[0].move;
}

// ============================================
// Умный префетч
// ============================================
async function prefetchLikelyPositions(fen, rating, topN = PREFETCH_TOP_N) {
    if (!PREFETCH_ENABLED) return;
    try {
        const data = await fetchLichessExplorer(fen, rating);
        const moves = data.moves || [];
        if (moves.length === 0) return;

        const total = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
        if (total < MIN_GAMES_FOR_BOOK) return;

        const candidates = moves
            .map(m => ({ san: m.san, count: m.white + m.draws + m.black }))
            .filter(m => m.count / total >= PREFETCH_MIN_SHARE)
            .slice(0, topN);

        if (candidates.length === 0) return;

        await Promise.allSettled(candidates.map(async (cand) => {
            try {
                const chess = new Chess(fen);
                chess.move(cand.san);
                await fetchLichessExplorer(chess.fen(), rating);
            } catch (e) { /* пропускаем */ }
        }));
    } catch (e) { /* префетч не критичен */ }
}

// ============================================
// KRAKEN RATING v7 — eval-destination, path-quality, combo-depth
// ============================================

/**
 * Centipawns → Win Probability [0..1]
 * Формула Lichess (более точная чем простая сигмоида)
 */
function evalToWinProb(cp) {
    return 1 / (1 + Math.exp(-0.00368 * cp));
}

/**
 * Win Probability → нормализованный score [-1..+1]
 */
function wpToScore(wp) {
    return (wp - 0.5) * 2;
}

/**
 * Безопасное получение eval с учётом мата
 * Мат = ±10000, ограничиваем до ±1500 для формулы
 */
function safeEval(cp) {
    if (cp === undefined || cp === null) return 0;
    return Math.max(-1500, Math.min(1500, cp));
}

/**
 * КОМПОНЕНТ 1: EVAL DESTINATION (60% веса)
 *
 * Главный принцип: чем лучше eval в конце дебюта, тем больше награда.
 * Финальный eval — король. Дельта и провалы — второстепенны.
 *
 * Шкала (для играющего):
 *   eval = 0.0  → score ≈ 0.0  (равенство — нейтрально)
 *   eval = +0.5 → score ≈ 0.25 (небольшой перевес)
 *   eval = +1.0 → score ≈ 0.45 (перевес)
 *   eval = +1.5 → score ≈ 0.60 (серьёзный перевес)
 *   eval = +2.0 → score ≈ 0.72 (большой перевес)
 *   eval = +2.5 → score ≈ 0.80 (подавляющий)
 *   eval = +3.0+→ score ≈ 0.85-0.95 (выиграно)
 *   eval < 0    → штраф пропорционально
 *
 * Возвращает score от -1.0 до +1.0
 */
function calcDestinationScore(userMoves, userColor) {
    const sign = userColor === 'white' ? 1 : -1;
    const n = userMoves.length;

    // ═══ Финальный eval (ГЛАВНЫЙ СИГНАЛ — 75% компонента) ═══
    const lastMove = userMoves[n - 1];
    const endEvalRaw = safeEval(lastMove.evalAfter ?? lastMove.evalBefore ?? 0);
    const endEval = endEvalRaw * sign; // положительный = хорошо для игрока

    // Нелинейная шкала: быстро растёт до +2, потом замедляется
    // tanh(x * 0.45) даёт: 0→0, 1→0.42, 2→0.73, 2.5→0.81, 3→0.87, 5→0.98
    const endEvalPawns = endEval / 100; // cp → pawns
    const absoluteScore = Math.tanh(endEvalPawns * 0.45);

    // ═══ Дельта от старта (бонус/штраф — 15% компонента) ═══
    const firstMove = userMoves[0];
    const startEval = safeEval(firstMove.evalBefore ?? 0) * sign;
    const startPawns = startEval / 100;
    const endPawns = endEval / 100;
    const deltaPawns = endPawns - startPawns;

    // Улучшил на 1 пешку → +0.3, ухудшил на 1 → -0.3
    const deltaScore = Math.max(-1, Math.min(1, deltaPawns * 0.3));

    // ═══ Штраф за провалы (10% компонента) ═══
    let worstEvalPawns = endPawns;
    for (const m of userMoves) {
        const ev = safeEval((m.evalAfter ?? m.evalBefore ?? 0)) * sign / 100;
        if (ev < worstEvalPawns) worstEvalPawns = ev;
    }
    // Штраф только если провал > 0.5 пешки от финала
    const dip = endPawns - worstEvalPawns;
    const dipPenalty = dip > 0.5 ? Math.min(0.3, (dip - 0.5) * 0.15) : 0;

    // ═══ ИТОГО: 75% абсолют + 15% дельта - 10% провал ═══
    const raw = absoluteScore * 0.75 + deltaScore * 0.15 - dipPenalty;
    return Math.max(-1, Math.min(1, raw));
}

/**
 * КОМПОНЕНТ 2: PATH QUALITY (30% веса)
 *
 * Каждый ход оценивается относительно ожидания для рейтинга.
 * Поздние ходы весят больше (глубже в теорию = сложнее).
 * Зевки — прогрессивный штраф.
 *
 * Возвращает объект с score от -1.0 до +1.0 и диагностику
 */
function calcPathQualityScore(userMoves, rating) {
    if (userMoves.length === 0) {
        return { score: 0, blunderCount: 0, blunderSeveritySum: 0, expectedCPL: 50, blunderThreshold: 150, avgCPL: 0 };
    }

    const r = Math.max(400, Math.min(3200, rating));
    const n = userMoves.length;

    // Ожидаемый CPL для рейтинга
    // 800 → ~80, 1200 → ~45, 1600 → ~28, 2000 → ~18, 2500 → ~10
    const expectedCPL = 6 + 180 / (1 + Math.exp((r - 700) / 350));

    // Порог зевка
    const blunderThreshold = Math.max(60, 300 - r * 0.1);

    let weightedScore = 0;
    let totalWeight = 0;
    let blunderCount = 0;
    let blunderSeveritySum = 0;

    for (let i = 0; i < n; i++) {
        const m = userMoves[i];
        const cpl = m.cpl ?? 0;

        // Вес хода: поздние ходы чуть важнее (1.0 → 1.5)
        const moveWeight = 1.0 + 0.5 * (i / Math.max(1, n - 1));

        // Score хода: CPL=0 → +1, CPL=expected → 0, CPL=2*expected → -1
        const moveScore = Math.max(-1, Math.min(1, 1 - (cpl / expectedCPL)));

        weightedScore += moveScore * moveWeight;
        totalWeight += moveWeight;

        // Зевки
        if (cpl > blunderThreshold) {
            blunderCount++;
            blunderSeveritySum += Math.min(3, cpl / blunderThreshold);
        }
    }

    let pathScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Прогрессивный штраф за зевки
    if (blunderCount > 0) {
        const blunderPenalty = blunderSeveritySum * (1 + (blunderCount - 1) * 0.3) * 0.15;
        pathScore -= blunderPenalty;
    }

    return {
        score: Math.max(-1, Math.min(1, pathScore)),
        blunderCount,
        blunderSeveritySum,
        expectedCPL,
        blunderThreshold,
        avgCPL: userMoves.reduce((s, m) => s + (m.cpl || 0), 0) / n
    };
}

/**
 * КОМПОНЕНТ 3: COMBO DEPTH (15% веса)
 *
 * Длинная серия точных ходов = глубокое знание линии.
 * Самостоятельный компонент, НЕ множитель.
 *
 * Серия ≥2 точных ходов = комбо.
 * Книжные ходы внутри комбо дают бонус.
 * Perfect game = максимум.
 *
 * Возвращает score от 0 до +1.0
 */
function calcComboDepthScore(userMoves, expectedCPL) {
    if (userMoves.length < 2) {
        return { score: 0, maxCombo: 0, series: [], perfect: false, goodThreshold: 0 };
    }

    const n = userMoves.length;
    const goodThreshold = expectedCPL * 0.6;

    let currentCombo = 0;
    let maxCombo = 0;
    const series = [];
    let bookInCombo = 0;

    for (const m of userMoves) {
        if ((m.cpl ?? 0) <= goodThreshold) {
            currentCombo++;
            if (m.isBookMove) bookInCombo++;
        } else {
            if (currentCombo >= 2) {
                series.push({ length: currentCombo, bookMoves: bookInCombo });
            }
            maxCombo = Math.max(maxCombo, currentCombo);
            currentCombo = 0;
            bookInCombo = 0;
        }
    }
    if (currentCombo >= 2) {
        series.push({ length: currentCombo, bookMoves: bookInCombo });
    }
    maxCombo = Math.max(maxCombo, currentCombo);

    const perfect = n >= 4 && userMoves.every(m => (m.cpl ?? 0) <= goodThreshold);

    // Scoring серий
    let comboRaw = 0;
    for (const s of series) {
        const lengthScore = Math.pow(s.length / n, 0.7) * s.length;
        const bookBonus = s.bookMoves * 0.1;
        comboRaw += lengthScore + bookBonus;
    }

    const maxPossible = Math.pow(1, 0.7) * n;
    let score = maxPossible > 0 ? comboRaw / maxPossible : 0;

    if (perfect) {
        score = Math.max(score, 0.85);
        score += 0.15;
    }

    return {
        score: Math.min(1.0, score),
        maxCombo,
        series,
        perfect,
        goodThreshold
    };
}

/**
 * KRAKEN RATING v7 — главная функция
 *
 * Три столпа:
 * 1. DESTINATION (55%) — куда пришёл по eval
 * 2. PATH (30%)        — как шёл (точность ходов)
 * 3. COMBO (15%)       — глубина знания линии
 *
 * K-фактор адаптивный. Границ нет — рейтинг свободный.
 */
function calculateRatingDelta(rating, session) {
    const allSessionMoves = session.moves || [];
    const userMoves = allSessionMoves.filter(m => m.isUserMove);

    if (userMoves.length < 2) return 0;

    const r = Math.max(400, Math.min(3200, rating));
    const n = userMoves.length;
    const gamesPlayed = session.gamesPlayed || 0;

    const firstUserMove = userMoves[0];
    const firstUserIndex = allSessionMoves.indexOf(firstUserMove);
    const userColor = (firstUserIndex % 2 === 0) ? 'white' : 'black';

    // ═══ 1. DESTINATION (60%) — финальный eval доминирует ═══
    const destinationScore = calcDestinationScore(userMoves, userColor);

    // ═══ 2. PATH QUALITY (25%) ═══
    const pathResult = calcPathQualityScore(userMoves, r);
    const pathScore = pathResult.score;

    // ═══ 3. COMBO DEPTH (15%) ═══
    const comboResult = calcComboDepthScore(userMoves, pathResult.expectedCPL);
    const comboScore = comboResult.score > 0
        ? comboResult.score
        : (n >= 4 ? -0.2 : 0);

    // ═══ НОВЫЕ ВЕСА ═══
    const W_DEST = 0.60;  // было 0.55
    const W_PATH = 0.25;  // было 0.30
    const W_COMBO = 0.15; // без изменений

    const compositeScore =
        destinationScore * W_DEST +
        pathScore * W_PATH +
        comboScore * W_COMBO;

    // ═══ K-ФАКТОР — увеличен ═══
    const baseK = 36; // было 28

    const calibrationFactor = 1 + 0.5 * Math.max(0, 1 - gamesPlayed / 30);
    const lengthFactor = 0.6 + 0.4 * Math.min(1, n / 10);
    const asymmetry = compositeScore < 0 ? 0.85 : 1.0;

    const K = baseK * calibrationFactor * lengthFactor * asymmetry;

    // ═══ СЫРАЯ ДЕЛЬТА ═══
    let delta = K * compositeScore;

    // ═══ БОНУС ЗА СИЛЬНЫЙ ФИНАЛЬНЫЙ EVAL ═══
    // Если вышел из дебюта с eval > +1.5 — прямой бонус
    const sign = userColor === 'white' ? 1 : -1;
    const lastMove = userMoves[n - 1];
    const finalEvalPawns = safeEval(lastMove.evalAfter ?? lastMove.evalBefore ?? 0) * sign / 100;

    if (finalEvalPawns >= 1.5 && pathResult.blunderCount === 0) {
        // +1.5 → +3, +2.0 → +5, +2.5 → +7, +3.0 → +8
        const evalBonus = Math.min(10, (finalEvalPawns - 1.5) * 5);
        delta += evalBonus;
        console.log(`  🎯 Eval bonus: +${evalBonus.toFixed(1)} (final eval: ${finalEvalPawns.toFixed(1)})`);
    }

    // ═══ ЗАЩИТНЫЕ МЕХАНИЗМЫ (без изменений) ═══
    const worstCPL = Math.max(0, ...userMoves.map(m => m.cpl || 0));
    if (worstCPL >= 500 && delta > 0) {
        delta = Math.min(-2, delta * -0.3);
    }

    const recentDeltas = session.recentDeltas || [];
    if (recentDeltas.length >= 3 && delta < 0) {
        const lastThree = recentDeltas.slice(-3);
        if (lastThree.every(d => d < 0)) {
            const totalLoss = lastThree.reduce((s, d) => s + d, 0);
            if (totalLoss < -20) {
                delta *= 0.65;
            }
        }
    }

    const bookMoves = userMoves.filter(m => m.isBookMove).length;
    if (bookMoves > 0 && pathResult.blunderCount === 0) {
        delta += Math.min(5, Math.sqrt(bookMoves) * 1.2);
    }

    delta = Math.round(delta);

    // ═══ ДИАГНОСТИКА ═══
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║         KRAKEN RATING v7.1 CALC           ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log(`  Рейтинг: ${r} | Цвет: ${userColor} | Ходов: ${n}`);
    console.log(`  ── DESTINATION (${(W_DEST * 100).toFixed(0)}%) ──`);
    console.log(`  Score: ${(destinationScore * 100).toFixed(1)}%`);
    console.log(`  Final eval: ${finalEvalPawns.toFixed(2)} pawns (${(safeEval(lastMove.evalAfter ?? lastMove.evalBefore ?? 0))}cp)`);
    console.log(`  Start eval: ${safeEval(userMoves[0].evalBefore ?? 0)}cp`);
    console.log(`  ── PATH QUALITY (${(W_PATH * 100).toFixed(0)}%) ──`);
    console.log(`  Score: ${(pathScore * 100).toFixed(1)}%`);
    console.log(`  Avg CPL: ${pathResult.avgCPL.toFixed(1)} (ожидание: ${pathResult.expectedCPL.toFixed(1)})`);
    console.log(`  Зевков: ${pathResult.blunderCount} (порог: ${pathResult.blunderThreshold.toFixed(0)}cp)`);
    console.log(`  ── COMBO DEPTH (${(W_COMBO * 100).toFixed(0)}%) ──`);
    console.log(`  Score: ${(comboScore * 100).toFixed(1)}%`);
    console.log(`  Max combo: ${comboResult.maxCombo} | Perfect: ${comboResult.perfect}`);
    console.log(`  ── СБОРКА ──`);
    console.log(`  Composite: ${(compositeScore * 100).toFixed(1)}%`);
    console.log(`  K=${K.toFixed(1)} (base=${baseK} cal=${calibrationFactor.toFixed(2)} len=${lengthFactor.toFixed(2)})`);
    console.log(`  Book moves: ${bookMoves} | Worst CPL: ${worstCPL}`);
    console.log(`  ═══ ИТОГО: delta = ${delta >= 0 ? '+' : ''}${delta} ═══`);
    console.log('─────────────────────────────────────────────');

    return delta;
}

module.exports = { calculateRatingDelta };

// ============================================
// API: /play-move
// ============================================
app.post('/play-move', async (req, res) => {
    const { fen, san, rating } = req.body;
    const t0 = Date.now();

    try {
        const chess = new Chess();
        try {
            chess.load(fen);
        } catch (e) {
            return res.status(400).json({ error: 'Invalid FEN' });
        }

        const data = await fetchLichessExplorer(fen, rating);
        const moves = data.moves || [];
        const total = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);

        const normalizedInput = normalizeSan(san);
        const rank = moves.findIndex(m => normalizeSan(m.san) === normalizedInput) + 1;
        const playerMoveInfo = rank > 0 ? moves[rank - 1] : null;
        const playerMoveCount = playerMoveInfo
            ? playerMoveInfo.white + playerMoveInfo.draws + playerMoveInfo.black
            : 0;
        const inBook = rank > 0 && playerMoveCount >= MIN_GAMES_FOR_MOVE && total >= MIN_GAMES_TOTAL;

        let playerMoveResult;
        try {
            playerMoveResult = chess.move(san);
        } catch (e) {
            return res.status(400).json({ error: 'Illegal move' });
        }
        if (!playerMoveResult) {
            return res.status(400).json({ error: 'Illegal move' });
        }

        if (chess.isGameOver()) {
            const dt = Date.now() - t0;
            console.log(`🎯 /play-move "${san}" → end, ${dt}ms`);
            return res.json({
                check: { inBook, rank: rank || 99, total, moveCount: playerMoveCount },
                reply: null,
                gameOver: true,
                result: chess.isCheckmate() ? 'checkmate' : 'draw'
            });
        }

        const newFen = chess.fen();
        const replyData = await fetchLichessExplorer(newFen, rating);
        const replyMoves = replyData.moves || [];
        const replyTotal = replyMoves.reduce((s, m) => s + m.white + m.draws + m.black, 0);

        let replyMove = null;
        if (replyMoves.length > 0 && replyTotal >= MIN_GAMES_FOR_BOOK) {
            const picked = pickWeightedMove(replyMoves);
            if (picked) replyMove = picked.san;
        }

        if (replyMove) {
            setImmediate(() => {
                try {
                    const preChess = new Chess(newFen);
                    preChess.move(replyMove);
                    prefetchLikelyPositions(preChess.fen(), rating);
                } catch (e) { /* игнор */ }
            });
        }

        const dt = Date.now() - t0;
        console.log(`🎯 /play-move "${san}" → "${replyMove || '—'}", ${dt}ms, inBook=${inBook}, rank=${rank}`);

        res.json({
            check: { inBook, rank: rank || 99, total, moveCount: playerMoveCount },
            reply: replyMove,
            gameOver: false
        });

    } catch (err) {
        console.error('Ошибка /play-move:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================
// API: /get-move — первый ход белых
// ============================================
app.post('/get-move', async (req, res) => {
    const { fen, rating } = req.body;
    try {
        const data = await fetchLichessExplorer(fen, rating);
        const moves = data.moves || [];
        const total = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);

        if (moves.length === 0 || total < MIN_GAMES_FOR_BOOK) {
            return res.json({ move: null });
        }
        const picked = pickWeightedMove(moves);

        if (picked) {
            setImmediate(() => {
                try {
                    const chess = new Chess(fen);
                    chess.move(picked.san);
                    prefetchLikelyPositions(chess.fen(), rating);
                } catch (e) {}
            });
        }

        res.json({ move: picked ? picked.san : null });
    } catch (err) {
        console.error('Ошибка /get-move:', err.message);
        res.status(500).json({ move: null });
    }
});

// ============================================
// API: рейтинги
// ============================================
app.get('/api/rating/:userId', (req, res) => {
    const entry = ratings[req.params.userId];
    if (!entry) {
        return res.json({
            userId: req.params.userId,
            rating: 1200,
            games: 0,
            recentDeltas: []
        });
    }
    res.json({
        userId: req.params.userId,
        rating: entry.rating,
        games: entry.games || 0,
        recentDeltas: entry.lastDeltas || []
    });
});

app.post('/api/rating/:userId/update', (req, res) => {
    const { userId } = req.params;
    const {
        moves, openingDifficulty, recentDeltas,
        mateBlunder, hangsQueen, repeatedBlunder,
        maxCombo, comboHistory, perfectStreak
    } = req.body;

    // ═══ ДИАГНОСТИКА: что пришло с клиента ═══
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   ВХОДНЫЕ ДАННЫЕ ОТ КЛИЕНТА          ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log(`Ходов получено: ${(moves || []).length}`);
    console.log(`mateBlunder=${mateBlunder}, hangsQueen=${hangsQueen}, repeatedBlunder=${repeatedBlunder}`);
    console.log(`maxCombo=${maxCombo}, perfectStreak=${perfectStreak}`);
    if (Array.isArray(moves)) {
        moves.forEach((m, i) => {
            console.log(`  ${i + 1}. ${m.san} | CPL=${m.cpl} | evalBefore=${m.evalBefore ?? '?'} | evalAfter=${m.evalAfter ?? '?'} | book=${m.isBookMove} | rank=${m.popularityRank} | isUser=${m.isUserMove}`);
        });
    }
    console.log('────────────────────────────────────────');

    if (!Array.isArray(moves)) {
        return res.status(400).json({ error: 'moves must be array' });
    }

    const existing = ratings[userId] || { rating: 1200, games: 0, lastDeltas: [] };
    const oldRating = existing.rating;
    const gamesPlayed = existing.games || 0;

    const delta = calculateRatingDelta(oldRating, {
        moves,
        openingDifficulty: openingDifficulty || oldRating,
        gamesPlayed,
        recentDeltas: recentDeltas || existing.lastDeltas || [],
        mateBlunder: !!mateBlunder,
        hangsQueen: !!hangsQueen,
        repeatedBlunder: !!repeatedBlunder,
        maxCombo: maxCombo || 0,
        comboHistory: comboHistory || [],
        perfectStreak: !!perfectStreak
    });

    const newRating = oldRating + delta;
    const newDeltas = [...(existing.lastDeltas || []), delta].slice(-10);

    ratings[userId] = {
        rating: newRating,
        games: gamesPlayed + 1,
        lastDeltas: newDeltas,
        updatedAt: Date.now()
    };
    saveRatingsDebounced();

    console.log(`📈 ${userId}: ${oldRating} → ${newRating} (delta ${delta >= 0 ? '+' : ''}${delta}) ходов=${moves.length}`);

    res.json({
        oldRating,
        newRating,
        delta,
        gamesPlayed: ratings[userId].games,
        recentDeltas: ratings[userId].lastDeltas
    });
});

app.post('/api/rating/:userId/reset', (req, res) => {
    const { userId } = req.params;
    const { rating } = req.body;
    const ALLOWED = [1000, 1400, 1800, 2200];

    if (!ALLOWED.includes(rating)) {
        return res.status(400).json({ error: 'Invalid start rating' });
    }

    ratings[userId] = {
        rating,
        games: 0,
        lastDeltas: [],
        updatedAt: Date.now()
    };
    saveRatingsDebounced();
    res.json({ userId, rating, games: 0 });
});

// ============================================
// API: статистика кэша
// ============================================
app.get('/api/stats', (req, res) => {
    const total = cacheHits + cacheMisses;
    res.json({
        cacheSize: lichessCache.size,
        inflight: inflight.size,
        hits: cacheHits,
        misses: cacheMisses,
        hitRate: total ? (cacheHits / total * 100).toFixed(1) + '%' : '0%',
        users: Object.keys(ratings).length
    });
});

// ============================================
// Диагностика Lichess при старте
// ============================================
(async () => {
    const testFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const testUrl = `https://explorer.lichess.ovh/lichess?variant=standard&speeds=blitz,rapid,classical&ratings=1600&fen=${encodeURIComponent(testFen)}`;

    console.log('🔍 Тест Lichess Explorer...');
    console.log('   URL:', testUrl);
    console.log('   Токен:', token ? `${token.slice(0, 8)}...` : 'НЕ ЗАДАН');

    try {
        const resp = await axios.get(testUrl, {
            headers: {
                'Authorization': token ? `Bearer ${token}` : undefined,
                'User-Agent': 'KrakenChessTrainer/3.3',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        const total = (resp.data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
        console.log(`✅ Тест с токеном: ${resp.status}, ${total} партий`);
    } catch (e) {
        console.error(`❌ Тест с токеном ПРОВАЛЕН:`);
        if (e.response) {
            console.error(`   HTTP ${e.response.status} ${e.response.statusText}`);
            console.error(`   Body:`, JSON.stringify(e.response.data).slice(0, 200));
        } else {
            console.error(`   ${e.code || e.message}`);
        }
    }

    try {
        const resp = await axios.get(testUrl, {
            headers: {
                'User-Agent': 'KrakenChessTrainer/3.3',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        const total = (resp.data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
    } catch (e) {
        if (e.response) {
            // тихо
        } else {
            console.error(`   ${e.code || e.message}`);
        }
    }
})();

// ============================================
// Запуск
// ============================================
app.listen(PORT, () => {
    console.log(`🦑 Кракен пробудился! http://localhost:${PORT}`);
    console.log(`   Node ${process.version}`);
    console.log(`   Префетч: ${PREFETCH_ENABLED ? 'включён' : 'выключен'}`);
    console.log(`   Рейтинг: Kraken v7 (eval-destination + path-quality + combo-depth)`);
});

process.on('SIGINT', () => {
    console.log(`\n💾 Сохранение рейтингов...`);
    if (saveTimer) clearTimeout(saveTimer);
    try { fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2)); } catch {}
    process.exit(0);
});
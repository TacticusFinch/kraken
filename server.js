// ============================================
// Kraken — сервер дебютного тренажёра v3.2
// Node.js 22+, Express, Lichess Explorer API
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

// Заголовки для SharedArrayBuffer
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
});

app.get('/sf-worker2.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'sf-worker2.js'));
});

app.get('/stockfish-18-lite-single.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(path.join(__dirname, 'stockfish-18-lite-single.js'));
});

// Используем регулярное выражение для перехвата всех .wasm запросов
app.get(/.*\.wasm$/, (req, res) => {
    const fileName = path.basename(req.url);
    const requestedFile = path.join(__dirname, fileName);

    console.log('🔍WASM запрос:', req.url, '→ищем:', requestedFile);

    if (fs.existsSync(requestedFile)) {
        res.setHeader('Content-Type', 'application/wasm');
        res.sendFile(requestedFile);
    } else {
        //Ищем любой .wasm файл в корне
        const wasmFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.wasm'));
        console.log('🔍 Доступные .wasm файлы:', wasmFiles);
        
        if (wasmFiles.length > 0) {
            console.log(`⚠️ ${fileName} не найден, отдаю ${wasmFiles[0]}`);
            res.setHeader('Content-Type', 'application/wasm');
            res.sendFile(path.join(__dirname, wasmFiles[0]));
        } else {
            console.error('❌ Нет .wasm файлов в папке!');
            res.status(404).end();// ← ВАЖНО: .end() без тела, не send()
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
// Хранилище рейтингов (файловое)
// Формат нового файла: { userId: { rating, games, lastDeltas, updatedAt } }
// Поддерживается миграция старого формата: { userId: number }
// ============================================
let ratings = {};
try {
    if (!fs.existsSync(path.dirname(RATINGS_FILE))) {
        fs.mkdirSync(path.dirname(RATINGS_FILE), { recursive: true });
    }
    if (fs.existsSync(RATINGS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf8'));
        // миграция: если значения — числа, оборачиваем в объекты
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
// Кэш Lichess + дедупликация in-flight запросов
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

    // Для очень низких — вынужденно берём минимум двух нижних (данных ниже нет)
    if (rating < 1100) return [1000, 1200];

    // Находим группу, в которую попадает игрок: allBands[idx] <= rating < allBands[idx+1]
    let idx = 0;
    for (let i = 0; i < allBands.length; i++) {
        if (allBands[i] <= rating) idx = i;
        else break;
    }

    const main = allBands[idx];
    const next = allBands[idx + 1]; // может быть undefined
    const prev = allBands[idx - 1]; // может быть undefined

    const result = [main];

    // Шаг группы (обычно 200, между 2200 и 2500 — 300)
    const step = next !== undefined ? next - main : 200;

    // Расстояние до верхней границы группы и до её начала
    const distToTop = next !== undefined ? next - rating : Infinity;
    const distToBottom = rating - main;

    // Если игрок близко к верхней границе (в верхней трети) — добавляем соседа сверху
    if (next !== undefined && distToTop <= step / 3) {
        result.push(next);
    }
    // Если близко к нижней границе (в нижней трети) — добавляем соседа снизу
    else if (prev !== undefined && distToBottom <= step / 3) {
        result.push(prev);
    }
    // Если в потолке (нет next) — добавляем соседа снизу для статистики
    else if (next === undefined && prev !== undefined) {
        result.push(prev);
    }

    return result.sort((a, b) => a - b);
}

// ============================================
// Запрос к Lichess Explorer (с дедупликацией)
// ============================================
// Внутренний запрос без логики расширения
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
            'User-Agent': 'KrakenChessTrainer/3.2'
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

// Расширяем набор bands соседями (по одному с каждой стороны)
function expandBands(bands) {
    const allBands = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
    const set = new Set(bands);
    const minIdx = allBands.indexOf(bands[0]);
    const maxIdx = allBands.indexOf(bands[bands.length - 1]);
    if (minIdx > 0) set.add(allBands[minIdx - 1]);
    if (maxIdx < allBands.length - 1) set.add(allBands[maxIdx + 1]);
    return [...set].sort((a, b) => a - b);
}

// Главная функция — с адаптивным расширением
async function fetchLichessExplorer(fen, rating) {
    let bands = getLichessRatingBands(rating);
    let data = await fetchLichessRaw(fen, bands);
    let total = (data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);

    // Если данных мало — расширяем окно (максимум 2 итерации)
    let attempts = 0;
    while (total < MIN_GAMES_FOR_BOOK && attempts < 2) {
        const expanded = expandBands(bands);
        if (expanded.length === bands.length) break; // расширять некуда
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
// KRAKEN RATING v4 — eval-based, progressive, combo-quality
// ============================================

// ============================================
// KRAKEN RATING v5 — простая CPL-формула с комбо
// ============================================

function calculateRatingDelta(rating, session) {
  const allMoves = (session.moves || []).filter(m => m.isUserMove);
  if (allMoves.length < 2) return 0;

  const r = Math.max(400, Math.min(3200, rating));
  const n = allMoves.length;
  const gamesPlayed = session.gamesPlayed || 0;

  // ═══ 1.ОЖИДАЕМЫЙ CPL для рейтинга ═══
  // ~90при 800, ~50 при 1200, ~25 при 1800, ~12 при 2500
  const expectedCPL =8+ 182 / (1 + Math.exp((r - 800) / 400));

  // ═══ 2. СРЕДНИЙ CPL ИГРОКА ═══
  const totalCPL = allMoves.reduce((s, m) => s + (m.cpl || 0), 0);
  const avgCPL = totalCPL / n;

  // ═══ 3. БАЗОВАЯ ОЦЕНКА: сравнение с ожиданием ═══
  // >0 если играл лучше ожидаемого, <0 если хуже
  const cplDiff = expectedCPL - avgCPL;

  // ═══ 4. ПРОГРЕССИВНАЯ ЧУВСТВИТЕЛЬНОСТЬ К ОШИБКАМ ═══
  // Чем выше рейтинг, тем сильнее штраф за каждый пункт CPL
  const sensitivity = 0.6 + (r / 2000);
  //800→ 1.0, 1200 → 1.2, 1800 → 1.5, 2500 → 1.85

  // ═══ 5. ПОДСЧЁТ ЗЕВКОВ (CPL > порога) ═══
  // Порог зевка снижается сростом рейтинга
  const blunderThreshold = Math.max(80, 300 - r * 0.08);
  // 800 → 236, 1200 → 204, 1800 → 156, 2500 → 100

  const blunders = allMoves.filter(m => (m.cpl || 0) > blunderThreshold);
  const blunderCount = blunders.length;

  // Штраф за зевки: прогрессивный
  let blunderPenalty = 0;
  for (const b of blunders) {
    const severity = Math.min((b.cpl || 0) / blunderThreshold, 5);
    blunderPenalty += severity * sensitivity;
  }
  // Множитель за количество зевков (3+ — больнее)
  if (blunderCount >= 3) {
    blunderPenalty *= 1 + (blunderCount - 2) * 0.2;
  }

  // ═══ 6. КОМБО-БОНУС ═══
  // Считаем серии хороших ходов (CPL ≤ goodThreshold)
  const goodThreshold = expectedCPL * 0.6;
  
  let combo = 0;
  let maxCombo = 0;
  let comboSeriesLengths = []; // все завершённые серии ≥ 3

  for (const m of allMoves) {
    const cpl = m.cpl || 0;
    if (cpl <= goodThreshold) {
      combo++;
    } else {
      //Ошибка — серия прерывается, комбо НЕ засчитывается
      if (combo >=3) {
        comboSeriesLengths.push(combo);
      }
      if (combo > maxCombo) maxCombo = combo;
      combo = 0;
    }
  }
  // Финализация последней серии
  if (combo >= 3) comboSeriesLengths.push(combo);
  if (combo > maxCombo) maxCombo = combo;

  // Бонус: только за серии ≥ 3, которые НЕ были прерваны ошибкой
  // (comboSeriesLengths содержит только завершённые серии)
  let comboBonus = 0;
  for (const len of comboSeriesLengths) {
    // √длины × 1.5, но не больше 6за одну серию
    comboBonus += Math.min(6, Math.sqrt(len) * 1.5);
  }
  // Общий лимит комбо-бонуса
  comboBonus = Math.min(12, comboBonus);

  // Бонус за идеальную партию (всеходы хорошие,≥ 4 хода)
  const perfectGame = n >= 4 && allMoves.every(m => (m.cpl || 0) <= goodThreshold);
  if (perfectGame) comboBonus += 3;

  // ═══ 7. БОНУС ЗА ТЕОРИЮ ═══
  const bookMoves = allMoves.filter(m => m.isBookMove).length;
  const bookBonus = bookMoves > 0 ? Math.min(8, Math.sqrt(bookMoves) * 2) : 0;

  // ═══ 8. СБОРКА ДЕЛЬТЫ ═══
  const calibration = 1 + 0.5 * Math.max(0, 1 - gamesPlayed / 30);
  const K = 20 * calibration;

  let delta = K * (cplDiff / expectedCPL) * sensitivity;

  // Если были зевки — бонусы НЕ применяются
  if (blunderCount === 0) {
    delta += comboBonus + bookBonus;
  } else {
    // Частичный книжный бонус если зевок был один и несильный
    if (blunderCount === 1 && blunderPenalty < 3) {
      delta += bookBonus * 0.3;
    }
    // Комбо-бонус полностью сгорает при любом зевке
  }

  delta -= blunderPenalty;

  // Гарантия: грубый зевок (≥500CPL) = всегда минус
  const hasGrossBlunder = allMoves.some(m => (m.cpl || 0) >= 500);
  if (hasGrossBlunder && delta > 0) {
    delta = Math.min(-3, -blunderPenalty * 0.5);
  }

  // ═══ 9. КОРОТКИЕ ПАРТИИ ═══
  if (n < 6) {
    delta *= 0.4+ 0.12 * n;
  }

  // ═══ 10. АНТИТИЛТ ═══
  const recent = session.recentDeltas || [];
  if (recent.length >= 3 && delta < 0) {
    const lastThree = recent.slice(-3);
    const totalLoss = lastThree.reduce((s, d) => s + Math.min(0, d), 0);
    if (totalLoss < -30) {
      delta *= 0.75; // смягчаем серию проигрышей
    }
  }

  // ═══ 11. ГРАНИЦЫ ═══
  delta = Math.max(-35, Math.min(22, delta));
  if (rating + delta < 100) delta = 100 - rating;

  delta = Math.round(delta);

  // ═══ 12. ДИАГНОСТИКА ═══
  console.log(
    `📐 Kraken v5: r=${r} | avgCPL=${avgCPL.toFixed(1)} expCPL=${expectedCPL.toFixed(1)} | ` +
    `cplDiff=${cplDiff.toFixed(1)} sens=${sensitivity.toFixed(2)} | ` +
    `blunders=${blunderCount} penalty=${blunderPenalty.toFixed(1)} | ` +
    `combo: max=${maxCombo} series=[${comboSeriesLengths}] bonus=${comboBonus.toFixed(1)} | ` +
    `book=${bookMoves} bonus=${bookBonus.toFixed(1)} | ` +
    `K=${K.toFixed(1)} | Δ=${delta >= 0 ? '+' : ''}${delta}`
  );

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
            console.log(`  ${i+1}. ${m.san} | CPL=${m.cpl} | book=${m.isBookMove} | rank=${m.popularityRank} | isUser=${m.isUserMove}`);
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

    const newRating = Math.max(400, Math.min(3200, oldRating + delta));
    const newDeltas = [...(existing.lastDeltas || []), delta].slice(-10);

    ratings[userId] = {
        rating: newRating,
        games: gamesPlayed + 1,
        lastDeltas: newDeltas,
        updatedAt: Date.now()
    };
    saveRatingsDebounced();

    console.log(`📈 ${userId}: ${oldRating} → ${newRating} (Δ${delta >= 0 ? '+' : ''}${delta}) ходов=${moves.length}`);

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

    // Тест 1: с токеном
    try {
        const resp = await axios.get(testUrl, {
            headers: {
                'Authorization': token ? `Bearer ${token}` : undefined,
                'User-Agent': 'KrakenChessTrainer/3.2',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        const total = (resp.data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
        console.log(`✅ Тест с токеном: ${resp.status}, ${total} партий`);
    } catch (e) {
        console.error(`❌ Тест с токеном ПРОВАЛЕН:`);
        if (e.response) {
            console.error(`   HTTP ${e.response.status} ${e.response.statusText}`);console.error(`   Body:`, JSON.stringify(e.response.data).slice(0, 200));
        } else {
            console.error(`   ${e.code || e.message}`);
        }
    }

    // Тест 2: без токена
    try {
        const resp = await axios.get(testUrl, {
            headers: {
                'User-Agent': 'KrakenChessTrainer/3.2',
                'Accept': 'application/json'
            },
            timeout: 10000
        });
        const total = (resp.data.moves || []).reduce((s, m) => s + m.white + m.draws + m.black, 0);
        console.log(`✅ Тест без токена: ${resp.status}, ${total} партий`);
    } catch (e) {
        console.error(`❌ Тест без токена ПРОВАЛЕН:`);
        if (e.response) {
            console.error(`   HTTP ${e.response.status} ${e.response.statusText}`);
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
});

process.on('SIGINT', () => {
    console.log(`\n💾 Сохранение рейтингов...`);
    if (saveTimer) clearTimeout(saveTimer);
    try { fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2)); } catch {}
    process.exit(0);
});



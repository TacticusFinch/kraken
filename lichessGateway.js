// ============================================================================
// Lichess Gateway v4.1 for KrakenChess
// Полное соответствие API Lichess: Keep-Alive, Single-Flight, L1/L2 Caching,
// а также умный поиск сокровищ без сетевой перегрузки.
// ============================================================================

const https = require('https');
const axios = require('axios');
const db = require('./db');

// 1. Постоянный HTTP-агент с переиспользованием сокетов (Keep-Alive)
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 25,
    maxFreeSockets: 10,
    timeout: 3000
});

const headers = {
    'User-Agent': 'KrakenChess/4.0 (contact: admin@krakenchess.ru)',
    'Accept': 'application/json'
};

const lichessToken = process.env.LICHESS_TOKEN ? process.env.LICHESS_TOKEN.trim() : null;
if (lichessToken) {
    headers['Authorization'] = `Bearer ${lichessToken}`;
}

const apiClient = axios.create({
    baseURL: 'https://explorer.lichess.ovh',
    httpsAgent,
    timeout: 4000,
    headers
});

// 2. Инициализация таблицы персистентного кэша L2 в SQLite
db.exec(`
    CREATE TABLE IF NOT EXISTS lichess_cache (
        cache_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lichess_cache_key ON lichess_cache(cache_key);
`);

const stmtGet = db.prepare('SELECT data FROM lichess_cache WHERE cache_key = ?');
const stmtSet = db.prepare('INSERT OR REPLACE INTO lichess_cache (cache_key, data, updated_at) VALUES (?, ?, ?)');

// 3. L1 In-Memory кэш
const memCache = new Map();
const MEM_CACHE_LIMIT = 3000;

// Очередь дедупликации (Single-Flight)
const inflight = new Map();

// Circuit Breaker (защита от лимита 429)
let circuitBlockedUntil = 0;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 650;

/**
 * Нормализация FEN для шахматных транспозиций
 */
function normalizeFen(fen) {
    if (!fen) return '';
    return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/**
 * Приведение рейтинга к бакетам Lichess
 */
function getRatingBands(rating) {
    const all = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
    const r = Math.max(1000, Math.min(2500, rating || 1500));
    let closest = 0, minDiff = Infinity;
    for (let i = 0; i < all.length; i++) {
        const d = Math.abs(all[i] - r);
        if (d < minDiff) { minDiff = d; closest = i; }
    }
    const start = Math.max(0, closest - 1);
    const end = Math.min(all.length, closest + 2);
    return all.slice(start, end);
}

/**
 * Главный метод получения дебютных данных с двухуровневым кэшированием
 */
async function getOpeningData(fen, rating = 1500) {
    const normFen = normalizeFen(fen);
    const bands = getRatingBands(rating);
    const cacheKey = `${normFen}|${bands.join(',')}`;

    // L1: Проверка памяти
    if (memCache.has(cacheKey)) {
        return memCache.get(cacheKey);
    }

    // L2: Проверка SQLite
    try {
        const row = stmtGet.get(cacheKey);
        if (row) {
            const parsed = JSON.parse(row.data);
            memCache.set(cacheKey, parsed);
            return parsed;
        }
    } catch (e) {
        console.error('L2 Cache read error:', e.message);
    }

    // Если Lichess временно заблокирован по 429
    if (Date.now() < circuitBlockedUntil) {
        return { moves: [], white: 0, draws: 0, black: 0 };
    }

    // Single-Flight: предотвращение дублирующих параллельных запросов
    if (inflight.has(cacheKey)) {
        return inflight.get(cacheKey);
    }

    const requestPromise = (async () => {
        try {
            const now = Date.now();
            const timeSinceLast = now - lastRequestTime;
            if (timeSinceLast < MIN_REQUEST_INTERVAL_MS) {
                await new Promise(r => setTimeout(r, MIN_REQUEST_INTERVAL_MS - timeSinceLast));
            }
            lastRequestTime = Date.now();

            const resp = await apiClient.get('/lichess', {
                params: {
                    variant: 'standard',
                    fen: fen.trim(),
                    speeds: 'blitz,rapid,classical',
                    ratings: bands.join(','),
                    moves: 15
                }
            });

            const data = resp.data || { moves: [] };

            if (data.moves && data.moves.length > 0) {
                if (memCache.size >= MEM_CACHE_LIMIT) {
                    const oldest = memCache.keys().next().value;
                    memCache.delete(oldest);
                }
                memCache.set(cacheKey, data);

                setImmediate(() => {
                    try {
                        stmtSet.run(cacheKey, JSON.stringify(data), Date.now());
                    } catch (err) {}
                });
            }

            return data;

        } catch (err) {
            console.error('❌ [LichessGateway Error]:', err.message);

            if (err.response?.status === 429) {
                const retryAfterHeader = err.response.headers?.['retry-after'];
                const waitSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 4;
                circuitBlockedUntil = Date.now() + (waitSeconds * 1000);
                console.warn(`⚠️ [Lichess] 429 Rate Limit! Блокировка на ${waitSeconds}с.`);
            }
            return { moves: [], white: 0, draws: 0, black: 0 };
        } finally {
            inflight.delete(cacheKey);
        }
    })();

    inflight.set(cacheKey, requestPromise);
    return requestPromise;
}

/**
 * Оценка Вильсона для достоверности винрейта
 */
function wilsonLowerBound(wins, total) {
    if (total <= 0) return 0;
    const z = 1.645;
    const p = wins / total;
    const denominator = 1 + (z * z) / total;
    const center = p + (z * z) / (2 * total);
    const spread = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
    return Math.max(0, (center - spread) / denominator);
}

/**
 * Извлечение сокровищ из уже имеющихся данных с учетом цвета стороны
 */
function extractTreasures(data, fen) {
    const moves = data?.moves || [];
    if (!moves.length) return [];

    const totalGames = moves.reduce((s, m) => s + (m.white || 0) + (m.draws || 0) + (m.black || 0), 0);
    if (totalGames < 35) return [];

    const fenTurn = (fen && fen.split(' ')[1]) || 'w';
    const isWhite = fenTurn === 'w';

    const getMovePoints = (m) => {
        const userWins = isWhite ? m.white : m.black;
        return userWins + 0.5 * m.draws;
    };

    const mainMove = moves[0];
    const mainGames = mainMove.white + mainMove.draws + mainMove.black;
    const mainWR = getMovePoints(mainMove) / Math.max(1, mainGames);

    return moves
        .filter((m, idx) => {
            if (idx === 0) return false;

            const count = m.white + m.draws + m.black;
            const popPercent = (count / totalGames) * 100;

            if (popPercent < 0.8 || popPercent > 12.0) return false;
            if (count < 8) return false;

            const winRate = getMovePoints(m) / count;
            const wilsonWR = wilsonLowerBound(getMovePoints(m), count);

            return (winRate >= mainWR - 0.02 || winRate >= 0.50) && wilsonWR >= 0.40;
        })
        .slice(0, 2)
        .map(m => {
            const count = m.white + m.draws + m.black;
            const rawWR = (getMovePoints(m) / count) * 100;
            const pop = (count / totalGames) * 100;

            let type = 'PEARL';
            let label = 'Жемчужина';
            let icon = '🦪';
            let points = 20;

            if (pop <= 3.0 && rawWR >= 54) {
                type = 'HIDDEN_GEM';
                label = 'Тайный бриллиант';
                icon = '💎';
                points = 50;
            } else if (pop <= 7.0 && rawWR >= 50) {
                type = 'BURIED_GOLD';
                label = 'Золото глубин';
                icon = '🪙';
                points = 35;
            }

            return {
                san: m.san,
                popularity: pop.toFixed(1),
                winRate: rawWR.toFixed(1),
                games: count,
                type,
                label,
                icon,
                points
            };
        });
}

// Экспорт всех методов наружу
module.exports = {
    getOpeningData,
    extractTreasures,
    normalizeFen
};
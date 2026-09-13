// ============================================================================
// Lichess Gateway v4.0 for KrakenChess
// Полное соответствие API Lichess: Keep-Alive, Single-Flight, L1/L2 Caching
// ============================================================================

const https = require('https');
const axios = require('axios');
const db = require('./db'); // ваш существующий sqlite db

// 1. Постоянный HTTP-агент с переиспользованием сокетов (Keep-Alive)
const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 25,
    maxFreeSockets: 10,
    timeout: 3000
});

const apiClient = axios.create({
    baseURL: 'https://explorer.lichess.ovh',
    httpsAgent,
    timeout: 3000,
    headers: {
        'User-Agent': 'KrakenChess/4.0 (https://krakenchess.ru; contact: admin@krakenchess.ru)',
        'Accept': 'application/json'
    }
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

// 3. L1 In-Memory кэш (быстрый доступ)
const memCache = new Map();
const MEM_CACHE_LIMIT = 3000;

// Очередь дедупликации (Single-Flight)
const inflight = new Map();

// Circuit Breaker (защита от бана 429)
let circuitBlockedUntil = 0;

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

    // Если Lichess в блоке 429 — не шлем запрос, спасаем игру
    if (Date.now() < circuitBlockedUntil) {
        return { moves: [], white: 0, draws: 0, black: 0 };
    }

    // Single-Flight: если идентичный запрос уже летит прямо сейчас, подсаживаемся на него
    if (inflight.has(cacheKey)) {
        return inflight.get(cacheKey);
    }

    const token = process.env.LICHESS_TOKEN;
    const requestPromise = (async () => {
        try {
            const resp = await apiClient.get('/lichess', {
                params: {
                    variant: 'standard',
                    fen: fen.trim(),
                    speeds: 'blitz,rapid,classical',
                    ratings: bands.join(','),
                    moves: 15
                }
                // Токен НЕ передаем — Explorer публичен!
            });

            const data = resp.data || { moves: [] };

            // ВАЖНО: Кэшируем ТОЛЬКО если ходы реально нашлись!
            // Никогда не кэшируем пустой ответ, чтобы не застревать в ошибке
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
            } else {
                console.warn(`⚠️ Lichess вернул 0 ходов для FEN: ${fen.substring(0, 30)}...`);
            }

            return data;

        } catch (err) {
            console.error('❌ [LichessGateway Error]:', {
                status: err.response?.status,
                statusText: err.response?.statusText,
                message: err.message,
                data: err.response?.data,
                url: err.config?.url,
                params: err.config?.params
            });

            if (err.response?.status === 429) {
                const retryAfterHeader = err.response.headers?.['retry-after'];
                const waitSeconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 30;
                circuitBlockedUntil = Date.now() + (waitSeconds * 1000);
                console.warn(`⚠️ [Lichess] 429 Rate Limit! Блокировка запросов на ${waitSeconds}с.`);
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
 * Извлечение сокровищ из уже полученных данных позиции (0 сетевых запросов)
 */
function extractTreasures(data) {
    const moves = data?.moves || [];
    if (!moves.length) return [];

    const totalGames = moves.reduce((s, m) => s + m.white + m.draws + m.black, 0);
    if (totalGames < 25) return [];

    const mainMove = moves[0];
    const mainGames = mainMove.white + mainMove.draws + mainMove.black;
    const mainWR = (mainMove.white + 0.5 * mainMove.draws) / Math.max(1, mainGames);

    return moves
        .filter((m, idx) => {
            if (idx === 0) return false; // Не первый ход
            const count = m.white + m.draws + m.black;
            const pop = (count / totalGames) * 100;
            const wr = (m.white + 0.5 * m.draws) / count;
            // Критерии: редкость до 9%, от 8 партий и винрейт не хуже главного хода
            return pop <= 9.0 && count >= 8 && wr >= (mainWR - 0.02);
        })
        .slice(0, 2)
        .map(m => {
            const count = m.white + m.draws + m.black;
            return {
                san: m.san,
                popularity: ((count / totalGames) * 100).toFixed(1),
                winRate: (((m.white + 0.5 * m.draws) / count) * 100).toFixed(1),
                games: count
            };
        });
}

module.exports = {
    getOpeningData,
    extractTreasures,
    normalizeFen
};
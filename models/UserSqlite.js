const db = require('../db');

const UserStore = {
  findById(id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (user && user.lastDeltas) {
      user.lastDeltas = JSON.parse(user.lastDeltas);
    }
    return user;
  },

  findByEmail(email) {
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user && user.lastDeltas) {
      user.lastDeltas = JSON.parse(user.lastDeltas);
    }
    return user;
  },

  findByUsername(username) {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (user && user.lastDeltas) {
      user.lastDeltas = JSON.parse(user.lastDeltas);
    }
    return user;
  },

  findByLichessId(lichessId) {
    const user = db.prepare('SELECT * FROM users WHERE lichessId = ?').get(lichessId);
    if (user && user.lastDeltas) {
      user.lastDeltas = JSON.parse(user.lastDeltas);
    }
    return user;
  },

  create({ username, email, passwordHash, lichessId, lichessAccessToken }) {
    const stmt = db.prepare(`
      INSERT INTO users (username, email, passwordHash, lichessId, lichessAccessToken)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      username,
      email || null,
      passwordHash || null,
      lichessId || null,
      lichessAccessToken || null
    );
    return this.findById(result.lastInsertRowid);
  },

  updateRating(id, rating, games, lastDeltas) {
    db.prepare(`
      UPDATE users 
      SET rating = ?, games = ?, lastDeltas = ?, updatedAt = datetime('now')
      WHERE id = ?
    `).run(rating, games, JSON.stringify(lastDeltas), id);
    return this.findById(id);
  },

  updateLichessToken(id, token) {
    db.prepare(`
      UPDATE users SET lichessAccessToken = ?, updatedAt = datetime('now') 
      WHERE id = ?
    `).run(token, id);
  }
};

module.exports = UserStore;
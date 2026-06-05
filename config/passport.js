const LocalStrategy = require('passport-local').Strategy;
const bcrypt = require('bcryptjs');
const UserStore = require('../models/UserSqlite');

module.exports = function(passport) {

  // Сериализация: сохраняем только id в сессию
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Десериализация: достаём юзера по id
  passport.deserializeUser((id, done) => {
    try {
      const user = UserStore.findById(id);
      done(null, user || false);
    } catch (err) {
      done(err);
    }
  });

  // Стратегия: логин по email + пароль
  passport.use(new LocalStrategy(
    { usernameField: 'email' },
    async (email, password, done) => {
      try {
        const user = UserStore.findByEmail(email);
        if (!user) {
          return done(null, false, { message: 'Пользователь не найден' });
        }
        if (!user.passwordHash) {
          return done(null, false, { message: 'Используйте вход через Lichess' });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
          return done(null, false, { message: 'Неверный пароль' });
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  ));
};
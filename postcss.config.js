// postcss.config.js
const isProduction = process.env.NODE_ENV === 'production';

module.exports = {
  plugins: [
    // Склеивает все @import в один файл
    require('postcss-import'),

    // Минификация — только при сборке
    ...(isProduction
      ? [require('cssnano')({
          preset: ['default', {
            // Не перенумеровывать z-index (критично для слоёв!)
            zindex: false,
            // Не переименовывать @keyframes
            reduceIdents: false,
            // Не трогать CSS-переменные
            colormin: false
          }]
        })]
      : [])
  ]
};
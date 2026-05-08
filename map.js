/* ═══════════════════════════════════════════
   КАРТА ДЕБЮТОВ — OPENING MAP CONTROLLER
   ═══════════════════════════════════════════ */

const OpeningMap = (() => {
    let container, img, toggleBtn, zoomBtn, toggleText;
    let isVisible = false;
    let isFullscreen = false;
    let isBackground = true; // По умолчанию — полупрозрачный фон
    let currentMarker = null;

    // Координаты дебютов на карте (настройте под вашу карту!)
    // Формат: { "ECO или название": { x: процент, y: процент } }
    const openingCoordinates = {
        // Открытые дебюты
        "Italian Game": { x: 25, y: 30 },
        "Ruy Lopez": { x: 30, y: 25 },
        "Scotch Game": { x: 20, y: 35 },
        "King's Gambit": { x: 15, y: 40 },
        "Petrov's Defense": { x: 35, y: 30 },
        
        // Полуоткрытые
        "Sicilian Defense": { x: 50, y: 20 },
        "French Defense": { x: 55, y: 30 },
        "Caro-Kann": { x: 60, y: 25 },
        "Pirc Defense": { x: 65, y: 35 },
        // Закрытые
        "Queen's Gambit": { x: 40, y: 55 },
        "King's Indian": { x: 50, y: 60 },
        "Nimzo-Indian": { x: 55, y: 65 },
        "Grünfeld Defense": { x: 45, y: 70 },
        
        // Фланговые
        "English Opening": { x: 70, y: 50 },
        "Réti Opening": { x: 75, y: 55 },
        "Bird's Opening": { x: 80, y: 45 },
        
        // Дефолт
        "Starting Position": { x: 50, y: 50 }
    };

    function init() {
        container = document.getElementById('opening-map-container');
        img = document.getElementById('opening-map-img');
        toggleBtn = document.getElementById('toggle-map-btn');
        zoomBtn = document.getElementById('zoom-map-btn');
        toggleText = document.getElementById('map-toggle-text');

        if (!container || !toggleBtn) return;

        // По умолчанию — карта как полупрозрачный фон
        container.classList.add('as-background', 'visible');

        // Обработчики
        toggleBtn.addEventListener('click', toggleMap);
        zoomBtn.addEventListener('click', toggleFullscreen);

        // Закрытие полноэкранного режима по клику
        container.addEventListener('click', (e) => {
            if (isFullscreen && e.target !== zoomBtn) {
                toggleFullscreen();
            }
        });

        // ESC для закрытия
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (isFullscreen) toggleFullscreen();
                else if (isVisible && !isBackground) hideMap();
            }
        });

        console.log('🗺️ Opening Map initialized');
    }

    function toggleMap() {
        if (isBackground) {
            // Переключаем из фонового режима в полный показ
            container.classList.remove('as-background');
            container.classList.add('visible');
            isBackground = false;
            isVisible = true;
            toggleBtn.classList.add('active');
            toggleText.textContent ='Доска';
        } else if (isVisible) {
            // Скрываем карту, возвращаем в фоновый режим
            container.classList.remove('visible');
            setTimeout(() => {
                container.classList.add('as-background', 'visible');
                isBackground = true;
                isVisible = false;
                toggleBtn.classList.remove('active');
                toggleText.textContent = 'Карта';
            }, 300);
        }
    }

    function showMap() {
        container.classList.remove('as-background');
        container.classList.add('visible');
        isVisible = true;
        isBackground = false;
        toggleBtn.classList.add('active');
        toggleText.textContent = 'Доска';
    }

    function hideMap() {
        container.classList.add('as-background');
        isVisible = false;
        isBackground = true;
        toggleBtn.classList.remove('active');
        toggleText.textContent = 'Карта';
    }

    function toggleFullscreen() {
        if (isFullscreen) {
            container.classList.remove('fullscreen');
            isFullscreen = false;
        } else {
            container.classList.remove('as-background');
            container.classList.add('visible', 'fullscreen');
            isFullscreen = true;
            isVisible = true;
            isBackground = false;
        }
    }

    // Обновить маркер текущего дебюта на карте
    function updateMarker(openingName) {
        // Удаляем старый маркер
        if (currentMarker) {
            currentMarker.remove();
        }

        // Ищем координаты
        let coords = openingCoordinates[openingName];
        
        // Если точного совпадения нет —ищем частичное
        if (!coords) {
            for (const [key, val] of Object.entries(openingCoordinates)) {
                if (openingName.toLowerCase().includes(key.toLowerCase()) ||
                    key.toLowerCase().includes(openingName.toLowerCase())) {
                    coords = val;
                    break;
                }
            }
        }

        if (!coords) coords = openingCoordinates["Starting Position"];

        // Создаём маркер
        currentMarker = document.createElement('div');
        currentMarker.className = 'map-marker';
        currentMarker.style.left = coords.x + '%';
        currentMarker.style.top = coords.y + '%';
        
        // Подпись
        const label = document.createElement('div');
        label.className = 'map-marker-label';
        label.textContent = openingName;
        currentMarker.appendChild(label);

        container.appendChild(currentMarker);

        // Подсветка карты при смене дебюта
        if (isBackground) {
            container.classList.add('flash-hint');
            setTimeout(() => container.classList.remove('flash-hint'), 1500);
        }
    }

    // Публичный API
    return {
        init,
        show: showMap,
        hide: hideMap,
        toggle: toggleMap,
        updateMarker,
        toggleFullscreen
    };
})();

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
    OpeningMap.init();
});

// Интеграция с основным скриптом:
// Вызывайте OpeningMap.updateMarker("Sicilian Defense") 
// когда определяется дебют в партии
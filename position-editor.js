//============================================
// Position Editor — Kraken
//============================================

(function() {
    'use strict';

    var editorBoard = null;
    var editorPosition = {};
    var selectedPiece = 'trash';
    var editorOrientation = 'white';
    var isOpen = false;

    var PIECE_TO_FEN = {
        wK: 'K', wQ: 'Q', wR: 'R', wB: 'B', wN: 'N', wP: 'P',
        bK: 'k', bQ: 'q', bR: 'r', bB: 'b', bN: 'n', bP: 'p'
    };

    var FEN_TO_PIECE = {};
    Object.keys(PIECE_TO_FEN).forEach(function(k) {
        FEN_TO_PIECE[PIECE_TO_FEN[k]] = k;
    });

    var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

    //═══ Инициализация ═══
    function init() {
        bindEvents();
        console.log('♟PositionEditor initialized');
    }

    function bindEvents() {
        var $btn = $('#btn-setup-position');
        if ($btn.length === 0) {
            console.warn('PositionEditor: кнопка #btn-setup-position не найдена');
            return;
        }

        $btn.on('click', open);
        $('#pe-close').on('click', close);
        $('#pe-cancel').on('click', close);

        $('#position-editor-modal').on('click', function(e) {
            if ($(e.target).is('#position-editor-modal')) close();
        });

        $(document).on('keydown', function(e) {
            if (e.key === 'Escape' && isOpen) close();
        });

        $('.pe-palette-piece').on('click', function() {
            selectPalettePiece($(this).data('piece'));
        });

        $('#pe-flip-board').on('click', flipBoard);

        $('.pe-btn-preset').on('click', function() {
            var fen = $(this).data('fen');
            if (fen) loadFEN(fen);
        });

        $('#pe-fen-apply').on('click', function() {
            var fen = $('#pe-fen-input').val().trim();
            if (fen) loadFEN(fen);
        });

        $('#pe-fen-input').on('keydown', function(e) {
            if (e.key === 'Enter') {
                var fen = $(this).val().trim();
                if (fen) loadFEN(fen);
            }
        });

        $('#pe-fen-copy').on('click', function() {
            var fen = buildFEN();
            var $b = $(this);
            if (navigator.clipboard) {
                navigator.clipboard.writeText(fen).then(function() {
                    $b.text('✓');
                    setTimeout(function() { $b.text('📋'); }, 1200);
                });
            } else {
                $('#pe-fen-input').select();
                document.execCommand('copy');
            }
        });

        $('input[name="pe-turn"]').on('change', updateFENDisplay);
        $('#pe-castle-K, #pe-castle-Q, #pe-castle-k, #pe-castle-q').on('change', updateFENDisplay);
        $('#pe-move-number').on('change input', updateFENDisplay);

        $('#pe-start-white').on('click', function() {
            startFromEditor('white');
        });
        $('#pe-start-black').on('click', function() {
            startFromEditor('black');
        });}

    // ═══ Открытие / закрытие ═══
    function open() {
        isOpen = true;

        if (!editorBoard) {
            createEditorBoard();
        }

        var currentFEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
        if (typeof game !== 'undefined' && game && game.fen) {
            currentFEN = game.fen();
        }
        loadFEN(currentFEN);selectPalettePiece('trash');

        $('#position-editor-modal').addClass('show');

        setTimeout(function() {
            if (editorBoard) editorBoard.resize();
        }, 150);
    }

    function close() {
        isOpen = false;
        $('#position-editor-modal').removeClass('show');
    }

    // ═══ Доска редактора ═══
    function createEditorBoard() {
        editorBoard = Chessboard('pe-board', {
            draggable: true,
            dropOffBoard: 'trash',
            sparePieces: false,
            position: 'start',
            orientation: editorOrientation,
            pieceTheme: '/chesspieces/alpha/{piece}.png',
            onDrop: onEditorDrop,
            onDragStart: onEditorDragStart,
            onMouseoutSquare: onEditorMouseout,
            onMouseoverSquare: onEditorMouseover
        });

        setupEditorClicks();
    }

    function setupEditorClicks() {
        var $board = $('#pe-board');

        $board.on('mousedown', '.square-55d63', function(e) {
            if (e.which !== 1) return;

            var square = getSquareFromEl(this);
            if (!square) return;

            var currentPiece = editorPosition[square];

            if (selectedPiece === 'trash') {
                if (currentPiece) {
                    delete editorPosition[square];
                    editorBoard.position(editorPosition, false);
                    updateFENDisplay();
                }
            } else if (selectedPiece) {
                if (currentPiece === selectedPiece) {
                    delete editorPosition[square];
                } else {
                    editorPosition[square] = selectedPiece;
                }
                editorBoard.position(editorPosition, false);
                updateFENDisplay();
            }
        });

        $board.on('contextmenu', '.square-55d63', function(e) {
            e.preventDefault();
            var square = getSquareFromEl(this);
            if (square && editorPosition[square]) {
                delete editorPosition[square];
                editorBoard.position(editorPosition, false);
                updateFENDisplay();
            }
        });
    }

    function getSquareFromEl(el) {
        var $sq = $(el).closest('.square-55d63');
        if (!$sq.length) return null;
        var ds = $sq.attr('data-square');
        if (ds) return ds;
        var classes = ($sq.attr('class') || '').split(/\s+/);
        for (var i = 0; i < classes.length; i++) {
            var match = classes[i].match(/^square-([a-h][1-8])$/);
            if (match) return match[1];
        }
        return null;
    }

    function onEditorDragStart() {
        return true;
    }

    function onEditorDrop(source, target, piece, newPos) {
        editorPosition = {};
        if (newPos && typeof newPos === 'object') {
            Object.keys(newPos).forEach(function(sq) {
                editorPosition[sq] = newPos[sq];
            });
        }
        updateFENDisplay();
    }

    function onEditorMouseover(square) {
        if (!isOpen) return;
        $('#pe-board .square-' + square).addClass('pe-square-hover');
    }

    function onEditorMouseout() {
        $('#pe-board .pe-square-hover').removeClass('pe-square-hover');
    }

    // ═══ Палитра ═══
    function selectPalettePiece(piece) {
        selectedPiece = piece;
        $('.pe-palette-piece').removeClass('active');
        $('.pe-palette-piece[data-piece="' + piece + '"]').addClass('active');
    }

    function flipBoard() {
        editorOrientation = editorOrientation === 'white' ? 'black' : 'white';
        editorBoard.orientation(editorOrientation);
    }

    // ═══ FEN ═══
    function buildFEN() {
        var boardPart = positionToFENBoard(editorPosition);
        var turn = $('input[name="pe-turn"]:checked').val() || 'w';

        var castling = '';
        if ($('#pe-castle-K').is(':checked')) castling += 'K';
        if ($('#pe-castle-Q').is(':checked')) castling += 'Q';
        if ($('#pe-castle-k').is(':checked')) castling += 'k';
        if ($('#pe-castle-q').is(':checked')) castling += 'q';
        if (!castling) castling = '-';

        var fullmove = parseInt($('#pe-move-number').val()) || 1;

        return boardPart + ' ' + turn + ' ' + castling + ' - 0 ' + fullmove;
    }

    function positionToFENBoard(pos) {
        var fen = '';
        for (var r = 8; r >= 1; r--) {
            var empty = 0;
            for (var f = 0; f < 8; f++) {
                var sq = FILES[f] + r;
                var piece = pos[sq];
                if (piece) {
                    if (empty > 0) { fen += empty; empty = 0; }
                    fen += PIECE_TO_FEN[piece] || '?';
                } else {
                    empty++;
                }
            }
            if (empty > 0) fen += empty;
            if (r > 1) fen += '/';
        }
        return fen;
    }

    function loadFEN(fen) {
        var $error = $('#pe-fen-error');
        $error.addClass('hidden').text('');fen = (fen || '').trim();
        if (!fen) return;

        var parts = fen.split(/\s+/);
        var boardPart = parts[0];
        var turn = parts[1] || 'w';
        var castling = parts[2] || 'KQkq';
        var fullmove = parseInt(parts[5]) || 1;

        var newPosition = fenBoardToPosition(boardPart);
        if (newPosition === null) {
            $error.text('❌ Некорректная расстановка фигур').removeClass('hidden');
            return;
        }

        editorPosition = newPosition;
        editorBoard.position(editorPosition, false);

        $('input[name="pe-turn"][value="' + turn + '"]').prop('checked', true);

        $('#pe-castle-K').prop('checked', castling.indexOf('K') >= 0);
        $('#pe-castle-Q').prop('checked', castling.indexOf('Q') >= 0);
        $('#pe-castle-k').prop('checked', castling.indexOf('k') >= 0);
        $('#pe-castle-q').prop('checked', castling.indexOf('q') >= 0);

        $('#pe-move-number').val(fullmove);updateFENDisplay();
    }

    function fenBoardToPosition(boardFEN) {
        var pos = {};
        var rows = boardFEN.split('/');
        if (rows.length !== 8) return null;

        for (var r = 0; r < 8; r++) {
            var rank = 8 - r;
            var fileIdx = 0;
            for (var c = 0; c < rows[r].length; c++) {
                var ch = rows[r][c];
                if (ch >= '1' && ch <= '8') {
                    fileIdx += parseInt(ch);
                } else {
                    var piece = FEN_TO_PIECE[ch];
                    if (!piece) return null;
                    if (fileIdx >= 8) return null;
                    var sq = FILES[fileIdx] + rank;
                    pos[sq] = piece;
                    fileIdx++;
                }
            }if (fileIdx !== 8) return null;
        }
        return pos;
    }

    function updateFENDisplay() {
        var fen = buildFEN();
        $('#pe-fen-input').val(fen);
        validatePosition();autoFixCastling();
    }

    function validatePosition() {
        var $validation = $('#pe-validation');
        var errors = [];
        var warnings = [];

        var whiteKings = 0, blackKings = 0;
        var whitePawns = 0, blackPawns = 0;

        Object.keys(editorPosition).forEach(function(sq) {
            var piece = editorPosition[sq];
            var color = piece[0];
            var type = piece[1];
            var rank = sq[1];

            if (color === 'w') {
                if (type === 'K') whiteKings++;
                if (type === 'P') {
                    whitePawns++;
                    if (rank === '1' || rank === '8') errors.push('Белая пешка на невозможной горизонтали');
                }
            } else {
                if (type === 'K') blackKings++;
                if (type === 'P') {
                    blackPawns++;
                    if (rank === '1' || rank === '8') errors.push('Чёрная пешка на невозможной горизонтали');
                }
            }
        });

        if (whiteKings === 0) errors.push('Нет белого короля');
        if (blackKings === 0) errors.push('Нет чёрного короля');
        if (whiteKings > 1) errors.push('Больше одного белого короля');
        if (blackKings > 1) errors.push('Больше одного чёрного короля');
        if (whitePawns > 8) warnings.push('Больше 8 белых пешек');
        if (blackPawns > 8) warnings.push('Больше 8 чёрных пешек');

        if (errors.length > 0) {
            $validation.removeClass('hidden pe-valid pe-warning').addClass('pe-invalid')
                .html('❌ ' + errors.join('<br>❌ '));
            $('#pe-start-white, #pe-start-black').prop('disabled', true).css('opacity', 0.5);
        } else if (warnings.length > 0) {
            $validation.removeClass('hidden pe-invalid pe-valid').addClass('pe-warning')
                .html('⚠️ ' + warnings.join('<br>⚠️ '));
            $('#pe-start-white, #pe-start-black').prop('disabled', false).css('opacity', 1);
        } else if (Object.keys(editorPosition).length > 0) {
            $validation.removeClass('hidden pe-invalid pe-warning').addClass('pe-valid')
                .text('✅ Позиция легальна');
            $('#pe-start-white, #pe-start-black').prop('disabled', false).css('opacity', 1);
        } else {
            $validation.addClass('hidden');
            $('#pe-start-white, #pe-start-black').prop('disabled', true).css('opacity', 0.5);
        }
    }

    function autoFixCastling() {
        if (editorPosition['e1'] !== 'wK') {
            $('#pe-castle-K').prop('checked', false);
            $('#pe-castle-Q').prop('checked', false);
        }
        if (editorPosition['h1'] !== 'wR') {
            $('#pe-castle-K').prop('checked', false);}
        if (editorPosition['a1'] !== 'wR') {
            $('#pe-castle-Q').prop('checked', false);
        }
        if (editorPosition['e8'] !== 'bK') {
            $('#pe-castle-k').prop('checked', false);
            $('#pe-castle-q').prop('checked', false);
        }if (editorPosition['h8'] !== 'bR') {
            $('#pe-castle-k').prop('checked', false);
        }
        if (editorPosition['a8'] !== 'bR') {
            $('#pe-castle-q').prop('checked', false);
        }
    }

    function startFromEditor(color) {
        var fen = buildFEN();

        var testGame = new Chess();
        if (!testGame.load(fen)) {
            $('#pe-fen-error').text('❌ Позиция нелегальна').removeClass('hidden');
            return;
        }

        close();

        if (typeof startGameFromFEN === 'function') {
            startGameFromFEN(fen, color);
        } else {
            console.error('startGameFromFEN не найдена в script.js');
            alert('Добавьте функцию startGameFromFEN в script.js');
        }
    }

    // ═══ Экспорт ═══
    window.PositionEditor = {
        init: init,
        open: open,
        close: close,
        loadFEN: loadFEN,
        buildFEN: buildFEN
    };

    // ═══ Автоинициализация ═══
    $(document).ready(function() {
        window.PositionEditor.init();
    });

})();
self.Module = {
    locateFile: function(path) {
        console.log('🔍 locateFile called with:', path);
        if (path.endsWith('.wasm')) {
            return '/stockfish-18-lite-single.wasm';
        }
        return path;
    }
};
importScripts('/stockfish-18-lite-single.js');
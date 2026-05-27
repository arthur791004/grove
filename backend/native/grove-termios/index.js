'use strict';

// Load the prebuilt .node file. node-gyp puts the output at
// build/Release/grove_termios.node by default. Wrap in try/catch so the
// backend can still boot even if the addon failed to compile — we just lose
// the auto-detect feature and fall back to the regex heuristic.

let impl = { getTermios: () => null };
try {
  impl = require('./build/Release/grove_termios.node');
} catch (err) {
  console.warn('[grove-termios] native addon unavailable:', err && err.message);
}

module.exports = impl;

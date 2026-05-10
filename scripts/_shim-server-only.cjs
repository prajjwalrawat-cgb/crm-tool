// Tsx-side shim for the `server-only` package guard. The selftest
// scripts import from app modules that mark themselves with
// `import 'server-only'`, which throws unless invoked from an RSC. We
// intercept the resolution and return an empty module instead.
//
// Usage:
//   pnpm tsx --require ./scripts/_shim-server-only.cjs scripts/selftest-X.ts
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'server-only' || request === 'client-only') {
    // Resolve to a known-empty file to satisfy the require call.
    return require.resolve('./_empty.cjs');
  }
  return originalResolve.call(this, request, ...rest);
};

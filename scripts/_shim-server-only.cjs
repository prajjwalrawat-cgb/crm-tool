/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS preload for tsx */
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

// tsx loads ESM-only packages through its CommonJS loader, which resolves
// with the "require" condition. @react-pdf/textkit imports
// `@react-pdf/hyphenate/<lang>`, whose exports map only has an "import"
// condition, so the CJS resolve fails. Fall back to the file that the
// "import" condition points at (lib/<lang>.js). Only used by self-tests;
// Next loads @react-pdf/renderer natively (serverExternalPackages).
const path = require('path');
const fs = require('fs');
const resolveWithShims = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try {
    return resolveWithShims.call(this, request, parent, ...rest);
  } catch (e) {
    const m = /^(@react-pdf\/hyphenate)\/([\w-]+)$/.exec(request);
    if (e && e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' && m && parent && parent.filename) {
      for (const dir of Module._nodeModulePaths(path.dirname(parent.filename))) {
        const file = path.join(dir, m[1], 'lib', `${m[2]}.js`);
        if (fs.existsSync(file)) return file;
      }
    }
    throw e;
  }
};

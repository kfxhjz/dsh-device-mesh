// Package entry. The Host plugin is bundled into lib/host/index.js by
// scripts/build.mjs; this file only re-exports it so the Loader row can resolve
// the package's main entry without a build step changing package.json.
export * from './lib/host/index.js'

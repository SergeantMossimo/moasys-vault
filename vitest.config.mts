import { defineConfig } from 'vitest/config'

// MOASYS-Vault Vitest config. Tests live under test/, source under src/.
// A handful of files are excluded from coverage — orchestrators and external-
// process wrappers covered by the manual `npm run scan:all` smoke test instead.

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Explicit imports keep tests readable — no globals.
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // Top-level runners — covered by the smoke test, not unit tests.
        'src/scan.ts',
        'src/validate/runner.ts',
        // External-process / network wrappers (spawn, fetch, 3rd-party).
        // Mocking these is high-effort, low-value vs. the smoke test.
        'src/probe/ffprobe.ts',
        'src/probe/id3.ts',
        'src/validate/tmdb.ts',
        // Type-only files — coverage % is misleading.
        'src/probe/types.ts',
        'src/validate/types.ts',
      ],
    },
  },
})

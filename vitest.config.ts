import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    // `vi.fn()`/`vi.spyOn()` mocks (e.g. fakeArrClient's, or acquire-run.test.ts's
    // `AcquireRecords.prototype.insert` spy) reset automatically between tests instead of
    // leaking call history or overridden implementations into the next test in the file.
    restoreMocks: true,
    // Explicit rather than relying on the default: each test file runs in its own isolated
    // module/worker context, so module-level state (e.g. tests/helpers.ts's `createdDirs`/
    // `openDbs` arrays backing `cleanupTmpDirs()`) never leaks across files.
    isolate: true,
  },
});

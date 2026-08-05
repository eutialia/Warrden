import { afterAll } from 'vitest';
import { cleanupTmpDirs } from './helpers.js';

afterAll(() => {
  cleanupTmpDirs();
});

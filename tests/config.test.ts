import { describe, it, expect } from 'vitest';
import { loadConfig, saveConfig, ConfigError } from '../src/config/store.js';
import { tmpDir as tmp } from './helpers.js';

describe('config store', () => {
  it('creates defaults on first load', () => {
    const cfg = loadConfig(tmp());
    expect(cfg.server.port).toBe(9797);
    expect(cfg.arrs).toEqual([]);
    expect(cfg.llm.activeProfile).toBe('prod');
    expect(cfg.reconcileIntervalMinutes).toBe(15);
  });
  it('round-trips saved config', () => {
    const dir = tmp();
    const cfg = loadConfig(dir);
    cfg.picking.tags = ['CHS subs', 'prefer dual audio'];
    cfg.arrs.push({ name: 'sonarr', kind: 'sonarr', baseUrl: 'http://sonarr:8989', apiKey: 'k' });
    saveConfig(dir, cfg);
    expect(loadConfig(dir)).toEqual(cfg);
  });
  it('rejects invalid config with ConfigError', () => {
    const dir = tmp();
    const cfg = loadConfig(dir);
    // @ts-expect-error deliberately invalid
    cfg.arrs.push({ name: 'x', kind: 'sonarr', baseUrl: 'not-a-url', apiKey: '' });
    expect(() => saveConfig(dir, cfg)).toThrow(ConfigError);
  });
});

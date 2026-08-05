import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('does not share nested default structure (llm.profiles) across parses', () => {
    // Zod v4 shallow-clones a literal default per parse: the top-level object/array
    // is already fresh every time, but anything nested inside it is the same shared
    // reference across parses. `llm.profiles` (`{ dev: {...}, prod: {...} }`) is the
    // real regression this guards — a literal default here would share `profiles.dev`
    // across every config loaded in-process. The `arrs`/`pathMappings`/`picking.tags`
    // assertions below don't independently prove the bug (those defaults have no
    // nested structure, so even a literal `.default([])` gives a fresh array each
    // parse) — they're kept for defense-in-depth since the factory form is applied
    // uniformly to all of them.
    const cfgA = loadConfig(tmp());
    const cfgB = loadConfig(tmp());

    cfgA.arrs.push({ name: 'sonarr', kind: 'sonarr', baseUrl: 'http://sonarr:8989', apiKey: 'k' });
    cfgA.llm.profiles.dev['release-pick'] = { provider: 'anthropic', model: 'claude' };
    cfgA.pathMappings.push({ from: '/a', to: '/b' });
    cfgA.picking.tags.push('CHS subs');

    expect(cfgA.arrs).not.toBe(cfgB.arrs);
    expect(cfgB.arrs).toEqual([]);
    expect(cfgA.llm.profiles.dev).not.toBe(cfgB.llm.profiles.dev);
    expect(cfgB.llm.profiles.dev).toEqual({});
    expect(cfgA.pathMappings).not.toBe(cfgB.pathMappings);
    expect(cfgB.pathMappings).toEqual([]);
    expect(cfgA.picking.tags).not.toBe(cfgB.picking.tags);
    expect(cfgB.picking.tags).toEqual([]);
  });

  it.each([
    {
      scenario: 'invalid field value written via saveConfig',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        cfg.arrs.push({ name: 'x', kind: 'sonarr', baseUrl: 'not-a-url', apiKey: '' });
        return () => saveConfig(dir, cfg);
      },
    },
    {
      scenario: 'malformed JSON on disk',
      setup: (dir: string) => {
        loadConfig(dir); // ensures the dir and config.json exist
        writeFileSync(join(dir, 'config.json'), '{ not valid json');
        return () => loadConfig(dir);
      },
    },
  ])('rejects invalid config with ConfigError: $scenario', ({ setup }) => {
    const dir = tmp();
    const run = setup(dir);
    expect(run).toThrow(ConfigError);
  });
});

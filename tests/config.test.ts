import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, saveConfig, ConfigError } from '../src/config/store.js';
import { ConfigSchema } from '../src/config/schema.js';
import { tmpDir as tmp } from './helpers.js';

describe('config store', () => {
  it('creates defaults on first load', () => {
    const cfg = loadConfig(tmp());
    expect(cfg.server.port).toBe(9797);
    expect(cfg.server.publicUrl).toMatch(/^https?:\/\/.+:9797$/);
    expect(cfg.arrs).toEqual([]);
    expect(cfg.llm.model).toBeUndefined();
    expect(cfg.reconcileIntervalMinutes).toBe(15);
    expect(cfg.storage).toEqual({ series: '/tv', anime: '/anime', movies: '/movies', downloads: '/downloads' });
  });

  it('round-trips saved config', () => {
    const dir = tmp();
    const cfg = loadConfig(dir);
    cfg.picking.prefer = ['CHS subs', 'dual audio'];
    cfg.picking.avoid = ['HEVC re-encodes'];
    cfg.arrs.push({ name: 'sonarr', kind: 'sonarr', baseUrl: 'http://sonarr:8989', apiKey: 'k' });
    cfg.pathMappings.push({ from: '/mnt/nas/downloads', to: '/downloads' });
    saveConfig(dir, cfg);
    expect(loadConfig(dir)).toEqual(cfg);
    // A fresh parse must not see the mutation above: proves pathMappings' default isn't
    // a shared reference across parses.
    expect(loadConfig(tmp()).pathMappings).toEqual([]);
  });

  it('does not share nested default structure across parses', () => {
    // Zod v4 shallow-clones a literal default per parse: the top-level object/array
    // is already fresh every time, but anything nested inside it is the same shared
    // reference across parses. Every object/array default here uses the factory form
    // (`() => ...`) so the safety is structural rather than case-by-case, and this
    // guards that it stays that way: mutate one parse's defaults, the other must not
    // see them.
    const cfgA = loadConfig(tmp());
    const cfgB = loadConfig(tmp());

    cfgA.arrs.push({ name: 'sonarr', kind: 'sonarr', baseUrl: 'http://sonarr:8989', apiKey: 'k' });
    cfgA.pathMappings.push({ from: '/a', to: '/b' });
    cfgA.picking.prefer.push('CHS subs');
    cfgA.picking.avoid.push('HEVC re-encodes');
    cfgA.subtitle.sites.push({ baseUrl: 'https://acg.rip' });
    cfgA.llm.keys.openrouter = 'k';

    expect(cfgA.arrs).not.toBe(cfgB.arrs);
    expect(cfgB.arrs).toEqual([]);
    expect(cfgA.pathMappings).not.toBe(cfgB.pathMappings);
    expect(cfgB.pathMappings).toEqual([]);
    expect(cfgA.picking.prefer).not.toBe(cfgB.picking.prefer);
    expect(cfgB.picking.prefer).toEqual([]);
    expect(cfgA.picking.avoid).not.toBe(cfgB.picking.avoid);
    expect(cfgB.picking.avoid).toEqual([]);
    expect(cfgA.subtitle.sites).not.toBe(cfgB.subtitle.sites);
    expect(cfgB.subtitle.sites).toEqual([]);
    expect(cfgA.llm.keys).not.toBe(cfgB.llm.keys);
    expect(cfgB.llm.keys).toEqual({});
  });

  it('leaves llm.model unset on a fresh config and keeps a configured one through a round-trip', () => {
    const dir = tmp();
    const cfg = loadConfig(dir);
    expect(cfg.llm.model).toBeUndefined();
    cfg.llm.model = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' };
    saveConfig(dir, cfg);
    expect(loadConfig(dir).llm.model).toEqual(cfg.llm.model);
  });

  it.each([
    { scenario: 'a blank model id', model: { provider: 'openrouter', model: '' } },
    { scenario: 'a provider this build no longer supports', model: { provider: 'claude-code', model: 'opus' } },
    { scenario: 'a provider this build dropped for OpenRouter-only', model: { provider: 'openai', model: 'gpt-5' } },
  ])('degrades an unusable llm.model to unset at boot rather than failing to load: $scenario', ({ model }) => {
    // A config.json written by an older build must never stop the server from booting,
    // because the settings UI that would fix it is served by that same server. Unset is the
    // documented "no model configured" state.
    const dir = tmp();
    loadConfig(dir); // writes the default config.json
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ llm: { model } }));
    expect(loadConfig(dir).llm.model).toBeUndefined();
  });

  it.each([
    { scenario: 'a blank model id', model: { provider: 'openrouter', model: '' } },
    { scenario: 'a provider this build no longer supports', model: { provider: 'claude-code', model: 'opus' } },
    { scenario: 'a provider this build dropped for OpenRouter-only', model: { provider: 'openai', model: 'gpt-5' } },
  ])('rejects that same unusable llm.model everywhere except boot: $scenario', ({ model }) => {
    // The boot tolerance above is for a file already on disk. A caller handing us one now
    // (a save, a PUT) gets told, rather than watching its model vanish into "unset".
    expect(ConfigSchema.safeParse({ llm: { model } }).success).toBe(false);
    expect(() => saveConfig(tmp(), { ...ConfigSchema.parse({}), llm: { keys: {}, model: model as never } })).toThrow(ConfigError);
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'keeps llm.model.effort "%s" through a round-trip',
    (effort) => {
      const dir = tmp();
      const cfg = loadConfig(dir);
      cfg.llm.model = { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731', effort };
      saveConfig(dir, cfg);
      expect(loadConfig(dir).llm.model).toEqual({
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash-0731',
        effort,
      });
    },
  );

  it('parses a model with no effort, so config.json files written before it existed stay valid', () => {
    const cfg = ConfigSchema.parse({ llm: { model: { provider: 'openrouter', model: 'x' } } });
    expect(cfg.llm.model).toEqual({ provider: 'openrouter', model: 'x' });
    expect(cfg.llm.model?.effort).toBeUndefined();
  });

  it('rejects an effort level outside the six OpenRouter accepts', () => {
    expect(ConfigSchema.safeParse({ llm: { model: { provider: 'openrouter', model: 'x', effort: 'ultra' } } }).success).toBe(
      false,
    );
  });

  it('drops the legacy `fallback` model rather than failing to load', () => {
    // Same shape as the `profiles` case below: an unknown key is stripped, not an error,
    // so a config still carrying the removed fallback model keeps its primary model.
    const cfg = ConfigSchema.parse({
      llm: { model: { provider: 'openrouter', model: 'x', fallback: { provider: 'openrouter', model: 'y' } } },
    });
    expect(cfg.llm.model).toEqual({ provider: 'openrouter', model: 'x' });
  });

  it('drops a legacy per-callsite `profiles` block rather than failing to load', () => {
    // Old config.json files carried `llm.activeProfile` / `llm.profiles`. Zod strips
    // unknown keys, so they degrade to "no model configured". No migration code.
    const cfg = ConfigSchema.parse({ llm: { activeProfile: 'prod', profiles: { prod: { 'release-pick': { provider: 'openrouter', model: 'x' } } } } });
    expect(cfg.llm).toEqual({ keys: {} });
  });

  it('drops the legacy `picking.tags` list rather than failing to load', () => {
    // Same unknown-key stripping as the `profiles` case above: a config.json from before
    // the Prefer/Avoid split loses its tags entirely, and the operator re-enters them.
    const cfg = ConfigSchema.parse({ picking: { tags: ['CHS subs'] } });
    expect(cfg.picking).toEqual({ prefer: [], avoid: [], seederFloor: 3, minSizeMB: 50, maxSizeMB: 60000 });
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
    {
      scenario: 'two arr instances sharing the same name',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        cfg.arrs.push(
          { name: 'dup', kind: 'sonarr', baseUrl: 'http://a:0', apiKey: 'key-a' },
          { name: 'dup', kind: 'radarr', baseUrl: 'http://b:0', apiKey: 'key-b' },
        );
        return () => saveConfig(dir, cfg);
      },
    },
    {
      scenario: 'reconcileIntervalMinutes = 0 (must be at least 1)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, reconcileIntervalMinutes: 0 });
      },
    },
    {
      scenario: 'reconcileIntervalMinutes = 1.5 (must be an integer)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, reconcileIntervalMinutes: 1.5 });
      },
    },
    {
      scenario: 'server.port = 0 (below the valid TCP port range)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, server: { ...cfg.server, port: 0 } });
      },
    },
    {
      scenario: 'server.port = 65536 (above the valid TCP port range)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, server: { ...cfg.server, port: 65536 } });
      },
    },
    {
      scenario: 'picking.seederFloor = -1 (must be at least 0)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, picking: { ...cfg.picking, seederFloor: -1 } });
      },
    },
    {
      scenario: 'picking.minSizeMB = -1 (must be at least 0)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, picking: { ...cfg.picking, minSizeMB: -1 } });
      },
    },
    {
      scenario: 'picking.maxSizeMB = -1 (must be at least 0)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, picking: { ...cfg.picking, maxSizeMB: -1, minSizeMB: -1 } });
      },
    },
    {
      scenario: 'picking.minSizeMB > picking.maxSizeMB (an inverted size window would fail every candidate)',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        return () => saveConfig(dir, { ...cfg, picking: { ...cfg.picking, minSizeMB: 100, maxSizeMB: 50 } });
      },
    },
    {
      // A blank `from` can never match any real path — `mapArrPath` would treat it the same
      // as `resolveSourceDirsDetailed`'s blank-root case below, silently matching everything.
      scenario: 'pathMappings[].from left blank',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        cfg.pathMappings.push({ from: '', to: '/mnt/media' });
        return () => saveConfig(dir, cfg);
      },
    },
    {
      scenario: 'pathMappings[].to left blank',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        cfg.pathMappings.push({ from: '/data', to: '' });
        return () => saveConfig(dir, cfg);
      },
    },
    {
      // A relative media path resolves against the working directory, which differs between
      // `npm run dev` and the container, so it is never what the operator meant.
      scenario: 'storage.series set to a relative path',
      setup: (dir: string) => {
        const cfg = loadConfig(dir);
        cfg.storage.series = 'relative/path';
        return () => saveConfig(dir, cfg);
      },
    },
  ])('rejects invalid config with ConfigError: $scenario', ({ setup }) => {
    const dir = tmp();
    const run = setup(dir);
    expect(run).toThrow(ConfigError);
  });

  it.each([
    { scenario: 'server.port at the minimum valid TCP port (1)', overrides: { server: { port: 1, publicUrl: 'http://x:0' } } },
    { scenario: 'server.port at the maximum valid TCP port (65535)', overrides: { server: { port: 65535, publicUrl: 'http://x:0' } } },
    { scenario: 'reconcileIntervalMinutes at its minimum (1)', overrides: { reconcileIntervalMinutes: 1 } },
    { scenario: 'picking.seederFloor at its minimum (0)', overrides: { picking: { seederFloor: 0, minSizeMB: 50, maxSizeMB: 60000, prefer: [], avoid: [] } } },
    {
      scenario: 'picking.minSizeMB exactly equal to picking.maxSizeMB (a zero-width but valid window)',
      overrides: { picking: { seederFloor: 3, minSizeMB: 100, maxSizeMB: 100, prefer: [], avoid: [] } },
    },
  ])('accepts the boundary value: $scenario', ({ overrides }) => {
    expect(() => ConfigSchema.parse(overrides)).not.toThrow();
  });

  // subtitle config
  it('defaults subtitle config to empty languages/preferredGroups/sites', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.subtitle).toEqual({ languages: [], preferredGroups: [], sites: [] });
  });

  it('parses subtitle languages, preferred groups, and sites', () => {
    const cfg = ConfigSchema.parse({
      subtitle: {
        languages: ['zh-Hans'],
        preferredGroups: ['Airota', 'Sumisora'],
        sites: [{ baseUrl: 'https://acg.rip', searchUrlTemplate: 'https://acg.rip/?term={query}' }],
      },
    });
    expect(cfg.subtitle.languages).toEqual(['zh-Hans']);
    expect(cfg.subtitle.preferredGroups).toEqual(['Airota', 'Sumisora']);
    expect(cfg.subtitle.sites[0]).toEqual({
      baseUrl: 'https://acg.rip',
      searchUrlTemplate: 'https://acg.rip/?term={query}',
    });
  });

  it('rejects a site whose baseUrl is not a url — it is the only identity a site has', () => {
    expect(ConfigSchema.safeParse({ subtitle: { sites: [{ baseUrl: 'not-a-url' }] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ subtitle: { sites: [{}] } }).success).toBe(false);
  });

  // browser config
  it('defaults browser config', () => {
    const cfg = ConfigSchema.parse({});
    expect(cfg.browser).toEqual({ stepBudget: 20, siteCooldownSeconds: 30 });
  });

  it('rejects a non-positive step budget', () => {
    expect(ConfigSchema.safeParse({ browser: { stepBudget: 0 } }).success).toBe(false);
  });
});

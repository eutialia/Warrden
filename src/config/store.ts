import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { ConfigSchema, type Config } from './schema.js';

export class ConfigError extends Error {
  readonly issues: z.core.$ZodIssue[];

  constructor(issues: z.core.$ZodIssue[]) {
    super(`Invalid config: ${issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function resolveDataDir(): string {
  return process.env.WARRDEN_DATA_DIR ?? './data';
}

function configPath(dataDir: string): string {
  return join(dataDir, 'config.json');
}

function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(result.error.issues);
  }
  return result.data;
}

export function loadConfig(dataDir: string): Config {
  mkdirSync(dataDir, { recursive: true });
  const path = configPath(dataDir);
  if (!existsSync(path)) {
    const defaults = parseConfig({});
    saveConfig(dataDir, defaults);
    return defaults;
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return parseConfig(raw);
}

export function saveConfig(dataDir: string, cfg: Config): void {
  const validated = parseConfig(cfg);
  mkdirSync(dataDir, { recursive: true });
  const path = configPath(dataDir);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2));
  renameSync(tmpPath, path);
}

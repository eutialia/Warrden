import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tmpDir } from './helpers.js';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'rename-bazarr-subs.sh');

// A few unambiguous words each: Traditional-only characters that aren't valid
// Simplified, and Simplified text using none of them.
const SIMPLIFIED_TEXT = '这是简体字幕';
const TRADITIONAL_TEXT = '這是繁體字幕';
// A Simplified file with one stray Traditional character, the way fansub credits often are.
const MOSTLY_SIMPLIFIED_TEXT = '这是简体字幕 制作：刘 後期';

function run(args: string[], env?: Record<string, string>) {
  const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Lays out one fixture library covering: a plain Simplified sidecar, a plain
// Traditional one, a `.hi` flagged Simplified one, a multi-flag Traditional one
// with spaces and CJK in the stem, an already-tagged file that must survive
// untouched, and a rename whose destination is pre-occupied.
function seedFixtures(dir: string) {
  const nested = join(dir, 'sub dir 中文');
  mkdirSync(nested, { recursive: true });

  writeFileSync(join(nested, 'simple ep.zh.srt'), SIMPLIFIED_TEXT);
  writeFileSync(join(nested, 'trad ep.zh.srt'), TRADITIONAL_TEXT);
  writeFileSync(join(nested, 'mostly simple ep.zh.srt'), MOSTLY_SIMPLIFIED_TEXT);
  writeFileSync(join(nested, 'hi ep.zh.hi.srt'), SIMPLIFIED_TEXT);
  writeFileSync(join(nested, '龍與鳳 特別篇.zh.forced.sdh.srt'), TRADITIONAL_TEXT);
  writeFileSync(join(nested, 'already.zh-Hans.srt'), 'untouched');
  writeFileSync(join(nested, 'collide.zh.srt'), SIMPLIFIED_TEXT);
  writeFileSync(join(nested, 'collide.zh-Hans.srt'), 'preexisting');
  writeFileSync(join(nested, 'unrelated.txt'), 'not a subtitle');

  return nested;
}

describe('rename-bazarr-subs.sh', () => {
  it('prints -h/--help usage and exits 0 without touching a real directory', () => {
    const result = run(['-h']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage: rename-bazarr-subs\.sh/);
  });

  it('exits non-zero with usage on stderr when no directory is given', () => {
    const result = run([]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Usage: rename-bazarr-subs\.sh/);
  });

  it('dry-run reports the renames it would make and leaves every file as-is', () => {
    const dir = tmpDir();
    const nested = seedFixtures(dir);
    const before = readdirSync(nested).sort();

    const result = run([dir]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('simple ep.zh.srt -> ');
    expect(result.stdout).toContain('.zh-Hans.srt');
    expect(result.stdout).toContain('trad ep.zh.srt -> ');
    expect(result.stdout).toContain('.zh-Hant.srt');
    expect(result.stdout).toContain('skip (exists): ');
    expect(result.stdout).toContain('3 -> zh-Hans, 2 -> zh-Hant, 1 skipped (exists)');
    expect(readdirSync(nested).sort()).toEqual(before);
  });

  it('--apply performs the renames, classifying by script and preserving flags', () => {
    const dir = tmpDir();
    const nested = seedFixtures(dir);

    const result = run(['--apply', dir]);

    expect(result.status).toBe(0);
    const after = readdirSync(nested).sort();
    expect(after).toEqual(
      [
        'already.zh-Hans.srt',
        'collide.zh-Hans.srt',
        'collide.zh.srt',
        'hi ep.zh-Hans.hi.srt',
        'mostly simple ep.zh-Hans.srt',
        'simple ep.zh-Hans.srt',
        'trad ep.zh-Hant.srt',
        'unrelated.txt',
        '龍與鳳 特別篇.zh-Hant.forced.sdh.srt',
      ].sort(),
    );
  });

  it('skips a rename whose destination already exists, reports it, and leaves both files alone', () => {
    const dir = tmpDir();
    const nested = seedFixtures(dir);

    run(['--apply', dir]);

    expect(existsSync(join(nested, 'collide.zh.srt'))).toBe(true);
    expect(existsSync(join(nested, 'collide.zh-Hans.srt'))).toBe(true);
  });

  it('is idempotent: a second --apply pass touches nothing further', () => {
    const dir = tmpDir();
    const nested = seedFixtures(dir);

    run(['--apply', dir]);
    const afterFirst = readdirSync(nested).sort();

    const second = run(['--apply', dir]);

    expect(second.stdout).toContain('0 -> zh-Hans, 0 -> zh-Hant, 1 skipped (exists)');
    expect(readdirSync(nested).sort()).toEqual(afterFirst);
  });

  it('classifies by script even when a non-UTF-8 LC_ALL is inherited', () => {
    // A C locale makes grep's bracket expression a set of bytes, and Simplified text shares
    // bytes with the Traditional set: the script has to insist on UTF-8, not defer to what
    // it was handed.
    const dir = tmpDir();
    const nested = seedFixtures(dir);

    const result = run(['--apply', dir], { LC_ALL: 'C' });

    expect(result.status).toBe(0);
    expect(readdirSync(nested)).toContain('simple ep.zh-Hans.srt');
    expect(readdirSync(nested)).toContain('trad ep.zh-Hant.srt');
  });

  it('never touches files outside the given directory', () => {
    const outside = tmpDir();
    writeFileSync(join(outside, 'sibling.zh.srt'), SIMPLIFIED_TEXT);
    const dir = tmpDir();
    seedFixtures(dir);

    run(['--apply', dir]);

    expect(readdirSync(outside)).toEqual(['sibling.zh.srt']);
  });
});

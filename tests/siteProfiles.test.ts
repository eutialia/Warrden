import { describe, expect, it } from 'vitest';
import { SiteProfiles } from '../src/db/siteProfiles.js';
import { freshDb } from './helpers.js';

describe('SiteProfiles', () => {
  it('upserts and reads back a profile with defaults', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    const row = profiles.get('acgrip');
    expect(row).toMatchObject({
      name: 'acgrip',
      base_url: 'https://acg.rip',
      last_working_tier: null,
      search_url_patterns: [],
      notes: '',
      fail_count: 0,
    });
  });

  it('upsert refreshes an existing row without wiping learned fields', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    profiles.update('acgrip', { lastWorkingTier: 'chromium', searchUrlPatterns: ['https://acg.rip/?term={query}'] });
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    expect(profiles.get('acgrip')).toMatchObject({ last_working_tier: 'chromium', search_url_patterns: ['https://acg.rip/?term={query}'] });
  });

  it('update patches only the given fields', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ name: 'acgrip', baseUrl: 'https://acg.rip' });
    profiles.update('acgrip', { failCount: 3, notes: 'cloudflare on curl' });
    expect(profiles.get('acgrip')).toMatchObject({ fail_count: 3, notes: 'cloudflare on curl', last_working_tier: null });
  });

  it('lists all profiles ordered by name', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ name: 'b', baseUrl: 'https://b' });
    profiles.upsert({ name: 'a', baseUrl: 'https://a' });
    expect(profiles.list().map((p) => p.name)).toEqual(['a', 'b']);
  });
});

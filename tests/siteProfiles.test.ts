import { describe, expect, it } from 'vitest';
import { SiteProfiles } from '../src/db/siteProfiles.js';
import { freshDb } from './helpers.js';

describe('SiteProfiles', () => {
  it('upserts and reads back a profile with defaults', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ baseUrl: 'https://acg.rip' });
    const row = profiles.get('https://acg.rip');
    expect(row).toMatchObject({
      base_url: 'https://acg.rip',
      last_working_tier: null,
      search_url_patterns: [],
      notes: '',
      fail_count: 0,
    });
  });

  it('upsert refreshes an existing row without wiping learned fields', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ baseUrl: 'https://acg.rip' });
    profiles.update('https://acg.rip', { lastWorkingTier: 'chromium', searchUrlPatterns: ['https://acg.rip/?term={query}'] });
    profiles.upsert({ baseUrl: 'https://acg.rip' });
    expect(profiles.get('https://acg.rip')).toMatchObject({ last_working_tier: 'chromium', search_url_patterns: ['https://acg.rip/?term={query}'] });
  });

  it('update patches only the given fields', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ baseUrl: 'https://acg.rip' });
    profiles.update('https://acg.rip', { failCount: 3, notes: 'cloudflare on curl' });
    expect(profiles.get('https://acg.rip')).toMatchObject({ fail_count: 3, notes: 'cloudflare on curl', last_working_tier: null });
  });

  it('lists all profiles ordered by url', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ baseUrl: 'https://b.example' });
    profiles.upsert({ baseUrl: 'https://a.example' });
    expect(profiles.list().map((p) => p.base_url)).toEqual(['https://a.example', 'https://b.example']);
  });
});

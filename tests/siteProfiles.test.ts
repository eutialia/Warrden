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
      fail_count: 0,
      disabled_at: null,
      disabled_reason: '',
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
    profiles.update('https://acg.rip', { failCount: 3, searchUrlPatterns: ['https://acg.rip/?q={query}'] });
    expect(profiles.get('https://acg.rip')).toMatchObject({
      fail_count: 3,
      search_url_patterns: ['https://acg.rip/?q={query}'],
      last_working_tier: null,
    });
  });

  it('update sets and clears the disabled flag', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ baseUrl: 'https://acg.rip' });
    profiles.update('https://acg.rip', { disabledAt: 1000, disabledReason: 'bot wall' });
    expect(profiles.get('https://acg.rip')).toMatchObject({ disabled_at: 1000, disabled_reason: 'bot wall' });
    profiles.update('https://acg.rip', { disabledAt: null, disabledReason: '' });
    expect(profiles.get('https://acg.rip')).toMatchObject({ disabled_at: null, disabled_reason: '' });
  });

  it('lists all profiles ordered by url', () => {
    const profiles = new SiteProfiles(freshDb());
    profiles.upsert({ baseUrl: 'https://b.example' });
    profiles.upsert({ baseUrl: 'https://a.example' });
    expect(profiles.list().map((p) => p.base_url)).toEqual(['https://a.example', 'https://b.example']);
  });
});

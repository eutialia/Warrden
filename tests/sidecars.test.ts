import { describe, it, expect } from 'vitest';
import {
  SIDECAR_EXTS,
  sidecarKindForExt,
  parseEpisodeRef,
  parseLangTag,
  buildSidecarName,
  matchSidecarDeterministic,
} from '../src/pipelines/ingest/sidecars.js';
import { episodeResource } from './helpers.js';

describe('SIDECAR_EXTS / sidecarKindForExt', () => {
  it('lists the sidecar extensions Warrden recognizes', () => {
    expect(SIDECAR_EXTS).toEqual(['.mka', '.srt', '.ass']);
  });

  it.each([
    ['.mka', 'audio'],
    ['.srt', 'subtitle'],
    ['.ass', 'subtitle'],
  ])('sidecarKindForExt(%s) -> %s', (ext, expected) => {
    expect(sidecarKindForExt(ext)).toBe(expected);
  });
});

describe('parseEpisodeRef', () => {
  it.each([
    // SxxEyy always wins
    ['Show - S01E05.sc.ass', { season: 1, episode: 5 }],
    ['show.s2e11.1080p.mka', { season: 2, episode: 11 }],
    // CJK episode markers
    ['[喵萌奶茶屋] 第05话 [简体].ass', { season: null, episode: 5 }],
    ['タイトル 第3話.srt', { season: null, episode: 3 }],
    // 集 is the third CJK marker character (話/话/集 are all in use across groups) — a
    // mutant narrowing the character class to just 話/话 would silently break this.
    ['[Group] 第12集.srt', { season: null, episode: 12 }],
    // single unambiguous bare number
    ['[Nekomoe] Title - 05 [1080p][JPSC].ass', { season: null, episode: 5 }],
    ['[Group] Title [05][GB].srt', { season: null, episode: 5 }],
    ['[Group] Title - 05v2 [720p].ass', { season: null, episode: 5 }],
    // resolutions, years, and CRC-ish tokens never count
    ['[Group] Title [1080].ass', null],
    ['[Group] Title (2023) [1080p].ass', null],
    // another NEVER_EPISODES member, distinct from 1080 — guards against a mutant that
    // only special-cases 1080 instead of using the full resolution set
    ['[Group] Title [2160].ass', null],
    // year-range guard boundaries: 1900 and 2100 are inclusive endpoints of the filter,
    // so both must still be dropped (only the [1080p]-blocked-by-suffix token remains
    // otherwise, i.e. zero real candidates survive)
    ['[Group] Title - 1900 [1080p].ass', null],
    ['[Group] Title - 2100 [1080p].ass', null],
    // two surviving bare numbers → ambiguous → null (LLM territory)
    ['[Group] Title 3 - 05 [10bit].ass', null],
    ['OP1.ass', null],
    ['[Group] Title - NCOP [1080p].ass', null],
  ])('parseEpisodeRef(%s) -> %j', (name, expected) => {
    expect(parseEpisodeRef(name)).toEqual(expected);
  });
});

describe('parseLangTag', () => {
  it.each([
    ['Show - S01E05.sc.ass', 'zh-Hans'],
    ['Show - S01E05.CHS.srt', 'zh-Hans'],
    ['[Group] Title - 05 [JPSC].ass', 'zh-Hans'],
    ['[Group] Title - 05 [繁體].ass', 'zh-Hant'],
    ['Show.S01E05.cht.big5.ass', 'zh-Hant'],
    ['Show - S01E05.jpn.mka', 'ja'],
    ['Show - S01E05.eng.srt', 'en'],
    ['Show - S01E05.ass', null],
    ['Show - S01E05.mka', null],
    // remaining LANG_TOKENS entries the brief's own table never exercises — each is a
    // real fansub tagging convention, and each is a distinct dict key a mutant could
    // drop or typo without any of the rows above noticing
    ['Show - S01E05.gb.srt', 'zh-Hans'],
    ['Show - S01E05.tc.srt', 'zh-Hant'],
    ['Show - S01E05.jp.srt', 'ja'],
    ['Show.S01E05.zh-CN.ass', 'zh-Hans'],
    ['Show.S01E05.zh-TW.ass', 'zh-Hant'],
    ['[Group] Title - 05 [JPTC].ass', 'zh-Hant'],
    ['[Group] Title - 05 [简].ass', 'zh-Hans'],
    ['[Group] Title - 05 [简中].ass', 'zh-Hans'],
    ['[Group] Title - 05 [简日].ass', 'zh-Hans'],
    ['[Group] Title - 05 [繁].ass', 'zh-Hant'],
    ['[Group] Title - 05 [繁中].ass', 'zh-Hant'],
    ['[Group] Title - 05 [繁日].ass', 'zh-Hant'],
    // scanning must go from the END of the name: BIG5 (zh-Hant) sits nearer the
    // extension than GB (zh-Hans) — a start-scanning implementation would pick GB first
    ['[Group] Title - 05 [GB][BIG5].ass', 'zh-Hant'],
    // a trailing dot token beats an earlier bracket token, even when the bracket token
    // would (wrongly) match first under a naive scan
    ['Show - 05 [CHT].sc.ass', 'zh-Hans'],
  ])('parseLangTag(%s) -> %s', (name, expected) => {
    expect(parseLangTag(name)).toBe(expected);
  });
});

describe('buildSidecarName', () => {
  it.each([
    ['Show - S01E05.mkv', { lang: 'zh-Hans', ext: '.ass' }, 'Show - S01E05.zh-Hans.ass'],
    ['Show - S01E05.mkv', { lang: null, ext: '.ass' }, 'Show - S01E05.ass'],
    ['Show - S01E05.mkv', { lang: null, ext: '.mka' }, 'Show - S01E05.mka'],
    ['Show - S01E05.mkv', { lang: 'ja', ext: '.mka' }, 'Show - S01E05.ja.mka'],
    // only the final extension is stripped, not every dot in the name
    ['Show.Name.S01E05.mkv', { lang: 'ja', ext: '.mka' }, 'Show.Name.S01E05.ja.mka'],
  ])('buildSidecarName(%s, %j) -> %s', (video, s, expected) => {
    expect(buildSidecarName(video, s)).toBe(expected);
  });
});

describe('matchSidecarDeterministic', () => {
  it('matches an SxxEyy ref by exact (seasonNumber, episodeNumber), even with a same-episode-number decoy in another season', () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 5 }),
      episodeResource({ id: 2, seasonNumber: 2, episodeNumber: 5 }),
    ];
    expect(matchSidecarDeterministic('Show - S02E05.ass', episodes)).toMatchObject({ id: 2 });
  });

  it('SxxEyy ref with no matching episode -> null', () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 5 })];
    expect(matchSidecarDeterministic('Show - S01E09.ass', episodes)).toBeNull();
  });

  it('bare ref + single regular season -> matches by episodeNumber in that season', () => {
    const episodes = [episodeResource({ id: 10, seasonNumber: 1, episodeNumber: 5 })];
    expect(matchSidecarDeterministic('[Group] Title - 05 [1080p].ass', episodes)).toMatchObject({ id: 10 });
  });

  it('season 0 specials never count toward "single regular season", nor as a match target', () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 0, episodeNumber: 5 }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 5 }),
    ];
    expect(matchSidecarDeterministic('[Group] Title - 05 [1080p].ass', episodes)).toMatchObject({ id: 2 });
  });

  it('bare ref + multiple regular seasons -> falls back to a unique absoluteEpisodeNumber match', () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1 }),
      episodeResource({ id: 2, seasonNumber: 1, episodeNumber: 2, absoluteEpisodeNumber: 2 }),
      episodeResource({ id: 3, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 13 }),
    ];
    expect(matchSidecarDeterministic('[Group] Title - 13 [1080p].ass', episodes)).toMatchObject({ id: 3 });
  });

  it('bare ref + multiple regular seasons + non-unique absoluteEpisodeNumber -> null', () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 13 }),
      episodeResource({ id: 2, seasonNumber: 2, episodeNumber: 1, absoluteEpisodeNumber: 13 }),
    ];
    expect(matchSidecarDeterministic('[Group] Title - 13 [1080p].ass', episodes)).toBeNull();
  });

  it('bare ref + multiple regular seasons + absoluteEpisodeNumber absent everywhere -> null', () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 }),
      episodeResource({ id: 2, seasonNumber: 2, episodeNumber: 1 }),
    ];
    expect(matchSidecarDeterministic('[Group] Title - 13 [1080p].ass', episodes)).toBeNull();
  });

  it('bare ref + single regular season but no episodeNumber hit -> falls through to absoluteEpisodeNumber, not straight to null', () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 100 })];
    expect(matchSidecarDeterministic('[Group] Title - 100 [1080p].ass', episodes)).toMatchObject({ id: 1 });
  });

  it('no parseable ref -> null regardless of episode list', () => {
    const episodes = [episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1, absoluteEpisodeNumber: 1080 })];
    expect(matchSidecarDeterministic('[Group] Title [1080].ass', episodes)).toBeNull();
  });
});

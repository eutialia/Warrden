import { describe, it, expect } from 'vitest';
import {
  SIDECAR_EXTS,
  VIDEO_EXTS,
  sidecarKindForExt,
  parseEpisodeRef,
  parseLangTag,
  buildSidecarName,
  matchSidecarDeterministic,
  matchEpisodeRef,
  parseEpisodeRefWithHint,
  parseLangHint,
  parseLangTagWithHint,
  parseSeasonHint,
  sidecarStem,
} from '../src/pipelines/ingest/sidecars.js';
import { episodeResource } from './helpers.js';

describe('VIDEO_EXTS', () => {
  it('lists the video extensions the movie branch recognizes for size-match/stem-guard purposes', () => {
    expect(VIDEO_EXTS).toEqual(['.mkv', '.mp4', '.avi']);
  });
});

describe('SIDECAR_EXTS / sidecarKindForExt', () => {
  it('lists the sidecar extensions Warrden recognizes', () => {
    expect(SIDECAR_EXTS).toEqual(['.mka', '.srt', '.ass']);
  });

  it.each([
    ['.mka', 'audio'],
    ['.srt', 'subtitle'],
    ['.ass', 'subtitle'],
    // extension casing must never matter — Windows-authored sidecar names commonly
    // carry an uppercase extension
    ['.MKA', 'audio'],
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
    // dots are a valid delimiter too, not just space/bracket/underscore/dash
    ['Show.Name.05.1080p.ass', { season: null, episode: 5 }],
    // a parenthesized year alongside a real bare episode number: exercises both the
    // paren delimiter (leading `(`/trailing `)` must be recognized, same as brackets)
    // and the year-range guard filtering the captured 2023 out of the candidate set
    ['[Group] Title (2023) - 05 [1080p].ass', { season: null, episode: 5 }],
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
    // 'constructor' is inherited from Object.prototype, not an own LANG_TOKENS key — a
    // plain `key in LANG_TOKENS` or unguarded index lookup would wrongly resolve it
    ['Show - S01E05.constructor.ass', null],
    // padding inside a bracket is a real fansub shape too — sub-splitting on
    // whitespace already strips it, but it must resolve either way
    ['Show - S01E05 [ CHS ].ass', 'zh-Hans'],
    // a padded *dot* token isn't sub-split, so this is the row that actually pins the
    // trim() call in parseLangTag's lookup (removing it makes " chs " fail the exact
    // LANG_TOKENS key match and falls through to null)
    ['Show - S01E05 . CHS .ass', 'zh-Hans'],
    // multi-tag brackets: sub-split on _ / & / + / whitespace, the Chinese-variant part
    // (listed first, per fansub convention) wins over the trailing language-origin tag
    ['[Group] Title - 05 [CHS_JPN].ass', 'zh-Hans'],
    ['[Group] Title - 05 [GB_JP].ass', 'zh-Hans'],
    ['[Group] Title - 05 [CHS&JPN].ass', 'zh-Hans'],
    ['[Group] Title - 05 [繁中+日語].ass', 'zh-Hant'],
    // ...and the reverse ordering: a zh-* sub-token still wins even when it's listed
    // SECOND — a bracket pairing Japanese with a Chinese variant is a dual-sub Chinese
    // release either way, matching merged jpsc/jptc keys' intent, regardless of which
    // part fansub groups happened to write first
    ['[Group] Title - 05 [JP_SC].ass', 'zh-Hans'],
    ['[Group] Title - 05 [JPN_TC].ass', 'zh-Hant'],
    // A fansub group stamps its own prefix onto the trailing tag ('.YY-SC.ass'), and the
    // half after the hyphen is the part that names a language. Casing must not matter
    // here any more than it does anywhere else: '.YY-sc.ass' is the same tag.
    ['[YYDM-11FANS][Sword Art Online II][04][C40793FD].YY-SC.ass', 'zh-Hans'],
    ['[YYDM-11FANS][Sword Art Online II][04][C40793FD].YY-sc.ass', 'zh-Hans'],
    ['[YYDM-11FANS][Sword Art Online II][04][C40793FD].YY-TC.ass', 'zh-Hant'],
    // ...but the whole token is tried first, so a hyphenated key still resolves as itself
    // rather than as its own suffix.
    ['Show - S01E05.zh-Hant.ass', 'zh-Hant'],
    // A hyphen in a title is not a tag: the suffix has to be a known token.
    ['Show - S01E05.ass', null],
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

describe('parseSeasonHint', () => {
  it.each([
    // The real subhd pack this was built for: the CJK marker and the roman numeral in the
    // same segment agree on 2, so the segment is not a conflict.
    [['[中文字幕全版本][刀剑神域 第二季 Sword Art Online II][BD+TV][170512].7z.d'], 2],
    [['第2季'], 2],
    [['第十季'], 10],
    [['Season 3'], 3],
    [['season 3'], 3],
    [['S04'], 4],
    [['Show S2 [BDRip]'], 2],
    [['Sword Art Online II'], 2],
    [['Fate III'], 3],
    // A bare roman I is far more often a title word than a season.
    [['Show I'], null],
    [['Sword Art Online'], null],
    [['1080P'], null],
    [['[Group][AVC_AAC][720p_Hi10P]'], null],
    // An SxxEyy token is an episode ref, not a standalone season token.
    [['Show S01E05'], null],
    // Nearest segment to the file wins.
    [['Season 1', 'Season 4'], 4],
    // ... but a segment with no hint at all is skipped rather than ending the search.
    [['Season 4', '[BD+TV]'], 4],
    // Two different seasons named in one segment: no way to pick, so no hint.
    [['Season 1 第三季'], null],
    [[], null],
  ])('%j -> %s', (segments, expected) => {
    expect(parseSeasonHint(segments)).toBe(expected);
  });
});

describe('parseEpisodeRefWithHint', () => {
  it('fills a season-less ref from the path hint', () => {
    expect(parseEpisodeRefWithHint('[Group][01].chs.ass', ['第二季'])).toEqual({ season: 2, episode: 1 });
  });

  it('leaves an SxxEyy ref alone — the filename is more specific than the directory', () => {
    expect(parseEpisodeRefWithHint('Show - S01E05.ass', ['Season 2'])).toEqual({ season: 1, episode: 5 });
  });

  it('an unparseable basename stays unparseable, hint or not', () => {
    expect(parseEpisodeRefWithHint('[Group] Title [1080].ass', ['Season 2'])).toBeNull();
  });

  it('no hint leaves the ref season-less', () => {
    expect(parseEpisodeRefWithHint('[Group][01].chs.ass', ['[BD+TV]'])).toEqual({ season: null, episode: 1 });
  });
});

describe('matchEpisodeRef', () => {
  it('a directory-derived season picks the right one of two otherwise ambiguous seasons', () => {
    const episodes = [
      episodeResource({ id: 1, seasonNumber: 1, episodeNumber: 1 }),
      episodeResource({ id: 2, seasonNumber: 2, episodeNumber: 1 }),
    ];
    const ref = parseEpisodeRefWithHint('[X][01].chs.ass', ['第二季']);
    expect(matchEpisodeRef(ref!, episodes)).toMatchObject({ id: 2, seasonNumber: 2, episodeNumber: 1 });
    // Without the hint the same basename is genuinely ambiguous.
    expect(matchSidecarDeterministic('[X][01].chs.ass', episodes)).toBeNull();
  });
});

describe('parseLangHint', () => {
  it.each([
    // The pack layouts this exists for: one language folder per variant, sitting under the
    // release folder that names both.
    [['异域', 'BD', '[YYDM-11FANS][简繁外挂字幕][01-24]', '简体'], 'zh-Hans'],
    [['异域', 'BD', '[YYDM-11FANS][简繁外挂字幕][01-24]', '繁體'], 'zh-Hant'],
    [['DHR×白月', 'BD', '繁體', '[DHR][SUB][TC]'], 'zh-Hant'],
    // Whole-segment forms.
    [['简体'], 'zh-Hans'],
    [['简中'], 'zh-Hans'],
    [['简'], 'zh-Hans'],
    [['SC'], 'zh-Hans'],
    [['chs'], 'zh-Hans'],
    [['GB'], 'zh-Hans'],
    [['繁體'], 'zh-Hant'],
    [['繁体'], 'zh-Hant'],
    [['繁中'], 'zh-Hant'],
    [['繁'], 'zh-Hant'],
    [['TC'], 'zh-Hant'],
    [['cht'], 'zh-Hant'],
    [['BIG5'], 'zh-Hant'],
    // Bracketed token inside a segment that says other things too.
    [['[Group][BDRip][CHT]'], 'zh-Hant'],
    // A folder claiming both variants adjudicates nothing, so the scan keeps going outward
    // rather than flipping a coin.
    [['简体', '简繁'], 'zh-Hans'],
    [['繁體', '[YYDM][简繁外挂字幕][01-24]'], 'zh-Hant'],
    [['简体', '简繁内封'], 'zh-Hans'],
    [['简繁'], null],
    // Nearest segment to the file wins.
    [['繁體', '简体'], 'zh-Hans'],
    // A segment naming nothing is skipped, not an answer.
    [['简体', 'BD'], 'zh-Hans'],
    // 'sc'/'gb' are far too common as substrings to read them out of a longer segment.
    [['Discworld'], null],
    [['[Group][720p]'], null],
    [[], null],
  ])('%j -> %s', (segments, expected) => {
    expect(parseLangHint(segments)).toBe(expected);
  });
});

describe('parseLangTagWithHint', () => {
  it('takes the language from the enclosing folder when the basename carries no tag', () => {
    expect(parseLangTagWithHint('[YYDM-11FANS][SAO II][04][C40793FD].ass', ['BD', '简体'])).toBe('zh-Hans');
  });

  it('the basename wins over a folder that says otherwise', () => {
    expect(parseLangTagWithHint('[YYDM-11FANS][SAO II][04][C40793FD].YY-SC.ass', ['BD', '繁體'])).toBe('zh-Hans');
  });

  it('no tag anywhere stays null', () => {
    expect(parseLangTagWithHint('[YYDM-11FANS][SAO II][04][C40793FD].ass', ['BD', '[01-24]'])).toBeNull();
  });
});

describe('sidecarStem', () => {
  it.each([
    // A trailing dot-token that's a known language tag is stripped along with the extension.
    ['[X] Promare [x265_flac].chs.ass', '[X] Promare [x265_flac]'],
    ['[X] Promare [x265_flac].cht.ass', '[X] Promare [x265_flac]'],
    // .mka carries no lang token here — its own extension strip alone already lands on
    // the same stem as the .ass sidecars above, which is the whole point of the guard:
    // a bare-audio sidecar and a lang-tagged subtitle both resolve to their shared video.
    ['[X] Promare [x265_flac].mka', '[X] Promare [x265_flac]'],
    // Token lookup is case-insensitive, same as parseLangTag's own LANG_TOKENS lookup.
    ['[X] Promare [x265_flac].CHS.ass', '[X] Promare [x265_flac]'],
    // A trailing dot-token that ISN'T a language tag is left alone — only a genuine
    // LANG_TOKENS hit is ever stripped.
    ['Show.S01E05.1080p.ass', 'Show.S01E05.1080p'],
    // No dot at all before the extension -> nothing further to strip.
    ['AAA - 05.srt', 'AAA - 05'],
    // A video's own filename passes through unchanged minus its extension.
    ['main.mkv', 'main'],
    ['Promare SIDE Galo.mkv', 'Promare SIDE Galo'],
    // 'constructor' is inherited from Object.prototype, not an own LANG_TOKENS key — same
    // guard as parseLangTag's resolveGroup, pinned here too since sidecarStem does its own
    // lookup rather than delegating to resolveGroup.
    ['Video.constructor.ass', 'Video.constructor'],
  ])('sidecarStem(%s) -> %s', (filename, expected) => {
    expect(sidecarStem(filename)).toBe(expected);
  });
});

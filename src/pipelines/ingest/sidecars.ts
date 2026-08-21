import type { EpisodeResource } from '../../arr/types.js';

/** Sidecar file extensions Warrden ingests alongside a video file: external audio
 * tracks (`.mka`) and subtitles (`.srt`/`.ass`), most commonly produced by anime
 * fansub groups shipping multi-audio/multi-sub releases as separate files. */
export const SIDECAR_EXTS: readonly string[] = ['.mka', '.srt', '.ass'];

/** Video file extensions the movie branch recognizes when re-deriving a torrent folder by
 * size match, or when looking for the sibling video a sidecar's filename actually names. */
export const VIDEO_EXTS: readonly string[] = ['.mkv', '.mp4', '.avi'];

type SidecarKind = 'audio' | 'subtitle';

/** `.mka` (case-insensitive) is an external audio track; every other sidecar
 * extension is a subtitle. */
export function sidecarKindForExt(ext: string): SidecarKind {
  return ext.toLowerCase() === '.mka' ? 'audio' : 'subtitle';
}

export interface EpisodeRef {
  season: number | null;
  episode: number;
}

/** Resolutions that show up bare in fansub filenames (`[1080]`, `[2160]`, ...) and must
 * never be mistaken for an episode number. */
const NEVER_EPISODES = new Set([480, 576, 720, 1080, 1440, 2160]);

/**
 * Extracts an episode reference from a sidecar (or video) filename. Real-world anime
 * fansub names are wildly inconsistent, so this tries progressively looser patterns and
 * bails to `null` — deferring to the LLM call-site — the moment a pattern is genuinely
 * ambiguous rather than guessing:
 *
 * 1. `SxxEyy` (any case) always wins when present — it's unambiguous by construction.
 * 2. CJK episode markers (`第05话`/`第05話`/`第05集`) are the next-most explicit.
 * 3. Otherwise, every delimiter-bounded bare number in the name is a candidate (an
 *    optional `vN` revision suffix, e.g. `05v2`, is absorbed into the number); known
 *    resolutions and 1900–2100 "looks like a year" numbers are filtered out. Exactly
 *    one surviving candidate is the episode number — zero or more than one is
 *    ambiguous and returns `null`.
 */
export function parseEpisodeRef(filename: string): EpisodeRef | null {
  const name = filename.replace(/\.[^.]+$/, '');

  const sxxeyy = name.match(/[Ss](\d{1,2})[Ee](\d{1,4})/);
  if (sxxeyy) return { season: Number(sxxeyy[1]), episode: Number(sxxeyy[2]) };

  const cjk = name.match(/第(\d{1,4})[話话集]/);
  if (cjk) return { season: null, episode: Number(cjk[1]) };

  // Bare numbers delimited by space/bracket/underscore/dash/dot, optional vN suffix.
  // 10bit/8bit-style tokens are excluded by the delimiter requirement after the digits.
  const candidates: number[] = [];
  for (const m of name.matchAll(/(?:^|[\s[({_.-])(\d{1,4})(?:[Vv]\d{1,2})?(?=$|[\s\])}_.-])/g)) {
    const n = Number(m[1]);
    if (NEVER_EPISODES.has(n)) continue;
    if (n >= 1900 && n <= 2100) continue; // years
    candidates.push(n);
  }
  if (candidates.length === 1) return { season: null, episode: candidates[0]! };
  return null; // zero or ambiguous — the LLM call-site handles these
}

/** CJK numerals as they appear in `第二季`-style season markers. Fansub packs never
 * count past a handful of seasons this way, so one through ten is the whole range. */
const CJK_NUMERALS: Record<string, number> = {
  '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
  '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
};

const ROMAN_SEASONS: Record<string, number> = { ii: 2, iii: 3, iv: 4 };

/**
 * Every season number a single path segment names, as a set. Four shapes, all
 * case-insensitive:
 * - `第2季` / `第二季`, the Chinese season marker, arabic or CJK numeral.
 * - `Season 4`.
 * - `S2` / `S04` as a standalone token — the digits must not run into more alphanumerics,
 *   which is what keeps `S01E05` (an episode ref) out.
 * - A roman `II`/`III`/`IV` trailing a title word, as in `Sword Art Online II`. A bare `I`
 *   is far more often a word than a season, so it doesn't count.
 */
function seasonsNamedIn(segment: string): Set<number> {
  const found = new Set<number>();
  for (const m of segment.matchAll(/第(\d{1,2}|[一二三四五六七八九十])季/g)) {
    const token = m[1]!;
    found.add(CJK_NUMERALS[token] ?? Number(token));
  }
  for (const m of segment.matchAll(/season\s*(\d{1,2})(?![a-z0-9])/gi)) found.add(Number(m[1]));
  for (const m of segment.matchAll(/(?:^|[^a-z0-9])s(\d{1,2})(?![a-z0-9])/gi)) found.add(Number(m[1]));
  for (const m of segment.matchAll(/[a-z]{2,}\s+(iii|iv|ii)(?![a-z0-9])/gi)) found.add(ROMAN_SEASONS[m[1]!.toLowerCase()]!);
  return found;
}

/**
 * Reads a season number out of the directory names a subtitle file sits under, for packs
 * whose filenames carry only a bare episode number and leave the season to the folder
 * (`.../[刀剑神域 第二季 Sword Art Online II][BD+TV]/[Group][01].chs.ass`). `segments` runs
 * outermost-first, so the scan runs backwards: the directory closest to the file is the
 * most specific claim about it. A segment naming two different seasons is a claim we
 * can't adjudicate, so it resolves to `null` rather than a coin flip; a segment naming
 * none at all is simply not a claim, and the scan continues outward.
 */
export function parseSeasonHint(segments: string[]): number | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const found = seasonsNamedIn(segments[i]!);
    if (found.size === 0) continue;
    return found.size === 1 ? [...found][0]! : null;
  }
  return null;
}

/**
 * `parseEpisodeRef` with the enclosing directories as a fallback for the season only. The
 * filename always wins: an `SxxEyy` name inside a `Season 2` folder stays on the season it
 * names. Only a ref the basename left season-less takes the directory's word for it.
 */
export function parseEpisodeRefWithHint(filename: string, segments: string[]): EpisodeRef | null {
  const ref = parseEpisodeRef(filename);
  if (ref === null || ref.season !== null) return ref;
  const hint = parseSeasonHint(segments);
  return hint === null ? ref : { season: hint, episode: ref.episode };
}

/** Fansub language/subtitle tags, normalized to a BCP-47-ish tag. Keys are lowercased
 * before lookup, so casing in the filename (`CHS`, `chs`, `Chs`) never matters. */
const LANG_TOKENS: Record<string, string> = {
  sc: 'zh-Hans', chs: 'zh-Hans', gb: 'zh-Hans', jpsc: 'zh-Hans', 'zh-hans': 'zh-Hans', 'zh-cn': 'zh-Hans',
  '简': 'zh-Hans', '简体': 'zh-Hans', '简中': 'zh-Hans', '简日': 'zh-Hans',
  tc: 'zh-Hant', cht: 'zh-Hant', big5: 'zh-Hant', jptc: 'zh-Hant', 'zh-hant': 'zh-Hant', 'zh-tw': 'zh-Hant',
  '繁': 'zh-Hant', '繁體': 'zh-Hant', '繁体': 'zh-Hant', '繁中': 'zh-Hant', '繁日': 'zh-Hant',
  jp: 'ja', jpn: 'ja', ja: 'ja',
  en: 'en', eng: 'en',
};

/** Separators fansub groups use to cram multiple language tags into one bracket, e.g.
 * `[CHS_JPN]`, `[GB&JP]`, `[繁中/日語]` — split on these (and plain whitespace) before
 * looking a bracket's content up as a single token. */
const LANG_SUBTOKEN_SPLIT = /[\s_&+/]+/;

/**
 * Splits the extension-less name into candidate groups: every dot-separated segment
 * (a singleton group) plus every `[...]` bracket group's own sub-tokens (see
 * `LANG_SUBTOKEN_SPLIT`), each group tagged with the string offset where its
 * bracket/segment ends. Sorted so the caller can scan from the end of the filename
 * toward the front — the group nearest the extension is the fansub convention's most
 * authoritative one (`Show.sc.ass`). Ties (a bracket group that happens to touch the
 * extension, e.g. `Title [JPSC].ass`) keep left-to-right insertion order, which is
 * what a stable sort over [dot groups..., bracket groups...] gives for free.
 */
function langCandidateGroupsFromEnd(name: string): string[][] {
  const groups: { parts: string[]; end: number }[] = [];

  let cursor = 0;
  for (const part of name.split('.')) {
    cursor += part.length;
    groups.push({ parts: [part], end: cursor });
    cursor += 1; // the dot itself
  }

  for (const m of name.matchAll(/\[([^\]]*)\]/g)) {
    const content = m[1] ?? '';
    const end = m.index + m[0].length;
    const parts = content.split(LANG_SUBTOKEN_SPLIT).filter((p) => p.length > 0);
    groups.push({ parts: parts.length > 0 ? parts : [content], end });
  }

  return groups.sort((a, b) => b.end - a.end).map((g) => g.parts);
}

/**
 * Resolves one candidate group (a bracket's sub-tokens, or a single dot segment) to a
 * lang tag, in left-to-right order — but a sub-token that maps to a `zh-*` variant
 * always wins over an earlier non-`zh` match. A bracket pairing a Chinese variant with
 * a bare language tag (`[JP_SC]`, `[JPN_TC]`) is a dual-sub Chinese release in fansub
 * convention, matching the intent of the already-merged `jpsc`/`jptc` keys — so it
 * must resolve the same way regardless of which part happens to be listed first.
 * Returns `null` when no sub-token matches any `LANG_TOKENS` key.
 */
function resolveGroup(parts: string[]): string | null {
  let firstMatch: string | null = null;
  for (const part of parts) {
    const key = part.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(LANG_TOKENS, key)) continue;
    const value = LANG_TOKENS[key]!;
    if (value.startsWith('zh-')) return value;
    firstMatch ??= value;
  }
  return firstMatch;
}

/**
 * Finds a fansub language/subtitle tag in a filename and normalizes it via
 * `LANG_TOKENS`. Scans dot-separated trailing tokens and `[...]` bracket contents from
 * the end of the (extension-stripped) name toward the front, resolving each group (see
 * `resolveGroup`) and returning the first group that matches. Returns `null` when no
 * known tag is present anywhere.
 */
export function parseLangTag(filename: string): string | null {
  const name = filename.replace(/\.[^.]+$/, '');
  for (const parts of langCandidateGroupsFromEnd(name)) {
    const resolved = resolveGroup(parts);
    if (resolved !== null) return resolved;
  }
  return null;
}

/**
 * Strips a filename down to the stem it shares with its sibling video: the extension,
 * then one trailing dot-token IF it (lowercased) is a known language tag — reusing
 * `LANG_TOKENS` rather than duplicating it, so a new tag added there is picked up here for
 * free. `'[X] Promare [x265_flac].chs.ass'` and `'[X] Promare [x265_flac].mka'` both reduce
 * to `'[X] Promare [x265_flac]'`; a video's own filename passes through unchanged minus its
 * extension, since it never carries a lang-tag dot-token in this position. Used by the
 * movie branch's sidecar stem guard (`run.ts`) to tell which of several sibling videos in
 * the same torrent folder a sidecar actually belongs to, rather than assuming 1:1.
 */
export function sidecarStem(filename: string): string {
  const noExt = filename.replace(/\.[^.]+$/, '');
  const lastDot = noExt.lastIndexOf('.');
  if (lastDot === -1) return noExt;
  const token = noExt.slice(lastDot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANG_TOKENS, token) ? noExt.slice(0, lastDot) : noExt;
}

/**
 * Builds the sidecar filename Warrden writes next to a video file: the video's
 * basename (extension stripped), an optional `.${lang}` tag, and the sidecar's own
 * extension — e.g. `Show - S01E05.mkv` + `{ lang: 'zh-Hans', ext: '.ass' }` →
 * `Show - S01E05.zh-Hans.ass`.
 */
export function buildSidecarName(videoFileName: string, s: { lang: string | null; ext: string }): string {
  const base = videoFileName.replace(/\.[^.]+$/, '');
  return s.lang ? `${base}.${s.lang}${s.ext}` : `${base}${s.ext}`;
}

/**
 * Deterministically matches a sidecar (or leftover video) filename to one of a series'
 * episodes, with no LLM involved — only unambiguous cases resolve here; everything else
 * (including a `parseEpisodeRef` miss) returns `null` for the LLM call-site to attempt
 * instead. This function trusts whatever `episodes` list it's given and matches purely
 * by season/episode/absolute number, so callers must pass whichever list keeps that
 * matching correct for their use case. Both current callers pass the FULL episode list
 * (never pre-filtered to `hasFile`) and instead reject the hit themselves afterward, for
 * the same reason: the single-regular-season heuristic below needs to see EVERY season to
 * tell whether a bare number is genuinely unambiguous, and pre-filtering to `hasFile` first
 * can leave exactly one season behind (complete or incomplete, depending on the caller),
 * making an actually-ambiguous number look falsely unique:
 * - Sidecar rescue (`sweepSidecars` in `run.ts`) only accepts the hit when
 *   `hit.hasFile` — a sidecar needs a video that's already on disk to sit beside, so a
 *   hit on a fileless episode is "wait for the file," not a placement. Either a miss or a
 *   fileless-episode hit falls through to `matchSidecarsWithLlm`'s own separate call,
 *   which — unlike this function — IS pre-filtered to `hasFile: true` episodes, since
 *   there's no "wait for it" state to defer to there.
 * - Bundle rescue (`planBundleImport` in `bundle.ts`) only accepts the hit when
 *   `!hit.hasFile` — bundle rescue exists to fill in MISSING episodes, so a hit on one
 *   that already has a file falls through to the LLM tier instead, which can see
 *   `hasFile` in the episode table and reason about it properly.
 *
 * - An `SxxEyy` ref matches by exact `(seasonNumber, episodeNumber)`.
 * - A bare ref, when the series has exactly one regular (non-special, `seasonNumber >
 *   0`) season, matches by `episodeNumber` within that season.
 * - Otherwise (multi-season, or a single-season episodeNumber miss) a bare ref falls
 *   back to `absoluteEpisodeNumber`, only when exactly one episode carries it —
 *   non-unique or absent is `null`, not a guess.
 */
export function matchSidecarDeterministic(filename: string, episodes: EpisodeResource[]): EpisodeResource | null {
  const ref = parseEpisodeRef(filename);
  return ref === null ? null : matchEpisodeRef(ref, episodes);
}

/** The matching half of `matchSidecarDeterministic`, split out for callers that already
 * hold a parsed ref — the subtitle pipeline annotates every archive entry with one at
 * cache-write time (season hint included), and re-deriving it from the basename would
 * throw that hint away. Same rules, documented above. */
export function matchEpisodeRef(ref: EpisodeRef, episodes: EpisodeResource[]): EpisodeResource | null {
  if (ref.season !== null) {
    return episodes.find((e) => e.seasonNumber === ref.season && e.episodeNumber === ref.episode) ?? null;
  }

  const regularSeasons = new Set(episodes.filter((e) => e.seasonNumber > 0).map((e) => e.seasonNumber));
  if (regularSeasons.size === 1) {
    const hit = episodes.find((e) => e.seasonNumber > 0 && e.episodeNumber === ref.episode);
    if (hit) return hit;
  }
  const byAbsolute = episodes.filter((e) => e.absoluteEpisodeNumber === ref.episode);
  return byAbsolute.length === 1 ? byAbsolute[0]! : null;
}

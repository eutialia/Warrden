import type { EpisodeResource } from '../../arr/types.js';

/** Sidecar file extensions Warrden ingests alongside a video file: external audio
 * tracks (`.mka`) and subtitles (`.srt`/`.ass`), most commonly produced by anime
 * fansub groups shipping multi-audio/multi-sub releases as separate files. */
export const SIDECAR_EXTS: readonly string[] = ['.mka', '.srt', '.ass'];

/** Case-insensitive `SIDECAR_EXTS` membership test — the one place that contract is
 * enforced, so callers never need to remember to lowercase first. */
export function isSidecarExt(ext: string): boolean {
  return SIDECAR_EXTS.includes(ext.toLowerCase());
}

export type SidecarKind = 'audio' | 'subtitle';

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
 * Splits the extension-less name into every dot-separated segment plus the inner
 * content of every `[...]` bracket group (further split into its own sub-tokens — see
 * `LANG_SUBTOKEN_SPLIT`), each tagged with the string offset where its bracket/segment
 * ends. Sorted so the caller can scan from the end of the filename toward the front —
 * the token nearest the extension is the fansub convention's most authoritative one
 * (`Show.sc.ass`). Ties (multiple sub-tokens of one bracket, or a bracket group that
 * happens to touch the extension, e.g. `Title [JPSC].ass`) keep left-to-right
 * insertion order, which is what a stable sort over [dot tokens..., bracket
 * sub-tokens...] gives for free — so e.g. `[CHS_JPN]` resolves to the Chinese variant
 * (the part fansub groups list first), not the language-origin tag.
 */
function langCandidatesFromEnd(name: string): string[] {
  const tokens: { token: string; end: number }[] = [];

  let cursor = 0;
  for (const part of name.split('.')) {
    cursor += part.length;
    tokens.push({ token: part, end: cursor });
    cursor += 1; // the dot itself
  }

  for (const m of name.matchAll(/\[([^\]]*)\]/g)) {
    const content = m[1] ?? '';
    const end = m.index + m[0].length;
    const parts = content.split(LANG_SUBTOKEN_SPLIT).filter((p) => p.length > 0);
    for (const part of parts.length > 0 ? parts : [content]) {
      tokens.push({ token: part, end });
    }
  }

  return tokens.sort((a, b) => b.end - a.end).map((t) => t.token);
}

/**
 * Finds a fansub language/subtitle tag in a filename and normalizes it via
 * `LANG_TOKENS`. Scans dot-separated trailing tokens and `[...]` bracket contents from
 * the end of the (extension-stripped) name toward the front, returning the first
 * lowercase match. Returns `null` when no known tag is present.
 */
export function parseLangTag(filename: string): string | null {
  const name = filename.replace(/\.[^.]+$/, '');
  for (const token of langCandidatesFromEnd(name)) {
    const key = token.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LANG_TOKENS, key)) return LANG_TOKENS[key]!;
  }
  return null;
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
 * Deterministically matches a sidecar filename to one of a series' episodes, with no
 * LLM involved — only unambiguous cases resolve here; everything else (including a
 * `parseEpisodeRef` miss) returns `null` for the LLM call-site to attempt instead.
 * Callers must pre-filter `episodes` to `hasFile: true` (this function trusts whatever
 * list it's given).
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
  if (!ref) return null;

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

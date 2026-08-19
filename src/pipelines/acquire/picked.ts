export interface PickedRelease {
  title: string;
  indexer: string | null;
  size: number | null;
  seeders: number | null;
  quality: string | null;
  languages: string[];
  shape: 'pack' | 'multi' | 'single' | null;
  seasonNumber: number | null;
  forceGrab: boolean;
}

export interface ResolvePickedReleaseInput {
  picked_guid: string | null;
  candidates_json: Record<string, unknown> | null;
}

function seasonNumberOf(candidates: Record<string, unknown>): number | null {
  return typeof candidates.seasonNumber === 'number' ? candidates.seasonNumber : null;
}

function episodeNumbersOf(entry: Record<string, unknown>): number[] {
  const mapped = entry.mappedEpisodeNumbers;
  if (Array.isArray(mapped) && mapped.length > 0 && mapped.every((n) => typeof n === 'number')) {
    return mapped;
  }
  const episodes = entry.episodeNumbers;
  if (Array.isArray(episodes) && episodes.every((n) => typeof n === 'number')) {
    return episodes;
  }
  return [];
}

function shapeOf(entry: Record<string, unknown>): 'pack' | 'multi' | 'single' {
  if (entry.fullSeason === true) return 'pack';
  return episodeNumbersOf(entry).length > 1 ? 'multi' : 'single';
}

function qualityNameOf(entry: Record<string, unknown>): string | null {
  const quality = entry.quality;
  if (typeof quality !== 'object' || quality === null) return null;
  const inner = Reflect.get(quality, 'quality');
  if (typeof inner !== 'object' || inner === null) return null;
  const name = Reflect.get(inner, 'name');
  return typeof name === 'string' ? name : null;
}

function languagesOf(entry: Record<string, unknown>): string[] {
  const languages = entry.languages;
  if (!Array.isArray(languages)) return [];
  const names: string[] = [];
  for (const lang of languages) {
    if (typeof lang !== 'object' || lang === null) continue;
    const name = Reflect.get(lang, 'name');
    if (typeof name === 'string') names.push(name);
  }
  return names;
}

function mapKeptEntry(entry: Record<string, unknown>, seasonNumber: number | null): PickedRelease | null {
  if (typeof entry.title !== 'string') return null;
  return {
    title: entry.title,
    indexer: typeof entry.indexer === 'string' ? entry.indexer : null,
    size: typeof entry.size === 'number' ? entry.size : null,
    seeders: typeof entry.seeders === 'number' ? entry.seeders : null,
    quality: qualityNameOf(entry),
    languages: languagesOf(entry),
    shape: shapeOf(entry),
    seasonNumber,
    forceGrab: false,
  };
}

/**
 * Resolves the human-readable release the job actually picked (or force-grabbed) from an
 * acquire_records row's `picked_guid` + `candidates_json`. Kept candidates win when the guid
 * still matches; force-grab payloads fall back to `pickedTitle` alone.
 */
export function resolvePickedRelease(input: ResolvePickedReleaseInput): PickedRelease | null {
  const candidates = input.candidates_json;
  if (candidates === null) return null;

  const seasonNumber = seasonNumberOf(candidates);
  const kept = candidates.kept;
  if (Array.isArray(kept) && input.picked_guid !== null) {
    for (const raw of kept) {
      if (typeof raw !== 'object' || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (entry.guid !== input.picked_guid) continue;
      return mapKeptEntry(entry, seasonNumber);
    }
  }

  if (candidates.forceGrab === true) {
    const title = candidates.pickedTitle;
    if (typeof title === 'string' && title.length > 0) {
      return {
        title,
        indexer: null,
        size: null,
        seeders: null,
        quality: null,
        languages: [],
        shape: null,
        seasonNumber,
        forceGrab: true,
      };
    }
  }

  return null;
}

export interface ReleaseCandidate {
  guid: string;
  indexerId: number;
  indexer: string;
  title: string;
  size: number;
  seeders: number | null;
  leechers: number | null;
  rejected: boolean;
  rejections: string[];
  publishDate: string;
}

export interface SeasonResource {
  seasonNumber: number;
  monitored: boolean;
}

export interface SeriesResource {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  tags: number[];
  added: string;
  // Season 0 is Sonarr's convention for "Specials" — acquire deliberately skips it (see
  // runAcquireJob's per-season loop) rather than treating specials like a regular season.
  seasons: SeasonResource[];
}

export interface MovieResource {
  id: number;
  title: string;
  year: number;
  tmdbId: number;
  added: string;
  hasFile: boolean;
}

export interface TagResource {
  id: number;
  label: string;
}

export interface ReleaseProfileResource {
  id?: number;
  name: string;
  enabled: boolean;
  required: string[];
  ignored: string[];
  tags: number[];
  indexerId: number;
}

/** A notification resource, as returned by Sonarr/Radarr's `/notification` endpoint. */
export interface NotificationSummary {
  id: number;
  name: string;
}

/**
 * The public surface of `ArrClient`, extracted so consumers (and their tests) depend
 * on this interface rather than the concrete class — fakes can implement it directly
 * with no cast, and `AppContext.clients` can hold either a real client or a fake.
 */
export interface ArrApi {
  listSeries(): Promise<SeriesResource[]>;
  listMovies(): Promise<MovieResource[]>;
  getSeries(id: number): Promise<SeriesResource>;
  updateSeries(s: SeriesResource): Promise<SeriesResource>;
  searchReleases(p: { seriesId?: number; seasonNumber?: number; movieId?: number }): Promise<ReleaseCandidate[]>;
  grabRelease(guid: string, indexerId: number): Promise<void>;
  listTags(): Promise<TagResource[]>;
  createTag(label: string): Promise<TagResource>;
  deleteTag(id: number): Promise<void>;
  listReleaseProfiles(): Promise<ReleaseProfileResource[]>;
  createReleaseProfile(p: ReleaseProfileResource): Promise<ReleaseProfileResource>;
  updateReleaseProfile(p: ReleaseProfileResource): Promise<ReleaseProfileResource>;
  deleteReleaseProfile(id: number): Promise<void>;
  listNotifications(): Promise<NotificationSummary[]>;
  createNotification(body: object): Promise<NotificationSummary>;
  deleteNotification(id: number): Promise<void>;
}

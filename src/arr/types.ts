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
  onDownload?: boolean;
  onUpgrade?: boolean;
}

export interface QueueRecord {
  id: number;
  downloadId?: string;
  seriesId?: number;
  movieId?: number;
  status: string; // 'downloading' | 'completed' | ...
  trackedDownloadStatus?: string; // 'ok' | 'warning' | 'error'
  trackedDownloadState?: string; // 'downloading' | 'importPending' | 'importing' | 'imported' | ...
  title: string;
}

export interface HistoryRecord {
  id: number;
  seriesId?: number;
  movieId?: number;
  episodeId?: number;
  eventType: string; // 'downloadFolderImported' is the one Ingest cares about
  date: string;
  sourceTitle: string;
  // droppedPath / importedPath / downloadId live here on import events
  data: Record<string, string | undefined>;
}

export interface EpisodeResource {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber?: number;
  title: string;
  episodeFileId: number; // 0 = no file on disk
  hasFile: boolean;
}

export interface EpisodeFileResource {
  id: number;
  seriesId: number;
  seasonNumber: number;
  relativePath: string;
  path: string;
}

export interface MovieFileResource {
  id: number;
  movieId: number;
  relativePath: string;
  path: string;
}

/** One row from GET /manualimport — quality/languages are opaque blobs we round-trip
 * verbatim into the ManualImport command, never inspect. */
export interface ManualImportItem {
  path: string;
  folderName: string;
  size: number;
  quality: Record<string, unknown>;
  languages: Record<string, unknown>[];
  episodes: { id: number }[];
  movie?: { id: number };
  releaseGroup?: string;
  rejections: { reason: string }[];
}

export interface ManualImportFile {
  path: string;
  folderName?: string;
  seriesId?: number;
  episodeIds?: number[];
  movieId?: number;
  quality: Record<string, unknown>;
  languages: Record<string, unknown>[];
  releaseGroup?: string;
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
  listQueue(): Promise<QueueRecord[]>;
  listSeriesHistory(seriesId: number): Promise<HistoryRecord[]>; // Sonarr, imports only
  listMovieHistory(movieId: number): Promise<HistoryRecord[]>; // Radarr, imports only
  listRecentImports(pageSize: number): Promise<HistoryRecord[]>; // newest-first global import history
  listEpisodes(seriesId: number): Promise<EpisodeResource[]>;
  listEpisodeFiles(seriesId: number): Promise<EpisodeFileResource[]>;
  listMovieFiles(movieId: number): Promise<MovieFileResource[]>;
  listManualImport(p: {
    folder?: string;
    downloadId?: string;
    seriesId?: number;
    movieId?: number;
    filterExistingFiles?: boolean;
  }): Promise<ManualImportItem[]>;
  executeManualImport(files: ManualImportFile[], importMode: 'copy' | 'move'): Promise<void>;
  deleteNotification(id: number): Promise<void>;
}

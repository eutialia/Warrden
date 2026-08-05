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

export interface SeriesResource {
  id: number;
  title: string;
  year: number;
  tvdbId: number;
  tags: number[];
  added: string;
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

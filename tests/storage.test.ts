import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/config/schema.js';
import {
	configuredStoragePaths,
	downloadsPath,
	effectiveDownloadRoots,
	storageRoles,
} from '../src/config/storage.js';

function cfg(partial: Record<string, unknown> = {}) {
	return ConfigSchema.parse(partial);
}

describe('storage config', () => {
	it('defaults to the container paths so an existing config.json keeps working', () => {
		expect(configuredStoragePaths(cfg())).toEqual(['/tv', '/anime', '/movies', '/downloads']);
		expect(storageRoles(cfg()).map((r) => r.label)).toEqual(['Series', 'Anime', 'Movies', 'Downloads']);
		expect(downloadsPath(cfg())).toBe('/downloads');
	});

	it('reads host paths from the config', () => {
		const c = cfg({ storage: { series: '/mnt/media/Series', downloads: '/mnt/downloads' } });
		expect(configuredStoragePaths(c)).toEqual(['/mnt/media/Series', '/anime', '/movies', '/mnt/downloads']);
	});

	it('treats a blank path as a disabled role', () => {
		const c = cfg({ storage: { anime: '' } });
		const anime = storageRoles(c).find((r) => r.id === 'anime')!;
		expect(anime.configured).toBe(false);
		expect(configuredStoragePaths(c)).toEqual(['/tv', '/movies', '/downloads']);
	});

	it('rejects a relative path, which would resolve against the working directory', () => {
		const result = ConfigSchema.safeParse({ storage: { series: 'media/Series' } });
		expect(result.success).toBe(false);
	});

	it('effectiveDownloadRoots falls back to the downloads path itself', () => {
		expect(effectiveDownloadRoots(cfg())).toEqual(['/downloads']);
	});

	it('effectiveDownloadRoots prefers the arr-side path from pathMappings', () => {
		const c = cfg({ pathMappings: [{ from: '/mnt/nas/Downloads', to: '/downloads' }] });
		expect(effectiveDownloadRoots(c)).toEqual(['/mnt/nas/Downloads']);
	});

	it('effectiveDownloadRoots matches a mapping whose target has a trailing slash', () => {
		const c = cfg({
			storage: { downloads: '/mnt/downloads' },
			pathMappings: [{ from: '/data/dl', to: '/mnt/downloads/' }],
		});
		expect(effectiveDownloadRoots(c)).toEqual(['/data/dl']);
	});

	it('effectiveDownloadRoots is empty when Downloads is disabled', () => {
		const c = cfg({
			storage: { downloads: '' },
			pathMappings: [{ from: '/mnt/nas/Downloads', to: '/downloads' }],
		});
		expect(effectiveDownloadRoots(c)).toEqual([]);
	});
});

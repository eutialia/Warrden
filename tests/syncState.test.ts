import { describe, it, expect } from 'vitest';
import { SyncState } from '../src/db/syncState.js';
import { freshDb } from './helpers.js';

describe('SyncState', () => {
  it('returns undefined for a key that was never written', () => {
    const state = new SyncState(freshDb());
    expect(state.read('missing')).toBeUndefined();
  });

  it('round-trips JSON values, including arrays and booleans', () => {
    const state = new SyncState(freshDb());
    state.write('seen:sonarr', [1, 2, 3]);
    state.write('bootstrap:sonarr', true);

    expect(state.read<number[]>('seen:sonarr')).toEqual([1, 2, 3]);
    expect(state.read<boolean>('bootstrap:sonarr')).toBe(true);
  });

  it('write() overwrites an existing key rather than erroring on the PRIMARY KEY', () => {
    const state = new SyncState(freshDb());
    state.write('seen:sonarr', [1]);
    state.write('seen:sonarr', [1, 2]);

    expect(state.read<number[]>('seen:sonarr')).toEqual([1, 2]);
  });
});

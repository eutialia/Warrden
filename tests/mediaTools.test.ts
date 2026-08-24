import { describe, expect, it, vi } from 'vitest';
import { CliMediaTools } from '../src/media/tools.js';

const VERSION_PROBES: Record<'ffprobe' | 'alass' | 'ffsubsync', string[]> = {
  ffprobe: ['-version'],
  alass: ['--version'],
  ffsubsync: ['--version'],
};

describe('CliMediaTools.available', () => {
  it.each(Object.entries(VERSION_PROBES))('probes %s with %j', async (bin, argv) => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const tools = new CliMediaTools({ exec });

    await tools.available();

    expect(exec).toHaveBeenCalledWith(bin, argv, expect.anything());
  });

  it.each(Object.keys(VERSION_PROBES) as Array<'ffprobe' | 'alass' | 'ffsubsync'>)(
    'reports %s unavailable when its probe rejects',
    async (bin) => {
      const exec = vi.fn().mockRejectedValue(new Error('not found'));
      const tools = new CliMediaTools({ exec });

      const availability = await tools.available();

      expect(availability[bin]).toBe(false);
    },
  );

  it.each(Object.keys(VERSION_PROBES) as Array<'ffprobe' | 'alass' | 'ffsubsync'>)(
    'reports %s available when its probe resolves',
    async (bin) => {
      const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
      const tools = new CliMediaTools({ exec });

      const availability = await tools.available();

      expect(availability[bin]).toBe(true);
    },
  );

  it('memoizes the probe: exec is called once per binary across two available() calls', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const tools = new CliMediaTools({ exec });

    await tools.available();
    await tools.available();

    expect(exec).toHaveBeenCalledTimes(3);
  });
});

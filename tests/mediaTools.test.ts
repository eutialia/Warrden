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

const TIMEOUT_MS = 30_000;
const RESYNC_TIMEOUT_MS = 10 * 60_000;

describe('CliMediaTools exec timeouts', () => {
  it.each([
    ['probeStreams', (tools: CliMediaTools) => tools.probeStreams('video.mkv'), TIMEOUT_MS, '{"streams":[]}'],
    ['extractSubtitle', (tools: CliMediaTools) => tools.extractSubtitle('video.mkv', 2, 'out.srt'), TIMEOUT_MS, ''],
    [
      'resyncAlass',
      (tools: CliMediaTools) => tools.resyncAlass({ reference: 'ref.srt', subtitle: 'sub.srt', outPath: 'out.srt' }),
      RESYNC_TIMEOUT_MS,
      '',
    ],
    [
      'resyncFfsubsync',
      (tools: CliMediaTools) =>
        tools.resyncFfsubsync({ videoPath: 'video.mkv', subtitlePath: 'sub.srt', outPath: 'out.srt' }),
      RESYNC_TIMEOUT_MS,
      '',
    ],
  ] as const)('%s runs its exec through the injected seam with a %ims timeout', async (_name, invoke, expectedTimeout, stdout) => {
    const exec = vi.fn().mockResolvedValue({ stdout, stderr: '' });
    const tools = new CliMediaTools({ exec });

    await invoke(tools);

    expect(exec).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: expectedTimeout }),
    );
  });
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 30_000;
/** alass and ffsubsync run minutes-scale on a full episode (ffsubsync runs VAD over the whole
 * audio track; alass decodes the reference through ffmpeg) — the 30s probe/extract timeout
 * would kill a resync mid-run. */
const RESYNC_TIMEOUT_MS = 10 * 60_000;

type ExecFileAsync = typeof execFileAsync;
type ProbedBinary = 'ffprobe' | 'alass' | 'ffsubsync';

/** The flag each binary actually accepts for a version check. `ffprobe -version` exits 0,
 * but `alass`/`ffsubsync` only accept the long form — `-version` on either exits non-zero
 * (clap/argparse reject it as an unknown flag), which used to make `available()` report
 * both as missing even when installed. */
const VERSION_PROBE_ARGS: Record<ProbedBinary, string[]> = {
  ffprobe: ['-version'],
  alass: ['--version'],
  ffsubsync: ['--version'],
};

export interface MediaStream {
  index: number;
  codecType: 'subtitle' | 'audio' | 'video' | 'other';
  codecName: string;
  language: string | null;
  /** ffprobe's `disposition.forced`: the track only carries lines for foreign dialogue/signs. */
  forced: boolean;
  /** ffprobe's `tags.title`, e.g. 'FR Forced : SRT'. Some muxes mark forced only here. */
  title: string | null;
}

/**
 * The seam every external media binary hides behind. Production wires `CliMediaTools`;
 * tests inject a fake. Nothing outside `src/media/` may `execFile` ffprobe/alass/ffsubsync
 * directly — binary discovery, timeouts, and stderr massaging live here exactly once.
 */
export interface MediaTools {
  /** Subtitle/audio/video stream listing for a container (ffprobe). */
  probeStreams(videoPath: string): Promise<MediaStream[]>;
  /** Extracts one stream (by ffprobe stream index) to a standalone subtitle file (ffmpeg). */
  extractSubtitle(videoPath: string, streamIndex: number, destPath: string): Promise<void>;
  /** alass: aligns `subtitle` to `reference` (a video or another subtitle), writes `outPath`. */
  resyncAlass(input: { reference: string; subtitle: string; outPath: string }): Promise<void>;
  /** ffsubsync fallback: aligns `subtitlePath` to the video's audio. */
  resyncFfsubsync(input: { videoPath: string; subtitlePath: string; outPath: string }): Promise<void>;
  /** Which binaries resolved on PATH (memoized at first call). Never throws. */
  available(): Promise<{ ffprobe: boolean; alass: boolean; ffsubsync: boolean }>;
}

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  disposition?: { forced?: number };
  tags?: { language?: string; title?: string };
}

/** `MediaTools` over real CLI binaries. Binaries are located lazily by name (PATH), so a
 * container missing `alass` degrades to the ffsubsync fallback instead of failing to boot. */
export class CliMediaTools implements MediaTools {
  private readonly exec: ExecFileAsync;
  private availability: { ffprobe: boolean; alass: boolean; ffsubsync: boolean } | null = null;

  constructor(opts: { exec?: ExecFileAsync } = {}) {
    this.exec = opts.exec ?? execFileAsync;
  }

  async available(): Promise<{ ffprobe: boolean; alass: boolean; ffsubsync: boolean }> {
    if (this.availability === null) {
      const [ffprobe, alass, ffsubsync] = await Promise.all([
        this.resolves('ffprobe'),
        this.resolves('alass'),
        this.resolves('ffsubsync'),
      ]);
      this.availability = { ffprobe, alass, ffsubsync };
    }
    return this.availability;
  }

  private async resolves(bin: ProbedBinary): Promise<boolean> {
    try {
      await this.exec(bin, VERSION_PROBE_ARGS[bin], { timeout: TIMEOUT_MS });
      return true;
    } catch {
      return false; // not installed, or installed-but-broken — same operational answer
    }
  }

  async probeStreams(videoPath: string): Promise<MediaStream[]> {
    const { stdout } = await this.exec(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', videoPath],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[] };
    return (parsed.streams ?? []).map((s) => ({
      index: s.index,
      codecType:
        s.codec_type === 'subtitle' ? 'subtitle' : s.codec_type === 'audio' ? 'audio' : s.codec_type === 'video' ? 'video' : 'other',
      codecName: s.codec_name ?? '',
      language: s.tags?.language ?? null,
      forced: s.disposition?.forced === 1,
      title: s.tags?.title ?? null,
    }));
  }

  async extractSubtitle(videoPath: string, streamIndex: number, destPath: string): Promise<void> {
    await this.exec('ffmpeg', ['-y', '-v', 'error', '-i', videoPath, '-map', `0:${streamIndex}`, destPath], {
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  async resyncAlass(input: { reference: string; subtitle: string; outPath: string }): Promise<void> {
    await this.exec('alass', [input.reference, input.subtitle, input.outPath], {
      timeout: RESYNC_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  async resyncFfsubsync(input: { videoPath: string; subtitlePath: string; outPath: string }): Promise<void> {
    await this.exec('ffsubsync', [input.videoPath, '-i', input.subtitlePath, '-o', input.outPath], {
      timeout: RESYNC_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}

import { describe, expect, it } from 'vitest';
import { decodeSubtitleBytes, parseSubtitleCues } from '../src/media/subtitles.js';

describe('decodeSubtitleBytes', () => {
  it('strips a UTF-8 BOM', () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')]);
    const text = decodeSubtitleBytes(raw);
    expect(text.startsWith('1\n')).toBe(true);
    expect(parseSubtitleCues(text)).toHaveLength(1);
  });

  it('decodes UTF-16 LE with BOM into parseable SRT', () => {
    const body = '1\n00:00:01,000 --> 00:00:02,000\nhi\n';
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
    const text = decodeSubtitleBytes(raw);
    expect(parseSubtitleCues(text)).toHaveLength(1);
  });
});

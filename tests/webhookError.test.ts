import { describe, it, expect } from 'vitest';
import { ArrApiError } from '../src/arr/client.js';
import { webhookFailureDetail } from '../src/arr/webhookError.js';

const URL = 'http://localhost:9797/webhooks/sonarr';
const STACK = 'System.Net.Http.HttpRequestException: Connection refused (localhost:9797)\n at NzbDrone.Common.Http.Dispatchers.ManagedHttpDispatcher';

describe('webhookFailureDetail', () => {
  it('uses Sonarr/Radarr\'s short message and drops the stack in description', () => {
    const err = new ArrApiError(
      'PUT',
      '/notification/3',
      500,
      JSON.stringify({ message: 'Connection refused (localhost:9797)', description: STACK }),
    );
    const detail = webhookFailureDetail(err, URL);
    expect(detail).toContain('Connection refused (localhost:9797)');
    expect(detail).toContain(URL);
    expect(detail).not.toContain('HttpRequestException');
    expect(detail).not.toContain('ManagedHttpDispatcher');
  });

  it('does not paste a huge non-JSON body into the event', () => {
    const err = new ArrApiError('PUT', '/notification/3', 500, 'x'.repeat(4000));
    const detail = webhookFailureDetail(err, URL);
    expect(detail.length).toBeLessThan(500);
    expect(detail).not.toContain('tried to reach');
  });

  it('does not blame Public URL when the arr itself is unreachable', () => {
    const detail = webhookFailureDetail(new Error('ECONNREFUSED'), URL);
    expect(detail).toContain('ECONNREFUSED');
    expect(detail).not.toContain('tried to reach');
  });
});

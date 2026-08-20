import { describe, it, expect } from 'vitest';
import { detectPublicUrl, isLoopbackHost, suggestPublicUrl } from '../src/arr/publicUrl.js';
import type { NetAddress } from '../src/arr/publicUrl.js';

function addr(name: string, address: string, extras?: Partial<NetAddress>): NetAddress {
  return { name, address, family: 'IPv4', internal: false, ...extras };
}

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]'])('treats %s as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['192.168.1.50', 'warrden.local', 'example.com'])('treats %s as a real host', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('detectPublicUrl', () => {
  it('picks the IPv4 on the default-route interface', () => {
    expect(
      detectPublicUrl({
        port: 9797,
        defaultIface: 'eth0',
        addresses: [addr('eth0', '192.168.1.50'), addr('wlan0', '10.0.0.4')],
      }),
    ).toBe('http://192.168.1.50:9797');
  });

  it('skips loopback, link-local, internal, and virtual interfaces', () => {
    expect(
      detectPublicUrl({
        port: 9797,
        addresses: [
          addr('lo', '127.0.0.1', { internal: true }),
          addr('eth0', '169.254.1.1'),
          addr('docker0', '172.17.0.1'),
          addr('br-abc', '172.18.0.1'),
          addr('veth0', '172.18.0.2'),
          addr('eth0', '192.168.1.50'),
        ],
      }),
    ).toBe('http://192.168.1.50:9797');
  });

  it('falls back to localhost when nothing usable remains', () => {
    expect(
      detectPublicUrl({
        port: 9797,
        addresses: [addr('lo', '127.0.0.1', { internal: true })],
      }),
    ).toBe('http://localhost:9797');
  });

  it('falls back to localhost inside a container whose only addresses are docker-shaped', () => {
    expect(
      detectPublicUrl({
        port: 9797,
        inContainer: true,
        addresses: [addr('eth0', '172.18.0.2')],
      }),
    ).toBe('http://localhost:9797');
  });

  it('still uses a LAN IPv4 inside a container (host networking)', () => {
    expect(
      detectPublicUrl({
        port: 9797,
        inContainer: true,
        defaultIface: 'eth0',
        addresses: [addr('eth0', '192.168.1.50')],
      }),
    ).toBe('http://192.168.1.50:9797');
  });
});

describe('suggestPublicUrl', () => {
  it('offers the page origin when Public URL is loopback and the origin is not', () => {
    expect(
      suggestPublicUrl({
        publicUrl: 'http://localhost:9797',
        origin: 'http://192.168.1.50:9797',
        listenPort: 9797,
      }),
    ).toBe('http://192.168.1.50:9797');
  });

  it('rewrites a Vite dev port to the listen port, keeping the hostname', () => {
    expect(
      suggestPublicUrl({
        publicUrl: 'http://localhost:9797',
        origin: 'http://192.168.1.50:5173',
        listenPort: 9797,
      }),
    ).toBe('http://192.168.1.50:9797');
  });

  it('keeps a reverse-proxy origin as-is, including https', () => {
    expect(
      suggestPublicUrl({
        publicUrl: 'http://localhost:9797',
        origin: 'https://warrden.example.com',
        listenPort: 9797,
      }),
    ).toBe('https://warrden.example.com');
  });

  it('returns null when Public URL is already a real host', () => {
    expect(
      suggestPublicUrl({
        publicUrl: 'http://192.168.1.50:9797',
        origin: 'http://192.168.1.50:9797',
        listenPort: 9797,
      }),
    ).toBeNull();
  });

  it('returns null when the page itself was opened on loopback', () => {
    expect(
      suggestPublicUrl({
        publicUrl: 'http://localhost:9797',
        origin: 'http://localhost:9797',
        listenPort: 9797,
      }),
    ).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { detectPublicUrl } from '../src/arr/publicUrl.js';
import type { NetAddress } from '../src/arr/publicUrl.js';

function addr(name: string, address: string, extras?: Partial<NetAddress>): NetAddress {
  return { name, address, family: 'IPv4', internal: false, ...extras };
}

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

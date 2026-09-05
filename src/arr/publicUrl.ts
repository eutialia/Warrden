import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

export interface NetAddress {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  internal: boolean;
}

const VIRTUAL_IFACE = /^(lo|docker0|br-.+|veth.*|cni.*|flannel.*|virbr.*|tun.*|tap.*|wg.*)$/;

function isLoopbackIpv4(address: string): boolean {
  const n = ipv4ToInt(address);
  if (n === undefined) return false;
  return (n >>> 24) === 127;
}

function isLinkLocalIpv4(address: string): boolean {
  const n = ipv4ToInt(address);
  if (n === undefined) return false;
  return (n >>> 16) === 0xa9fe; // 169.254.0.0/16
}

function isDockerIpv4(address: string): boolean {
  const n = ipv4ToInt(address);
  if (n === undefined) return false;
  return (n >>> 20) === 0xac1; // 172.16.0.0/12
}

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    n = (n << 8) + octet;
  }
  return n >>> 0;
}

function isUsableLan(addr: NetAddress, inContainer: boolean): boolean {
  if (addr.internal || addr.family !== 'IPv4') return false;
  if (VIRTUAL_IFACE.test(addr.name)) return false;
  if (isLoopbackIpv4(addr.address) || isLinkLocalIpv4(addr.address)) return false;
  if (inContainer && isDockerIpv4(addr.address)) return false;
  return true;
}

export function detectPublicUrl(input: {
  port: number;
  addresses: NetAddress[];
  defaultIface?: string;
  inContainer?: boolean;
}): string {
  const inContainer = input.inContainer === true;
  const usable = input.addresses.filter((addr) => isUsableLan(addr, inContainer));
  const preferred = input.defaultIface ? usable.filter((addr) => addr.name === input.defaultIface) : [];
  const chosen = preferred[0] ?? usable[0];
  if (!chosen) return `http://localhost:${input.port}`;
  return `http://${chosen.address}:${input.port}`;
}

/** First-boot default: a LAN IPv4 when we can prove one, otherwise localhost. */
export function defaultPublicUrl(port: number): string {
  return detectPublicUrl({
    port,
    addresses: listHostAddresses(),
    defaultIface: readDefaultIface(),
    inContainer: existsSync('/.dockerenv'),
  });
}

function listHostAddresses(): NetAddress[] {
  const out: NetAddress[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const info of addrs ?? []) {
      const family: 'IPv4' | 'IPv6' = info.family === 'IPv6' ? 'IPv6' : 'IPv4';
      out.push({ name, address: info.address, family, internal: info.internal });
    }
  }
  return out;
}

/** Linux default route's interface, or undefined when `/proc/net/route` is missing (macOS/Windows). */
function readDefaultIface(): string | undefined {
  if (!existsSync('/proc/net/route')) return undefined;
  const text = readFileSync('/proc/net/route', 'utf8');
  let best: { iface: string; metric: number } | undefined;
  for (const line of text.split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 8) continue;
    if (cols[1] !== '00000000') continue;
    const metric = Number.parseInt(cols[6] ?? '0', 10);
    if (!best || metric < best.metric) best = { iface: cols[0] ?? '', metric };
  }
  return best?.iface || undefined;
}

import { isIP } from 'node:net';

/** The four bytes of a dotted-quad IPv4 address, which `isIP` has already validated. */
function ipv4Bytes(address: string): number[] {
  return address.split('.').map(Number);
}

/**
 * An IPv6 literal as its 16 bytes, or `null` if it can't be read. Handles the one `::`
 * run and a trailing dotted quad (`::ffff:127.0.0.1`), which is all the textual forms
 * are; callers reach this only after `isIP` has said the string is a valid IPv6 address.
 */
function ipv6Bytes(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const expand = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const groups = part.split(':');
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      if (i === groups.length - 1 && group.includes('.')) {
        out.push(...ipv4Bytes(group));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      out.push(value >> 8, value & 0xff);
    }
    return out;
  };

  const head = expand(halves[0]!);
  const tail = halves.length === 2 ? expand(halves[1]!) : [];
  if (head === null || tail === null) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * The IPv4 address an IPv6 literal carries inside it, when its prefix means "this is
 * really a way of reaching an IPv4 address". Four prefixes qualify:
 *
 * - `::ffff:0:0/96` (IPv4-mapped — what `http://[::ffff:127.0.0.1]/` becomes once the URL
 *   parser normalizes it), `::/96` (IPv4-compatible, and with it `::1` and `::` for free,
 *   since they read as `0.0.0.1` and `0.0.0.0`), and `::ffff:0:0:0/96` (IPv4-translated):
 *   the address sits in the low four bytes.
 * - `2002::/16` (6to4): the address sits in bytes 2-5, so `[2002:a00:1::]` is a spelling
 *   of `10.0.0.1`.
 * - `64:ff9b::/96` (the well-known NAT64 prefix): the address sits in the low four bytes
 *   again, and a NAT64 gateway will happily translate it onto the LAN.
 *
 * Every one of those spellings can reach the same machine as the bare IPv4 address, so all
 * of them are judged as that address rather than as an unrecognized IPv6 host.
 *
 * NAT64's other prefix, local-use `64:ff9b:1::/48` (RFC 8215), is NOT decoded here — see
 * `isPrivateOrLoopbackHost`, which refuses the whole prefix instead, because where the
 * IPv4 address sits inside it is a local choice this code cannot know.
 */
function embeddedIpv4(bytes: number[]): number[] | null {
  const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return bytes.slice(2, 6); // 6to4
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zeros(4, 12)) {
    return bytes.slice(12); // NAT64 well-known prefix
  }
  const mappedOrCompatible = zeros(0, 10) && (zeros(10, 12) || (bytes[10] === 0xff && bytes[11] === 0xff));
  const translated = zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(10, 12);
  return mappedOrCompatible || translated ? bytes.slice(12) : null;
}

function isPrivateIpv4(bytes: number[]): boolean {
  const [a, b] = bytes as [number, number];
  if (a === 0) return true; // "this network" 0/8 — 0.0.0.0 reaches loopback on Linux
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 169 && b === 254) return true; // link-local 169.254/16 (incl. 169.254.169.254)
  return false;
}

/**
 * Whether `hostname` (a URL's `.hostname`) names a loopback, private, or link-local
 * destination. Closes the server-side-request-forgery shape — page text and stored
 * knowledge the agent reads can otherwise name any URL, and without this guard a fetch
 * verb would happily reach a LAN service or a cloud metadata endpoint.
 *
 * The host is normalized before any range test, because the ranges are the easy half and
 * the spellings are the hard one. A trailing dot comes off (`localhost.` resolves exactly
 * like `localhost`), an IPv6 literal is read as its 16 bytes, and a literal that carries
 * an IPv4 address anywhere a transition mechanism puts one is judged as that IPv4 address.
 * What is then refused: `0.0.0.0/8`, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`,
 * `169.254/16` (which includes the cloud metadata address `169.254.169.254`), the names
 * `localhost` and `*.localhost`, `::1` and `::`, unique-local `fc00::/7`, link-local
 * `fe80::/10`, deprecated site-local `fec0::/10`, any 6to4 (`2002::/16`) or well-known
 * NAT64 (`64:ff9b::/96`) spelling of a refused IPv4 address, and every address under the
 * local-use NAT64 prefix `64:ff9b:1::/48` (RFC 8215).
 *
 * That last one is refused whole rather than decoded, because RFC 6052 lets a NAT64 embed
 * the IPv4 address at /48, /56, /64 or /96 and the choice is the gateway operator's — so
 * there is no way to read the address out of it from the literal alone. A locally-run
 * NAT64 is also precisely the gateway that translates onto the LAN, and nothing Warrden
 * fetches is reachable only through one, so failing closed on the prefix costs nothing.
 *
 * What it does NOT catch, and cannot: a hostname that merely *resolves* to one of those
 * addresses. An attacker who controls a DNS record can point `pack.example.test` at
 * 127.0.0.1, or answer twice and rebind between this check and the connection. Catching
 * that means checking the address the socket actually connected to, which needs a custom
 * agent/lookup hook rather than a URL test. This guard covers literals only, and that is
 * the whole of the claim.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);

  const version = isIP(host);
  if (version === 4) return isPrivateIpv4(ipv4Bytes(host));
  if (version === 6) {
    const bytes = ipv6Bytes(host);
    if (bytes === null) return true; // a literal this can't read is refused, not allowed
    const embedded = embeddedIpv4(bytes);
    if (embedded !== null) return isPrivateIpv4(embedded);
    // local-use NAT64 64:ff9b:1::/48 — refused whole, the embedding offset is unknowable
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes[4] === 0x00 && bytes[5] === 0x01) {
      return true;
    }
    if ((bytes[0]! & 0xfe) === 0xfc) return true; // unique-local fc00::/7
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true; // link-local fe80::/10
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true; // site-local fec0::/10 (deprecated, still routed)
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost');
}

/** Why a destination must not be fetched. `unparseable` is its own kind because it is a
 * different story for a human: a model that wrote a malformed URL, not one that aimed at
 * the LAN. */
export type RefusedDestination = 'private' | 'unparseable';

/**
 * Whether `url` is a destination Warrden refuses to fetch, and why — `null` when it may be
 * fetched. THE one implementation: the agent loop checks every action's URL through it
 * before spending a fetch, and the fetch tiers check every redirect hop through it, so a
 * public URL cannot 302 the agent onto a guarded address behind the loop's back.
 *
 * Fails closed on a URL that will not parse. Nothing downstream can do anything useful
 * with one either (`fetch` rejects it), but a guard that answers "allowed" for an input it
 * did not understand is the wrong shape to leave lying around.
 */
export function refusedDestination(url: string): RefusedDestination | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 'unparseable';
  }
  return isPrivateOrLoopbackHost(hostname) ? 'private' : null;
}

/** Where a redirect hop points, and whether it may be followed. */
export interface RedirectTarget {
  /** The resolved absolute URL, or the raw `Location` value when it would not resolve. */
  url: string;
  refused: RefusedDestination | null;
}

/**
 * Resolves a `Location` header against the URL it came from and judges the result. THE one
 * place a redirect target becomes a destination, shared by every tier, so no hop is
 * followed on a path that skipped the check and none fails silently on one that skipped
 * the resolve.
 *
 * A `Location` that will not resolve is a refusal, not an error: nothing can be fetched
 * from it either way, but reported as a refusal it carries the hop into the transcript
 * instead of vanishing into a generic network failure.
 */
export function resolveRedirect(location: string, from: string): RedirectTarget {
  let url: string;
  try {
    url = new URL(location, from).href;
  } catch {
    return { url: location, refused: 'unparseable' };
  }
  return { url, refused: refusedDestination(url) };
}

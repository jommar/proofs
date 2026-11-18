import { isIP } from 'node:net';

export const proofUrlKey = /^PROOF_[A-Z][A-Z0-9_]{0,47}_URL$/;
export const proofContextKey = /^PROOF_CONTEXT_[A-Z][A-Z0-9_]{0,47}$/;
const localName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/;
const originPattern = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|\[::1\]|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost)(?::\d{1,5})?\/?$/i;

// Target mode (--url) points the checks at an already-running environment chosen by the operator on the
// command line. The runner sets PROOF_TARGET=1 for the adapters; a manifest can never turn it on.
export const targetMode = (env = process.env) => env.PROOF_TARGET === '1';
const targetPattern = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?\/?$/i;

export function localOrigin(value, target = targetMode()) {
  const pattern = target ? targetPattern : originPattern;
  if (typeof value !== 'string' || value.length > 320 || !pattern.test(value)) {
    throw new Error(target ? 'Invalid origin' : 'Invalid loopback origin');
  }
  return new URL(value).origin;
}

export function loopbackAddress(host) {
  if (host === '[::1]') return '::1';
  if (isIP(host) === 4 && host.startsWith('127.')) return host;
  if (localName.test(host)) return '127.0.0.1';
}

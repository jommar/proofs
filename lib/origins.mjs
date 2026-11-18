import { isIP } from 'node:net';

export const proofUrlKey = /^PROOF_[A-Z][A-Z0-9_]{0,47}_URL$/;
export const proofContextKey = /^PROOF_CONTEXT_[A-Z][A-Z0-9_]{0,47}$/;
const localName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/;
const originPattern = /^https?:\/\/(?:127(?:\.\d{1,3}){3}|\[::1\]|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*localhost)(?::\d{1,5})?\/?$/i;

export function localOrigin(value) {
  if (typeof value !== 'string' || value.length > 320 || !originPattern.test(value)) throw new Error('Invalid loopback origin');
  return new URL(value).origin;
}

export function loopbackAddress(host) {
  if (host === '[::1]') return '::1';
  if (isIP(host) === 4 && host.startsWith('127.')) return host;
  if (localName.test(host)) return '127.0.0.1';
}

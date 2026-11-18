import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { loopbackAddress } from '../lib/origins.mjs';

const maxBytes = 2 * 1024 * 1024;
const jsonDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Connect directly to loopback, without DNS/proxy discovery; preserve Host and TLS SNI.
export async function exchange(url, { method = 'GET', headers = {}, body } = {}) {
  const address = loopbackAddress(url.hostname);
  if (!address || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Unsafe request');
  }
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
      agent: false,
      family: isIP(address),
      autoSelectFamily: false,
      lookup: (_host, _opts, done) => done(null, address, isIP(address)),
      rejectUnauthorized: true,
      signal: AbortSignal.timeout(10_000),
    }, (response) => {
      const { statusCode: status, headers } = response;
      if (status >= 300 && status < 400 && headers.location) {
        try {
          const target = new URL(headers.location, url);
          if (target.origin !== url.origin || target.username || target.password) throw new Error();
        } catch {
          reject(new Error('Unsafe redirect'));
          response.destroy();
          return;
        }
      }
      const chunks = [];
      let size = 0;
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Incomplete response')));
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error('Response too large'));
          response.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let body;
        let json = false;
        const type = headers['content-type']?.split(';', 1)[0].trim();
        if (/^application\/(?:json|[\w.+-]+\+json)$/i.test(type)) {
          try { body = JSON.parse(jsonDecoder.decode(bytes)); json = true; } catch { /* unusable as JSON */ }
        }
        // Preserve the text representation for explicit whole-body text checks only.
        resolve({ status, headers, body: json ? body : bytes.toString('utf8'), json });
      });
    });
    request.on('error', reject);
    request.on('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Upgrade is not supported'));
    });
    request.end(body);
  });
}

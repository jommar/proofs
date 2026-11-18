import { createBdd, test as bddTest } from 'playwright-bdd';
import { proofUrlKey } from '../lib/origins.mjs';
import { proxyFailureHeader } from './loopback.mjs';
import { safeFacts, safeReason } from './reporter.mjs';

const allowed = new Set(Object.entries(process.env).filter(([key]) => proofUrlKey.test(key)).map(([, origin]) => origin));

function record(info, status, observed) {
  info.annotations.push({ type: 'proof-evidence', description: JSON.stringify({ status, observed }) });
}

export const test = bddTest.extend({
  _localNavigation: [async ({ context }, use, info) => {
    const checkOrigin = (request, location) => {
      try {
        const url = new URL(location, request.url());
        if (allowed.has(url.origin) || url.href === 'about:blank') return true;
      } catch { /* invalid redirect target */ }
      record(info, 'blocked', { reason: 'non_local_navigation' });
      return false;
    };
    const blockTransport = () => record(info, 'blocked', { reason: 'navigation_transport_failure' });
    context.on('requestfailed', request => {
      if (!request.isNavigationRequest() || !checkOrigin(request, request.url())) return;
      const error = request.failure()?.errorText;
      // Downloads/superseded navigations can abort; an actual HTTP error is still an app response.
      if (error && error !== 'net::ERR_ABORTED' && error !== 'net::ERR_HTTP_RESPONSE_CODE_FAILURE') blockTransport();
    });
    context.on('response', response => {
      const request = response.request();
      if (!request.isNavigationRequest()) return;
      const status = response.status();
      const headers = response.headers();
      if (status >= 300 && status < 400 && headers.location) checkOrigin(request, headers.location);
      if (status === 502 && response.url().startsWith('http:') && headers[proxyFailureHeader] === '1') {
        // The proxy strips this header from forwarded HTTP and cannot inspect tunneled HTTPS.
        blockTransport();
      }
    });
    await use();
  }, { auto: true }],
  proof: async ({ context }, use, info) => {
    const proof = {
      check(condition, facts) {
        if (typeof condition !== 'boolean' || !safeFacts(facts)) {
          throw new Error('Invalid proof observation');
        }
        record(info, condition ? 'pass' : 'fail', { ...facts });
        if (!condition) throw new Error('Proof condition did not hold');
      },
      block(reason) {
        // A short static code, not an exception, URL, credential or UI string.
        record(info, 'blocked', { reason: safeReason(reason) });
        info.skip(true);
      },
      async fetch(url, options = {}) {
        let target;
        try { target = new URL(url); } catch { proof.block('invalid_request_origin'); }
        if (!allowed.has(target.origin) || target.username || target.password) proof.block('invalid_request_origin');
        const response = await context.request.fetch(target.href, { ...options, maxRedirects: 0 });
        if (response.status() >= 300 && response.status() < 400 && response.headers().location) {
          let redirect;
          try { redirect = new URL(response.headers().location, target); } catch { proof.block('invalid_request_origin'); }
          if (!allowed.has(redirect.origin) || redirect.username || redirect.password) proof.block('invalid_request_origin');
        }
        return response;
      },
    };
    await use(proof);
  },
});

export const { Given, When, Then, Before, After } = createBdd(test);

import { proofUrlKey } from '../lib/origins.mjs';

const allowedFields = new Set(['meta', 'http', 'headers', 'params', 'body', 'assertions', 'vars', 'docs']);
const verbs = new Set(['get', 'head', 'options', 'post', 'put', 'patch', 'delete']);
const template = /\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g;
const responsePath = /^res\.(?:status|body(?:\.[A-Za-z0-9_$-]+|\[\d+\])*|headers\.[A-Za-z0-9_-]+)$/;
const headerName = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const forbiddenHeaders = /^(?:authorization|cookie|host|content-length|connection|transfer-encoding|upgrade|expect|trailer|te|keep-alive|proxy-.*)$/;

function parseAssertion({ name, value }) {
  if (!responsePath.test(name)) throw new Error('Unsupported assertion subject');
  const [, operator, operand] = /^(\w+)(?:\s+(.+))?$/.exec(value) ?? [];
  if (['isDefined', 'isUndefined', 'isNull'].includes(operator) && operand === undefined) {
    return { name, operator };
  }
  if (!['eq', 'neq', 'length'].includes(operator) || operand === undefined) throw new Error('Unsupported assertion');
  let expected;
  try { expected = JSON.parse(operand); } catch { expected = operand; }
  if (expected !== null && typeof expected === 'object') throw new Error('Unsupported assertion operand');
  return { name, operator, expected };
}

export function parseRequest(parse, source, expectAuthRejection = false) {
  const bru = parse(source);
  if (Object.keys(bru).some(key => !allowedFields.has(key)) || Object.keys(bru.vars ?? {}).some(key => key !== 'res')) {
    throw new Error('Only declarative Bruno request blocks are supported');
  }
  const sequence = Number(bru.meta?.seq);
  const { method, url, body: bodyType, auth } = bru.http ?? {};
  if (bru.meta?.type !== 'http' || !bru.meta.name || !/^[1-9]\d*$/.test(bru.meta.seq) || !Number.isSafeInteger(sequence) ||
      !verbs.has(method) || !['none', 'json', 'text'].includes(bodyType) || auth !== 'none') {
    throw new Error('Unsupported HTTP request metadata');
  }
  const [, originKey, path] = /^\{\{(\w+)\}\}(\/(?!\/)[^#\\\s]*)$/.exec(url) ?? [];
  if (!originKey || !proofUrlKey.test(originKey)) throw new Error('Use a runtime URL origin followed by a path');

  const headers = new Map();
  for (const { name, value, enabled } of bru.headers ?? []) {
    if (!enabled) continue;
    const key = name.toLowerCase();
    if (!headerName.test(key) || forbiddenHeaders.test(key) || headers.has(key)) throw new Error('Unsupported request header');
    headers.set(key, value);
  }
  const query = (bru.params ?? []).filter(({ enabled }) => enabled);
  if (query.some(({ type }) => type !== 'query')) throw new Error('Only query params are supported');

  if (Object.keys(bru.body ?? {}).length !== (bodyType === 'none' ? 0 : 1)) throw new Error('Invalid body block');
  const content = bru.body?.[bodyType];
  if (bodyType !== 'none' && (typeof content !== 'string' || ['get', 'head'].includes(method))) {
    throw new Error('Body does not match request declaration');
  }
  const body = bodyType === 'json' ? JSON.parse(content) : content;
  const assertions = (bru.assertions ?? []).filter(({ enabled }) => enabled).map(parseAssertion);
  if (!assertions.length) throw new Error('A proof needs an enabled assertion');

  const captures = (bru.vars?.res ?? []).filter(({ enabled }) => enabled);
  if (captures.some(({ name, value, local }) => local || !/^[A-Za-z][\w]*$/.test(name) ||
      name.startsWith('PROOF_') || name === 'runId' ||
      !value.startsWith('res.body.') || !responsePath.test(value)) ||
      new Set(captures.map(({ name }) => name)).size !== captures.length) {
    throw new Error('Unsupported response variable');
  }
  const first = assertions[0];
  const exactStatus = first.name === 'res.status' && first.operator === 'eq' && Number.isInteger(first.expected) &&
    first.expected >= 200 && first.expected <= 599 ? first.expected : undefined;
  const subjects = [...assertions.map(({ name }) => name), ...captures.map(({ value }) => value)];
  const needsBody = subjects.some(subject => subject.startsWith('res.body'));
  const needsObject = subjects.some(subject => subject.startsWith('res.body.'));
  const needsArray = subjects.some(subject => subject.startsWith('res.body['));
  if (needsObject && needsArray) throw new Error('Conflicting response body shapes');
  if (needsBody && exactStatus === undefined) throw new Error('Body checks require a first exact status assertion');
  if (expectAuthRejection && exactStatus !== 401 && exactStatus !== 403) throw new Error('Expected auth rejection requires a first exact 401 or 403 assertion');
  return {
    sequence, method: method.toUpperCase(), originKey, path, headers, query, bodyType, body, assertions, captures,
    bodyStatus: needsBody ? exactStatus : undefined,
    bodyShape: needsObject ? 'object' : needsArray ? 'array' : undefined,
    label: /^[A-Za-z][A-Za-z -]{0,79}$/.test(bru.meta.name) ? bru.meta.name : undefined,
  };
}

function interpolate(value, vars, encode = v => v, preserveType = false) {
  if (/\{\{|\}\}/.test(value.replace(template, ''))) throw new Error('Invalid placeholder');
  const read = key => {
    if (!vars.has(key) || vars.get(key) === undefined) {
      throw new Error('Missing or unsupported variable');
    }
    return vars.get(key);
  };
  const exact = /^\{\{\s*([A-Za-z_][\w.]*)\s*\}\}$/.exec(value);
  if (preserveType && exact) return read(exact[1]);
  return value.replace(template, (_match, key) => encode(String(read(key))));
}

function interpolateJson(value, vars) {
  if (typeof value === 'string') return interpolate(value, vars, undefined, true);
  if (Array.isArray(value)) return value.map(item => interpolateJson(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateJson(item, vars)]));
  }
  return value;
}

export function prepare(request, origins, vars, authHeaders) {
  const origin = origins[request.originKey];
  if (!origin) throw new Error('Missing origin');
  const url = new URL(interpolate(request.path, vars, encodeURIComponent), origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('Request changed its origin');
  for (const { name, value } of request.query) url.searchParams.append(name, interpolate(value, vars));
  const headers = { ...Object.fromEntries([...request.headers].map(([key, value]) => [key, interpolate(value, vars)])), ...authHeaders };
  let body;
  if (request.bodyType === 'json') {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(interpolateJson(request.body, vars));
  } else if (request.bodyType === 'text') {
    headers['content-type'] ??= 'text/plain';
    body = interpolate(request.body, vars);
  }
  const assertions = request.assertions.map(assertion => ({
    ...assertion,
    expected: typeof assertion.expected === 'string' ? interpolate(assertion.expected, vars, undefined, true) : assertion.expected,
  }));
  return { url, method: request.method, headers, body, assertions };
}

export function responseValue(response, path) {
  const keys = path.slice(4).replace(/\[(\d+)\]/g, '.$1').split('.');
  if (keys[0] === 'headers') keys[1] = keys[1].toLowerCase();
  return keys.reduce((value, key) => value != null && Object.hasOwn(value, key) ? value[key] : undefined, response);
}

export function check(response, { name, operator, expected }) {
  const value = responseValue(response, name);
  switch (operator) {
    case 'isDefined': return value !== undefined;
    case 'isUndefined': return value === undefined;
    case 'isNull': return value === null;
    case 'eq': return value !== undefined && value === expected;
    case 'neq': return value !== undefined && value !== expected;
    case 'length': return (Array.isArray(value) || typeof value === 'string') && value.length === expected;
  }
}

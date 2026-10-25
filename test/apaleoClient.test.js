// Retry policy of apaleoRequest, with a mocked global fetch (no network).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.APALEO_CLIENT_ID = 'test-id';
process.env.APALEO_CLIENT_SECRET = 'test-secret';
process.env.LOG_LEVEL = 'error';

const { apaleoRequest, ApaleoError } = await import('../src/apaleoClient.js');

const realFetch = globalThis.fetch;
let calls;
let tokenCounter = 0;

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Queue of responses; token requests always succeed unless a token entry is queued. */
function mockFetch(script) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method || 'GET', auth: init?.headers?.Authorization });
    if (u.endsWith('/connect/token')) {
      tokenCounter += 1;
      return jsonResponse(200, { access_token: `tok-${tokenCounter}`, expires_in: 3600, scope: 'x' });
    }
    const next = script.shift();
    if (!next) throw new Error('no scripted response left');
    if (next instanceof Error) throw next;
    return next;
  };
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('400 is surfaced as ApaleoError without retry', async () => {
  mockFetch([jsonResponse(400, { messages: ['Arrival must be before departure'] })]);
  await assert.rejects(apaleoRequest('GET', '/booking/v1/offers'), (err) => {
    assert.ok(err instanceof ApaleoError);
    assert.equal(err.status, 400);
    assert.equal(err.message, 'Arrival must be before departure');
    return true;
  });
  assert.equal(calls.filter((c) => !c.url.endsWith('/connect/token')).length, 1);
});

test('401 refreshes the token once and retries once', async () => {
  mockFetch([jsonResponse(401, {}), jsonResponse(200, { ok: true })]);
  const result = await apaleoRequest('GET', '/inventory/v1/properties');
  assert.deepEqual(result, { ok: true });
  const api = calls.filter((c) => !c.url.endsWith('/connect/token'));
  assert.equal(api.length, 2);
  assert.notEqual(api[0].auth, api[1].auth, 'second attempt uses a fresh token');
});

test('429 waits for Retry-After then retries', async () => {
  mockFetch([jsonResponse(429, {}, { 'retry-after': '0' }), jsonResponse(200, { ok: 1 })]);
  const result = await apaleoRequest('GET', '/booking/v1/offers');
  assert.deepEqual(result, { ok: 1 });
  assert.equal(calls.filter((c) => !c.url.endsWith('/connect/token')).length, 2);
});

test('5xx is retried a limited number of times then surfaced', async () => {
  process.env.APALEO_TIMEOUT_MS = '15000';
  mockFetch([jsonResponse(503, 'down'), jsonResponse(503, 'down'), jsonResponse(503, 'down'), jsonResponse(503, 'down'), jsonResponse(200, {})]);
  await assert.rejects(apaleoRequest('GET', '/booking/v1/offers'), (err) => {
    assert.ok(err instanceof ApaleoError);
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(calls.filter((c) => !c.url.endsWith('/connect/token')).length, 4, '1 attempt + 3 retries');
});

test('network error is retried then surfaced as ApaleoError', async () => {
  mockFetch([new TypeError('fetch failed'), jsonResponse(201, { id: 'ABC' })]);
  const result = await apaleoRequest('POST', '/booking/v1/bookings', { body: { a: 1 }, headers: { 'Idempotency-Key': 'k' } });
  assert.deepEqual(result, { id: 'ABC' });
});

test('204 returns null', async () => {
  mockFetch([new Response(null, { status: 204 })]);
  assert.equal(await apaleoRequest('PUT', '/booking/v1/reservation-actions/X/assign-unit/Y'), null);
});

// Apaleo REST client: OAuth2 client-credentials with token cache, retries, logging.
//
// Error policy (see README):
//   400/422 -> ApaleoError, no retry (caller shows the message to the user)
//   401     -> refresh token once, retry once
//   429     -> wait (Retry-After or exponential backoff), retry up to MAX_RETRIES
//   5xx     -> exponential backoff, retry up to MAX_RETRIES
import { config } from './config.js';
import { log } from './logger.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = Number(process.env.APALEO_TIMEOUT_MS) || 15_000;

// Timeouts are treated like network errors (retried), so a hung connection
// cannot block a booking attempt forever.
const withTimeout = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS);

export class ApaleoError extends Error {
  constructor(message, { status, code, details, method, path } = {}) {
    super(message);
    this.name = 'ApaleoError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.method = method;
    this.path = path;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------
let cachedToken = null; // { value, expiresAt }
let inflightTokenRequest = null;

async function requestToken() {
  const { clientId, clientSecret, identityUrl } = config.apaleo;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const started = Date.now();
  const res = await fetch(`${identityUrl}/connect/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: withTimeout(),
  });
  const durationMs = Date.now() - started;
  log.info('apaleo.token', { status: res.status, durationMs });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApaleoError(`Token request failed (${res.status})`, {
      status: res.status,
      details: safeJson(text),
      method: 'POST',
      path: '/connect/token',
    });
  }
  const body = await res.json();
  return {
    value: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS,
    scopes: body.scope,
  };
}

async function getToken({ force = false } = {}) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!inflightTokenRequest) {
    inflightTokenRequest = requestToken()
      .then((t) => {
        cachedToken = t;
        return t.value;
      })
      .finally(() => {
        inflightTokenRequest = null;
      });
  }
  return inflightTokenRequest;
}

export function getGrantedScopes() {
  return cachedToken?.scopes || null;
}

// ---------------------------------------------------------------------------
// Generic request
// ---------------------------------------------------------------------------
function buildUrl(path, query) {
  const url = new URL(path, config.apaleo.apiUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, v));
      else url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text || null;
  }
}

function extractMessage(status, details) {
  if (details && typeof details === 'object') {
    if (Array.isArray(details.messages) && details.messages.length) return details.messages.join(' ');
    if (details.message) return details.message;
    if (details.title) return details.title;
  }
  if (typeof details === 'string' && details.trim()) return details.trim().slice(0, 300);
  return `Apaleo request failed with status ${status}`;
}

/**
 * Perform an authenticated request against the Apaleo API.
 * @param {string} method
 * @param {string} path      e.g. '/booking/v1/offers'
 * @param {object} [options] { query, body, headers }
 */
export async function apaleoRequest(method, path, { query, body, headers = {} } = {}) {
  const url = buildUrl(path, query);
  let retriedAuth = false;
  let attempt = 0;

  while (true) {
    const token = await getToken();
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: withTimeout(),
      });
    } catch (networkError) {
      const durationMs = Date.now() - started;
      log.warn('apaleo.request.network_error', { method, path: url.pathname, durationMs, attempt, error: networkError.message });
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new ApaleoError('Network error while contacting Apaleo', { method, path: url.pathname, details: networkError.message });
    }

    const durationMs = Date.now() - started;
    log.info('apaleo.request', { method, path: url.pathname, status: res.status, durationMs, attempt });

    if (res.ok) {
      if (res.status === 204) return null;
      const text = await res.text();
      return text ? safeJson(text) : null;
    }

    const text = await res.text().catch(() => '');
    const details = safeJson(text);

    // 401: refresh token once
    if (res.status === 401 && !retriedAuth) {
      retriedAuth = true;
      cachedToken = null;
      await getToken({ force: true });
      continue;
    }

    // 429: respect Retry-After, else backoff
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * 2 ** attempt;
      log.warn('apaleo.request.rate_limited', { method, path: url.pathname, delayMs: delay, attempt });
      await sleep(delay);
      attempt += 1;
      continue;
    }

    // 5xx: limited retry
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      const delay = BASE_DELAY_MS * 2 ** attempt;
      log.warn('apaleo.request.server_error', { method, path: url.pathname, status: res.status, delayMs: delay, attempt });
      await sleep(delay);
      attempt += 1;
      continue;
    }

    // 4xx (incl. 400/403/404/409/422) and exhausted retries: surface a clear error
    throw new ApaleoError(extractMessage(res.status, details), {
      status: res.status,
      details,
      method,
      path: url.pathname,
    });
  }
}

export const apaleo = {
  get: (path, query) => apaleoRequest('GET', path, { query }),
  post: (path, body, { headers, query } = {}) => apaleoRequest('POST', path, { body, headers, query }),
  put: (path, body, { headers, query } = {}) => apaleoRequest('PUT', path, { body, headers, query }),
  patch: (path, body, { headers, query } = {}) =>
    apaleoRequest('PATCH', path, { body, query, headers: { 'Content-Type': 'application/json-patch+json', ...headers } }),
};

// ---------------------------------------------------------------------------
// Thin endpoint wrappers (paths verified against api.apaleo.com swagger)
// ---------------------------------------------------------------------------

/** GET /inventory/v1/properties */
export const listProperties = () => apaleo.get('/inventory/v1/properties', { pageSize: 100 });

/** GET /booking/v1/offers  (scope offers.read) */
export const listOffers = ({ propertyId, arrival, departure, adults, channelCode = 'Direct', childrenAges }) =>
  apaleo.get('/booking/v1/offers', { propertyId, arrival, departure, adults, channelCode, childrenAges });

/** POST /booking/v1/bookings with Idempotency-Key  (scope reservations.create) */
export const createBooking = (body, idempotencyKey) =>
  apaleo.post('/booking/v1/bookings', body, { headers: { 'Idempotency-Key': idempotencyKey } });

/** GET /booking/v1/bookings/{id} */
export const getBooking = (id) => apaleo.get(`/booking/v1/bookings/${encodeURIComponent(id)}`);

/** GET /booking/v1/reservations  (scope reservations.read) */
export const listReservations = (query) => apaleo.get('/booking/v1/reservations', { pageSize: 100, ...query });

/** GET /booking/v1/reservations/{id} */
export const getReservation = (id, expand) =>
  apaleo.get(`/booking/v1/reservations/${encodeURIComponent(id)}`, { expand });

/** GET /availability/v1/reservations/{id}/units  (scope availability.read) */
export const listAvailableUnitsForReservation = (id, query = {}) =>
  apaleo.get(`/availability/v1/reservations/${encodeURIComponent(id)}/units`, { pageSize: 100, ...query });

/** PUT /booking/v1/reservation-actions/{id}/assign-unit/{unitId}  (scope reservations.assign-unit) */
export const assignUnit = (reservationId, unitId) =>
  apaleo.put(`/booking/v1/reservation-actions/${encodeURIComponent(reservationId)}/assign-unit/${encodeURIComponent(unitId)}`);

/** GET /inventory/v1/units  (scope units.read) */
export const listUnits = (query) => apaleo.get('/inventory/v1/units', { pageSize: 200, ...query });

/** GET /inventory/v1/unit-attributes  (scope unitattributes.read) */
export const listUnitAttributes = () => apaleo.get('/inventory/v1/unit-attributes', { pageSize: 200 });

/** PATCH /inventory/v1/units/{id}  (scope units.manage) — JSON Patch */
export const patchUnit = (id, operations) => apaleo.patch(`/inventory/v1/units/${encodeURIComponent(id)}`, operations);

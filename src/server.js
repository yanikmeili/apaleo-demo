// Express server: serves the booking page and exposes a small JSON API.
// The Apaleo secret never leaves this process; the browser only talks to /api/*.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './logger.js';
import { ApaleoError } from './apaleoClient.js';
import { searchOffers, createReservation, getConfirmation, ValidationError } from './bookingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(publicDir, { extensions: ['html'] }));

// Request log (no body, no personal data)
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => log.info('http', { method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started }));
  next();
});

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/api/health', (req, res) => res.json({ ok: true, propertyId: config.apaleo.propertyId }));

app.get(
  '/api/offers',
  wrap(async (req, res) => {
    const result = await searchOffers(req.query);
    res.json(result);
  }),
);

app.post(
  '/api/bookings',
  wrap(async (req, res) => {
    const result = await createReservation(req.body, req.get('Idempotency-Key'));
    res.status(201).json(result);
  }),
);

app.get(
  '/api/bookings/:id',
  wrap(async (req, res) => {
    const result = await getConfirmation(req.params.id);
    res.json(result);
  }),
);

app.get('/confirmation', (req, res) => res.sendFile(path.join(publicDir, 'confirmation.html')));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Error mapping: validation -> 400, Apaleo 4xx -> same status with the message, others -> 502/500.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message, field: err.field });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err instanceof ApaleoError) {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
    log.error('apaleo.error', { status: err.status, method: err.method, path: err.path, message: err.message });
    return res.status(status).json({ error: err.message, apaleoStatus: err.status ?? null, details: err.details ?? null });
  }
  log.error('unhandled', { message: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  log.info('server.listening', { port: config.port, propertyId: config.apaleo.propertyId });
  console.log(`\nBooking page: http://localhost:${config.port}/\n`);
});

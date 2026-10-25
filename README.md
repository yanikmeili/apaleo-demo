# apaleo-demo

Mini booking engine on the Apaleo API (phase 1) and a room-allocation agent (phase 2).
Property used: **PAR (Hotel Paris)**, test account.

## Run

```bash
npm install
cp .env.example .env   # fill APALEO_CLIENT_ID / APALEO_CLIENT_SECRET
npm run check          # token + list properties + one offer search
npm start              # http://localhost:3000
```

`npm run dev` restarts on file changes. `npm test` runs the unit tests (no network).

## Phase 2: room allocation agent

```bash
npm run tag-units -- --apply          # one-off: attribute scheme for the 51 PAR units
npm run seed -- --apply [--date D]    # test set: 12 reservations with the brief's comments (default: tomorrow)
npm run agent -- --show-input         # what the model receives (no model call)
npm run agent [-- --date D]           # dry-run: proposals + report, nothing written
npm run agent:apply                   # assign the validated proposals in Apaleo
```

Flow: arrivals of the day without a unit (`GET /booking/v1/reservations?dateFilter=Arrival&status=Confirmed`)
→ free units per reservation with attributes (`GET /availability/v1/reservations/{id}/units?unitGroupId=`)
→ one model call (strict JSON schema via `output_config.format`) → backend validation (unit is a candidate,
same category, not used twice) → `PUT /booking/v1/reservation-actions/{id}/assign-unit/{unitId}` only with `--apply`.
Reports land in `reports/allocation-<date>-<mode>.md` (gitignored). The model never sees guest names or emails.

Guardrails: dry-run by default; the model can only pick from the candidate list; ambiguous comments are left
unassigned with `needsHumanReview`; unmet requests get the closest room plus a review flag; the agent never
touches dates, category, price, payment or cancellation.

Unit attributes (set by `tag-units`): floor, Garden/Street view, Quiet, Near elevator, Accessible, Connecting,
Corner, King, Bath, Private pool. Adjacent rooms = consecutive numbers on the same floor.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `APALEO_CLIENT_ID` | yes | | OAuth2 client (simple client, client credentials) |
| `APALEO_CLIENT_SECRET` | yes | | Never logged, never sent to the browser |
| `APALEO_PROPERTY_ID` | no | `PAR` | Property searched and booked |
| `APALEO_IDENTITY_URL` | no | `https://identity.apaleo.com` | Token endpoint host |
| `APALEO_API_URL` | no | `https://api.apaleo.com` | API host |
| `PORT` | no | `3000` | HTTP port |
| `ANTHROPIC_API_KEY` | phase 2 | | Allocation agent |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | Model used by the agent |

`dotenv` does not override variables already set in the shell. If your shell exports an
outdated `APALEO_CLIENT_SECRET`, run `env -u APALEO_CLIENT_SECRET npm start`.

## Flow

```
Browser (public/)            Backend (src/)                      Apaleo
──────────────────           ─────────────────────────           ─────────────────────────────
dates + adults  ──GET /api/offers──▶ bookingService.searchOffers ──▶ GET /booking/v1/offers
                ◀── categories[rates] ◀── group by unit group    ◀── offers (price, availability, policy)

guest + comment ──POST /api/bookings──▶ createReservation       ──▶ POST /booking/v1/bookings
  Idempotency-Key header       validation, payload build            (Idempotency-Key forwarded)
                ◀── {bookingId, reservationId}                   ◀── 201 {id, reservationIds}

/confirmation   ──GET /api/bookings/:id──▶ getConfirmation       ──▶ GET /booking/v1/bookings/{id}
                                                                 ──▶ GET /booking/v1/reservations?bookingId=
                                                                 ──▶ GET /booking/v1/reservations/{id}
```

## Modules

- `src/apaleoClient.js`: OAuth2 client-credentials with token cache, retry policy
  (401 refresh once, 429 Retry-After/backoff, 5xx limited retry, 4xx surfaced as `ApaleoError`),
  structured request logging without secrets, thin endpoint wrappers.
- `src/bookingService.js`: validation (dates, adults, email), offer grouping, booking payload,
  confirmation shaping.
- `src/server.js`: Express, static page, `/api/*` routes, error mapping (400 validation,
  Apaleo 4xx passthrough, 502 upstream).
- `public/`: booking page (`index.html`, `app.js`) and confirmation page.
- `src/allocationAgent.js`: phase 2 pipeline (load, prompt, validate, apply, report).
- `scripts/`: `check-connection`, `tag-units`, `seed-reservations`, `run-agent`.

## Idempotence

The page generates one UUID per booking attempt (new rate selection = new key) and sends it as
`Idempotency-Key`; the backend forwards it to Apaleo. A retry with the same key returns the same
booking instead of creating a second one. The "Réserver" button is disabled during the attempt.

## Endpoints verified against api.apaleo.com

| Purpose | Endpoint |
|---|---|
| Token | `POST https://identity.apaleo.com/connect/token` (Basic auth, `grant_type=client_credentials`) |
| Properties | `GET /inventory/v1/properties` |
| Offers | `GET /booking/v1/offers?propertyId&arrival&departure&adults&channelCode=Direct` |
| Create booking | `POST /booking/v1/bookings` with `Idempotency-Key` |
| Booking | `GET /booking/v1/bookings/{id}` (booker only, no reservations) |
| Reservations | `GET /booking/v1/reservations?bookingId=`, `GET /booking/v1/reservations/{id}` |
| Phase 2 | `GET /availability/v1/reservations/{id}/units`, `PUT /booking/v1/reservation-actions/{id}/assign-unit/{unitId}`, `GET /inventory/v1/units`, `GET /inventory/v1/unit-attributes` |

Notes from the sandbox: FLEX/IBRKF accept `guaranteeType: CreditCard` without any payment account;
the booking is created as `Confirmed`. The token response reports scope `identity:permissions`
only, yet booking read/write calls succeed with this simple client.

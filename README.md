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

## Hotel simulator (phase 3)

Fills a property with a realistic 21-day booking curve so a demo opens on a hotel that looks
run-in rather than empty.

```bash
npm run provision -- --from PAR --to DEMO   # one-off: clone a disposable property
APALEO_PROPERTY_ID=DEMO npm run simulate -- --dry-run
APALEO_PROPERTY_ID=DEMO npm run simulate
APALEO_PROPERTY_ID=DEMO npm run simulate:clean
```

Flags: `--scale 0.5` (volume), `--delay 600` (ms between calls), `--seed`, `--no-backdating`
(preview the fallback shape), `--dry-run`. `simulate:clean` also takes `--reset`.

Occupancy follows 85% on D+0..D+2 declining linearly to 40% on D+21, split across unit groups in
proportion to the real room count, with 1-5 night stays, a rate mix, ~10% guest comments and ~5%
cancellations. `src/simulation/plan.js` is pure and deterministic for a given seed, so `--dry-run`
shows exactly what the real run writes.

### Marking and cleanup

Every reservation carries `externalCode = "SIMULATION-ENTRETIEN-<runId>-<seq>"`; charges and
payments carry the same prefix in `receipt`. `GET /booking/v1/reservations?externalCode=` matches
on prefix, which is what `simulate:clean` targets. It refuses to write if anything without the
marker appears in its filter, and never touches unmarked reservations.

Apaleo has **no DELETE for reservations**. Cleanup cancels what is cancellable (Confirmed with a
future arrival) and checks out anything still InHouse — shortening the stay first where needed,
since check-out requires a departure no later than tomorrow. Checked-out reservations remain
visible forever but hold no room. This is why the simulator should target a disposable property.

### Sandbox constraints found the hard way

These are enforced by the API but absent or wrong in the swagger, and each one cost a failed run:

| Constraint | Symptom |
|---|---|
| Arrival dates cannot be backdated | `Cannot set the arrival date to yesterday after check-out time` — the simulator probes this once and falls back to same-day arrivals |
| Check-out needs departure ≤ tomorrow | documented; departures are staged as one-night stays |
| Cancel needs a future arrival | today's arrivals can never be cancelled, only checked out |
| `rateplan.code` is `^[a-zA-Z0-9_]*$`, 3-20 chars | a hyphen is rejected, hence `SIMULATION_ENTRETIEN` for the code while the display name keeps `SIMULATION-ENTRETIEN` |
| `accountingConfigs` is required | `You should specify the AccountingConfigs` although swagger omits it from `required` |
| Custom sub-accounts are disabled | `Custom accounts are disabled` when cloning a base plan's `subAccountId` |
| Surcharges required per occupancy | `Surcharges are missing for adults: 2, 3, 4` for a 4-person unit group |
| Supported languages are en/de/it, en+de mandatory | `Description has unsupported translations` on `fr` |
| Restrictions are inherited down the pricing chain | a derived plan with empty `restrictions` still fails with `The restrictions of the rate plan are not considered` |
| Unsettled folios report a **negative** balance | pay `Math.abs(balance)`, not `balance` |
| Creating an invoice closes the folio | a following `close` returns 422, which is not a failure |
| Invoice debitor needs a full address | set it on the folio with PATCH rather than relying on it propagating from the guest |
| `cancelInvoice` needs a body | 415 without `{ reasonCode }` |
| Assigning a unit after check-in time auto-checks-in | the explicit check-in then returns 422, so the reservation's **status** is the only reliable signal |

### Cloning a disposable property

`CloneProperty` copies unit groups, rate plans, services and policies — but **not units** and
**not rate prices**. `npm run provision` fills both gaps, and flips the source property's
`isTemplate` flag around the call (a property that is not a template cannot be cloned) before
restoring it. Unit attribute definitions are account-level, so attribute ids carry across and the
recreated units keep their tags without re-running `tag-units`.

`simulate:clean --reset` wipes all transactional data in one call, but needs the
`core.properties.reset` permission, which this client does not have; it reports that and points at
the normal cleanup. The reset path also refuses any property holding unmarked reservations, since
it cannot tell simulated data from real.

## Demo mornings

```bash
npm run demo:up      # server + HTTPS tunnel + repoint the Apaleo tab, in one go
npm run demo:down    # stop both
```

`demo:up` downloads `cloudflared` into `bin/` on first use, starts the server, opens a
Cloudflare quick tunnel, waits until the page actually answers through it, and then
rewrites the UI integration's `sourceUrl`. A quick tunnel gets a **new hostname every
time it starts**, so that last step is not optional — without it the Apaleo tab points
at a dead address. It prints the write password at the end.

The Apaleo tab is deliberately left declared by `demo:down`: removing it would make the
app vanish from the account menu, and the next `demo:up` repoints it anyway.

### Who may write

Write actions (Remplir, Nettoyer, Appliquer) are guarded two ways:

- **A shared password**, `OPS_WRITE_PASSWORD` in `.env`, sent as `x-ops-password`. Writes
  are refused outright when it is unset, and the page says so. It is asked for once per
  browser tab and kept in `sessionStorage`, so it does not survive the tab.
- **The account code.** Apaleo appends `accountCode` to the embedded page's URL; the page
  forwards it and the server compares it with its own account. A mismatch is refused.

The account check is what Apaleo's guide asks for — it catches a page embedded under the
wrong account — but a browser can omit or forge the header, so the password is the real
gate. **Read endpoints are deliberately open**: anyone holding the tunnel URL can list
properties, see the dry-run plan and read the allocation proposals, guest comments
included. Close those too if the tunnel URL is ever shared beyond the team.

Writes are additionally restricted to properties Apaleo reports as `Test`, never to the
ones listed in `OPS_DENY_PROPERTIES` (default `PAR`).

### Regenerating the data

```bash
npm run demo:fresh -- --apply     # clean, refill, stage the allocation day (~8 min)
npm run demo:up                   # then server + tunnel + Apaleo tab
```

**Run it on the morning of the demo, not the night before.** The simulator builds its
occupancy curve around the day it runs: today's arrivals, today's departures, the guests
currently in house. Data made on a Friday still says Friday, so by Tuesday a third of the
in-house guests are past their departure date and the planning looks broken.

"From scratch" is as clean as Apaleo allows. The account has no `core.properties.reset`
permission, and a reservation can never be deleted — only cancelled, and only while its
arrival is still in the future. So `demo:fresh` cancels everything marked, checks the
remaining guests out with their folios settled, and builds again. Cancelled and
checked-out records stay visible in reports but hold no room.

It refuses to run against `PAR`.

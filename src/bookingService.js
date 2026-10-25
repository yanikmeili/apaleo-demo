// Booking service: validation, offer search shaping, reservation creation.
// Apaleo is the source of truth; this module only shapes requests/responses.
import { config } from './config.js';
import { listOffers, createBooking, getBooking, getReservation, listReservations } from './apaleoClient.js';

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseDate(value, field) {
  if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a date in YYYY-MM-DD format`, field);
  }
  return value;
}

export function nightsBetween(arrival, departure) {
  return Math.round((Date.parse(departure) - Date.parse(arrival)) / 86_400_000);
}

export function validateStay({ arrival, departure, adults }) {
  arrival = parseDate(arrival, 'arrival');
  departure = parseDate(departure, 'departure');
  if (arrival < todayIso()) throw new ValidationError('Arrival date cannot be in the past', 'arrival');
  if (departure <= arrival) throw new ValidationError('Departure must be after arrival', 'departure');
  const nights = nightsBetween(arrival, departure);
  if (nights > 30) throw new ValidationError('Stays longer than 30 nights are not supported', 'departure');
  const adultsNum = Number(adults);
  if (!Number.isInteger(adultsNum) || adultsNum < 1 || adultsNum > 8) {
    throw new ValidationError('Adults must be a whole number between 1 and 8', 'adults');
  }
  return { arrival, departure, adults: adultsNum, nights };
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------
function includesBreakfast(offer) {
  const names = [];
  for (const s of offer.services || []) names.push(s.service?.name, s.service?.code);
  for (const ts of offer.timeSlices || []) {
    for (const s of ts.includedServices || []) names.push(s.service?.name, s.service?.code, s.serviceId);
  }
  return names.filter(Boolean).some((n) => /breakfast|bkf|petit/i.test(String(n)));
}

/** Search offers and group them by unit group (room category). */
export async function searchOffers(params) {
  const stay = validateStay(params);
  const raw = await listOffers({
    propertyId: config.apaleo.propertyId,
    arrival: stay.arrival,
    departure: stay.departure,
    adults: stay.adults,
    channelCode: config.apaleo.channelCode,
  });

  const groups = new Map();
  for (const o of raw?.offers || []) {
    if (!o.availableUnits || o.availableUnits < 1) continue;
    const ug = o.unitGroup;
    if (!groups.has(ug.id)) {
      groups.set(ug.id, {
        unitGroupId: ug.id,
        code: ug.code,
        name: ug.name,
        description: ug.description,
        maxPersons: ug.maxPersons,
        rates: [],
      });
    }
    groups.get(ug.id).rates.push({
      ratePlanId: o.ratePlan.id,
      ratePlanCode: o.ratePlan.code,
      ratePlanName: o.ratePlan.name,
      description: o.ratePlan.description,
      totalGrossAmount: o.totalGrossAmount.amount,
      currency: o.totalGrossAmount.currency,
      availableUnits: o.availableUnits,
      minGuaranteeType: o.minGuaranteeType,
      cancellation: o.cancellationFee ? { code: o.cancellationFee.code, name: o.cancellationFee.name, description: o.cancellationFee.description } : null,
      breakfastIncluded: includesBreakfast(o),
      timeSliceCount: (o.timeSlices || []).length,
    });
  }

  const categories = [...groups.values()]
    .map((g) => ({ ...g, rates: g.rates.sort((a, b) => a.totalGrossAmount - b.totalGrossAmount) }))
    .sort((a, b) => a.rates[0].totalGrossAmount - b.rates[0].totalGrossAmount);

  return { propertyId: config.apaleo.propertyId, ...stay, categories };
}

// ---------------------------------------------------------------------------
// Booking creation
// ---------------------------------------------------------------------------
function cleanText(value, field, { required = false, max = 100 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new ValidationError(`${field} is required`, field);
  if (text.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  return text;
}

export function validateBookingRequest(body) {
  const stay = validateStay(body);
  const ratePlanId = cleanText(body.ratePlanId, 'ratePlanId', { required: true, max: 60 });
  const firstName = cleanText(body.firstName, 'firstName', { required: true, max: 80 });
  const lastName = cleanText(body.lastName, 'lastName', { required: true, max: 80 });
  const email = cleanText(body.email, 'email', { required: true, max: 120 });
  if (!EMAIL.test(email)) throw new ValidationError('Email address is not valid', 'email');
  const comment = cleanText(body.comment, 'comment', { max: 1000 });
  const guaranteeType = cleanText(body.guaranteeType, 'guaranteeType', { max: 30 }) || undefined;
  return { ...stay, ratePlanId, firstName, lastName, email, comment, guaranteeType };
}

/**
 * Create a booking with one reservation in Apaleo.
 * `idempotencyKey` is generated by the client per attempt so that a retry after a
 * network failure does not create a second reservation.
 */
export async function createReservation(body, idempotencyKey) {
  const req = validateBookingRequest(body);
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 100) {
    throw new ValidationError('Missing or invalid Idempotency-Key header', 'idempotencyKey');
  }

  const guest = { firstName: req.firstName, lastName: req.lastName, email: req.email };
  const payload = {
    booker: guest,
    reservations: [
      {
        arrival: req.arrival,
        departure: req.departure,
        adults: req.adults,
        channelCode: config.apaleo.channelCode,
        primaryGuest: guest,
        ...(req.guaranteeType ? { guaranteeType: req.guaranteeType } : {}),
        ...(req.comment ? { guestComment: req.comment } : {}),
        timeSlices: Array.from({ length: req.nights }, () => ({ ratePlanId: req.ratePlanId })),
      },
    ],
  };

  const created = await createBooking(payload, idempotencyKey);
  const reservationId = created?.reservationIds?.[0]?.id ?? null;
  return { bookingId: created?.id ?? null, reservationId };
}

/** Confirmation details: booking + first reservation, trimmed for display (no payment data). */
export async function getConfirmation(bookingId) {
  const id = cleanText(bookingId, 'bookingId', { required: true, max: 40 });
  // GET /bookings/{id} returns booker + metadata only; reservations are listed separately.
  const [booking, list] = await Promise.all([getBooking(id), listReservations({ bookingId: id })]);
  const first = list?.reservations?.[0];
  const reservation = first?.id ? await getReservation(first.id) : null;
  return {
    bookingId: booking.id,
    booker: booking.booker ? { firstName: booking.booker.firstName, lastName: booking.booker.lastName, email: booking.booker.email } : null,
    reservation: reservation
      ? {
          id: reservation.id,
          status: reservation.status,
          arrival: reservation.arrival,
          departure: reservation.departure,
          adults: reservation.adults,
          unitGroup: reservation.unitGroup?.name,
          ratePlan: reservation.ratePlan?.name,
          ratePlanCode: reservation.ratePlan?.code,
          totalGrossAmount: reservation.totalGrossAmount,
          guaranteeType: reservation.guaranteeType,
          cancellationFee: reservation.cancellationFee?.name,
          guestComment: reservation.guestComment ?? '',
          unit: reservation.unit?.name ?? null,
          property: reservation.property?.name,
        }
      : null,
  };
}

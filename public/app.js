// Booking page logic. Talks only to our own backend (/api/*); never to Apaleo directly.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const searchForm = $('#search');
  const searchBtn = $('#search-btn');
  const searchAlert = $('#search-alert');
  const offersSection = $('#offers');
  const offersList = $('#offers-list');
  const offersMeta = $('#offers-meta');
  const guestSection = $('#guest');
  const selectionBox = $('#selection');
  const bookForm = $('#book');
  const bookBtn = $('#book-btn');
  const bookAlert = $('#book-alert');

  let stay = null; // { arrival, departure, adults, nights }
  let selected = null; // { category, rate }
  let idempotencyKey = null; // one key per booking attempt

  const fmtMoney = (amount, currency) =>
    new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  const plusDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const showAlert = (el, msg, kind = 'error') => {
    el.innerHTML = msg ? `<div class="alert ${kind}">${escapeHtml(msg)}</div>` : '';
  };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Defaults: FLEX has a 3-day minimum lead time, so start at +5 days.
  searchForm.arrival.value = plusDays(5);
  searchForm.departure.value = plusDays(7);
  searchForm.arrival.min = plusDays(0);
  searchForm.departure.min = plusDays(1);

  function validateStayClient(f) {
    const today = plusDays(0);
    if (!f.arrival.value) return 'Choisissez une date d’arrivée.';
    if (!f.departure.value) return 'Choisissez une date de départ.';
    if (f.arrival.value < today) return 'La date d’arrivée ne peut pas être dans le passé.';
    if (f.departure.value <= f.arrival.value) return 'Le départ doit être après l’arrivée.';
    const adults = Number(f.adults.value);
    if (!Number.isInteger(adults) || adults < 1) return 'Indiquez au moins 1 adulte.';
    return null;
  }

  async function api(path, options = {}) {
    const { headers: extraHeaders, ...rest } = options;
    const res = await fetch(path, { ...rest, headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) } });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no body */
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Erreur ${res.status}`);
      err.status = res.status;
      err.details = data?.details;
      throw err;
    }
    return data;
  }

  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const problem = validateStayClient(searchForm);
    if (problem) return showAlert(searchAlert, problem);
    showAlert(searchAlert, '');
    guestSection.classList.add('hidden');
    selected = null;
    searchBtn.disabled = true;
    searchBtn.textContent = 'Recherche…';
    try {
      const q = new URLSearchParams({ arrival: searchForm.arrival.value, departure: searchForm.departure.value, adults: searchForm.adults.value });
      const data = await api(`/api/offers?${q}`);
      stay = { arrival: data.arrival, departure: data.departure, adults: data.adults, nights: data.nights };
      renderOffers(data);
    } catch (err) {
      offersSection.classList.add('hidden');
      showAlert(searchAlert, err.message);
    } finally {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Voir les chambres';
    }
  });

  function renderOffers(data) {
    offersSection.classList.remove('hidden');
    const n = data.nights;
    offersMeta.textContent = `${fmtDate(data.arrival)} → ${fmtDate(data.departure)} · ${n} nuit${n > 1 ? 's' : ''} · ${data.adults} adulte${data.adults > 1 ? 's' : ''}`;
    if (!data.categories.length) {
      offersList.innerHTML = '<div class="alert info">Aucune chambre disponible pour ces critères. Essayez d’autres dates (certains tarifs demandent 3 jours d’anticipation).</div>';
      return;
    }
    offersList.innerHTML = data.categories
      .map(
        (cat) => `
        <div class="category">
          <h3>${escapeHtml(cat.name)} <span class="muted">· jusqu’à ${cat.maxPersons} pers.</span></h3>
          ${cat.description ? `<p class="muted">${escapeHtml(cat.description)}</p>` : ''}
          <div class="rates">
            ${cat.rates
              .map(
                (r) => `
              <div class="rate" data-cat="${escapeHtml(cat.unitGroupId)}" data-rate="${escapeHtml(r.ratePlanId)}">
                <div>
                  <div class="name">${escapeHtml(r.ratePlanName)} <span class="muted">(${escapeHtml(r.ratePlanCode)})</span></div>
                  <div class="tags">
                    <span class="tag ${/flex/i.test(r.cancellation?.name || '') ? 'ok' : 'warn'}">Annulation : ${escapeHtml(r.cancellation?.name || 'n/c')}</span>
                    ${r.breakfastIncluded ? '<span class="tag ok">Petit-déjeuner inclus</span>' : ''}
                    <span class="tag">Garantie : ${escapeHtml(labelGuarantee(r.minGuaranteeType))}</span>
                    <span class="tag">${r.availableUnits} dispo.</span>
                  </div>
                </div>
                <div>
                  <div class="price">${fmtMoney(r.totalGrossAmount, r.currency)}</div>
                  <div class="muted" style="text-align:right">total ${n} nuit${n > 1 ? 's' : ''}</div>
                  <button type="button" class="secondary choose" style="margin-top:6px;width:100%">Choisir</button>
                </div>
              </div>`,
              )
              .join('')}
          </div>
        </div>`,
      )
      .join('');

    offersList.querySelectorAll('.rate').forEach((el) => {
      el.querySelector('.choose').addEventListener('click', () => {
        const cat = data.categories.find((c) => c.unitGroupId === el.dataset.cat);
        const rate = cat.rates.find((r) => r.ratePlanId === el.dataset.rate);
        select(cat, rate, el);
      });
    });
  }

  function labelGuarantee(type) {
    return { CreditCard: 'carte bancaire', Prepayment: 'prépaiement', PM6Hold: 'option 18h', Company: 'société' }[type] || type || 'aucune';
  }

  function select(category, rate, el) {
    selected = { category, rate };
    idempotencyKey = crypto.randomUUID(); // new attempt → new key
    offersList.querySelectorAll('.rate').forEach((r) => r.classList.toggle('selected', r === el));
    selectionBox.innerHTML = `<strong>${escapeHtml(category.name)}</strong> · ${escapeHtml(rate.ratePlanName)} · ${fmtMoney(rate.totalGrossAmount, rate.currency)} pour ${stay.nights} nuit${stay.nights > 1 ? 's' : ''}`;
    guestSection.classList.remove('hidden');
    showAlert(bookAlert, '');
    bookBtn.disabled = false;
    bookBtn.textContent = 'Réserver';
    guestSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  bookForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected || !stay) return showAlert(bookAlert, 'Choisissez d’abord une chambre.');
    const f = bookForm;
    if (!f.firstName.value.trim() || !f.lastName.value.trim()) return showAlert(bookAlert, 'Prénom et nom sont obligatoires.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.value.trim())) return showAlert(bookAlert, 'Adresse email invalide.');
    showAlert(bookAlert, '');

    // Idempotence: the button is disabled for the whole attempt and the same key is
    // reused if the user retries after a network error.
    bookBtn.disabled = true;
    bookBtn.textContent = 'Réservation en cours…';
    try {
      const result = await api('/api/bookings', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          arrival: stay.arrival,
          departure: stay.departure,
          adults: stay.adults,
          ratePlanId: selected.rate.ratePlanId,
          guaranteeType: selected.rate.minGuaranteeType,
          firstName: f.firstName.value,
          lastName: f.lastName.value,
          email: f.email.value,
          comment: f.comment.value,
        }),
      });
      const q = new URLSearchParams({ bookingId: result.bookingId, reservationId: result.reservationId || '' });
      window.location.assign(`/confirmation?${q}`);
    } catch (err) {
      // 4xx from Apaleo = request problem: new key for the next attempt.
      if (err.status && err.status < 500) idempotencyKey = crypto.randomUUID();
      showAlert(bookAlert, err.message);
      bookBtn.disabled = false;
      bookBtn.textContent = 'Réserver';
    }
  });
})();

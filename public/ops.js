// Apaleo UI integration — front end. Talks only to /api/ops/*; every Apaleo write
// happens server-side, behind the Test-property and marker guards.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

  // Apaleo appends accountCode / subjectId / lang (and propertyId on property targets).
  const qs = new URLSearchParams(location.search);
  const embedded = qs.has('accountCode') || window.self !== window.top;

  // The write password is asked for once and kept for the tab only: sessionStorage
  // dies with the tab, so a shared machine does not hand it to the next person.
  const PW_KEY = 'ops-write-password';
  const readPw = () => { try { return sessionStorage.getItem(PW_KEY) || ''; } catch { return ''; } };
  const savePw = (v) => { try { sessionStorage.setItem(PW_KEY, v); } catch { /* private mode */ } };
  const forgetPw = () => { try { sessionStorage.removeItem(PW_KEY); } catch { /* ignore */ } };

  function askPassword(reason) {
    const given = window.prompt(reason || 'Mot de passe pour écrire dans Apaleo :');
    if (given === null) return null;
    savePw(given.trim());
    return given.trim();
  }

  async function api(path, options = {}) {
    const write = (options.method || 'GET').toUpperCase() !== 'GET';
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (write) {
      let pw = readPw();
      if (!pw) { pw = askPassword(); if (pw === null) throw new Error('Action annulée.'); }
      headers['x-ops-password'] = pw;
      // Apaleo tells the embedded page which account the viewer is signed into.
      const account = qs.get('accountCode');
      if (account) headers['x-ops-account'] = account;
    }
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) {
      if (data?.code === 'bad_password') {
        forgetPw();
        const retry = askPassword('Mot de passe incorrect. Réessayer :');
        if (retry !== null) return api(path, options);
      }
      throw new Error(data?.error || `Erreur ${res.status}`);
    }
    return data;
  }
  const notice = (kind, html) => `<div class="notice ${kind}">${html}</div>`;

  // ── tabs ────────────────────────────────────────────────────────────────
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) {
        const on = t === tab;
        t.setAttribute('aria-selected', String(on));
        $(`#${t.getAttribute('aria-controls')}`).hidden = !on;
      }
    });
  }

  // ── properties ──────────────────────────────────────────────────────────
  let properties = [];
  async function loadProperties() {
    const data = await api('/api/ops/properties');
    properties = data.properties;
    const writable = properties.filter((p) => p.writable);
    const opts = (list, withDisabled) => list.map((p) =>
      `<option value="${esc(p.id)}"${p.writable ? '' : ' disabled'}>${esc(p.id)} — ${esc(p.name)}${p.writable ? '' : ` (${esc(p.deniedReason)})`}</option>`).join('');
    $('#prop').innerHTML = opts(properties, true);
    $('#aprop').innerHTML = opts(properties, true);
    const pre = qs.get('propertyId');
    const chosen = (pre && writable.some((p) => p.id === pre)) ? pre : data.defaultPropertyId;
    if (chosen) { $('#prop').value = chosen; $('#aprop').value = chosen; }
    const blocked = properties.filter((p) => !p.writable);
    $('#prop-note').innerHTML = blocked.length
      ? `Non modifiables : ${blocked.map((p) => `<strong>${esc(p.id)}</strong> (${esc(p.deniedReason)})`).join(', ')}. Le serveur refuse toute écriture sur ces propriétés.`
      : '';
    $('#ctx').textContent = embedded
      ? `Compte ${qs.get('accountCode') || '—'} · ${writable.length} propriété(s) de démonstration`
      : `Mode local · ${writable.length} propriété(s) de démonstration disponibles`;
  }

  // ── tab 1: plan ─────────────────────────────────────────────────────────
  function renderPlan(p) {
    const s = p.summary;
    const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    const curve = s.perDay.map((d) => `
      <span class="d">J+${d.day}</span>
      <span class="bar"><i style="width:${Math.min(100, d.pct)}%"></i><u style="left:${Math.min(100, d.target)}%" title="cible ${d.target}%"></u></span>
      <span class="v">${d.pct}%</span>`).join('');
    return `<div class="card">
      <h2>Plan — ${esc(p.propertyId)} · ${p.totalRooms} chambres</h2>
      ${notice('info', `Simulation à blanc : <strong>rien n’a été écrit</strong> dans Apaleo. ~${p.estimatedCalls} appels, environ ${p.estimatedSeconds}&nbsp;s d’exécution.`)}
      <div class="stats">
        ${stat(s.reservations, 'réservations')}${stat(s.roomNights, 'nuitées')}
        ${stat(s.checkIns, 'check-ins')}${stat(s.departures, 'départs du jour')}
        ${stat(s.departures, 'factures')}${stat(s.charges, 'consommations')}
        ${stat(s.splits, 'folios divisés')}${stat(s.cancellations, 'annulations')}
      </div>
      <h2 style="margin:16px 0 8px">Courbe d’occupation <span class="muted" style="font-weight:400">— trait gris = cible</span></h2>
      <div class="curve">${curve}</div>
    </div>`;
  }

  $('#btn-plan').addEventListener('click', async () => {
    const btn = $('#btn-plan'); btn.disabled = true; btn.textContent = 'Calcul…';
    $('#plan-out').innerHTML = '';
    try {
      const p = await api(`/api/ops/sim/plan?propertyId=${encodeURIComponent($('#prop').value)}&scale=${$('#scale').value}`);
      $('#plan-out').innerHTML = renderPlan(p);
    } catch (e) {
      $('#plan-out').innerHTML = notice('err', esc(e.message));
    } finally { btn.disabled = false; btn.textContent = 'Voir le plan'; }
  });

  // ── tab 1: jobs ─────────────────────────────────────────────────────────
  let polling = null;
  async function runJob(path, body, title) {
    clearInterval(polling);
    const out = $('#job-out');
    out.innerHTML = `<div class="card"><h2>${esc(title)} <span class="spin"></span></h2><div class="logbox" id="joblog">démarrage…</div></div>`;
    let job;
    try {
      job = await api(path, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      out.innerHTML = notice('err', esc(e.message)); return;
    }
    polling = setInterval(async () => {
      let j;
      try { j = await api(`/api/ops/jobs/${job.id}`); } catch { return; }
      const box = $('#joblog');
      if (box) { box.textContent = j.lines.join('\n') || '…'; box.scrollTop = box.scrollHeight; }
      if (j.status === 'running') return;
      clearInterval(polling);
      const head = out.querySelector('h2');
      if (head) head.innerHTML = `${esc(title)} — ${j.status === 'done' ? 'terminé' : 'échec'}`;
      out.insertAdjacentHTML('afterbegin', j.status === 'done'
        ? notice('ok', `<strong>${esc(title)} terminé.</strong> Bilan complet ci-dessous.`)
        : notice('err', `<strong>Échec.</strong> ${esc(j.error || '')}`));
    }, 1500);
  }

  $('#btn-fill').addEventListener('click', () => {
    const id = $('#prop').value;
    const p = properties.find((x) => x.id === id);
    if (!confirm(`Remplir ${id} — ${p?.name ?? ''} ?\n\nCela crée plusieurs centaines de réservations marquées SIMULATION-ENTRETIEN dans Apaleo et prend quelques minutes.`)) return;
    runJob('/api/ops/sim/run', { propertyId: id, scale: $('#scale').value }, `Remplissage de ${id}`);
  });

  $('#btn-clean').addEventListener('click', () => {
    const id = $('#prop').value;
    if (!confirm(`Nettoyer ${id} ?\n\nAnnule les réservations marquées SIMULATION-ENTRETIEN et fait sortir les clients encore en séjour. Les réservations non marquées ne sont jamais touchées.`)) return;
    runJob('/api/ops/sim/clean', { propertyId: id }, `Nettoyage de ${id}`);
  });

  // ── tab 2: allocation ───────────────────────────────────────────────────
  let rows = [];
  let decisions = new Map(); // reservationId -> 'ok' | 'no'

  function applyMode(mode) {
    decisions = new Map();
    for (const r of rows) {
      if (mode === 'auto') decisions.set(r.reservationId, 'ok');
      else if (mode === 'mixed' && !r.needsHumanReview && r.unitId) decisions.set(r.reservationId, 'ok');
    }
  }

  // An Apaleo iframe is auto-sized to its content, so the parent page scrolls and a
  // `position: sticky` bar never sticks. The action bar is therefore repeated above and
  // below the list instead.
  const bar = (where, chosen) => `<div class="apply-bar ${where}">
      <button class="btn-apply primary" ${chosen ? '' : 'disabled'}>Appliquer les validées (${chosen})</button>
      <span class="muted">Seules les lignes validées seront écrites dans Apaleo.</span>
    </div>`;

  function renderRows(data) {
    const chosen = rows.filter((r) => decisions.get(r.reservationId) === 'ok').length;
    const cards = rows.map((r) => {
      const st = decisions.get(r.reservationId);
      return `<div class="prop ${r.needsHumanReview ? 'review' : ''} ${st === 'no' ? 'refused' : ''}" data-id="${esc(r.reservationId)}">
        <div class="prop-head">
          <span class="res">${esc(r.reservationId)}</span>
          <span class="meta">${esc(r.unitGroup || '')} · ${r.adults} pers. · ${esc(fmtDate(r.arrival))} → ${esc(fmtDate(r.departure))}</span>
          ${r.needsHumanReview ? '<span class="badge review">à vérifier</span>' : ''}
        </div>
        ${r.guestComment ? `<p class="quote">« ${esc(r.guestComment)} »</p>` : '<p class="quote muted">Aucune demande particulière.</p>'}
        <div class="unit">${r.unitName ? `Chambre <b>${esc(r.unitName)}</b>` : '<b>Aucune chambre proposée</b>'}
          ${r.unitAttributes?.length ? `<div class="attrs">${esc(r.unitAttributes.join(' · '))}</div>` : ''}
          <div class="reason">${esc(r.reason)}</div>
        </div>
        <div class="prop-actions">
          <button class="pick" aria-pressed="${st === 'ok'}" ${r.unitId ? '' : 'disabled'}>Valider</button>
          <button class="drop" aria-pressed="${st === 'no'}">Refuser</button>
          <span class="state ${st === 'ok' ? 'ok' : st === 'no' ? 'no' : 'muted'}">${st === 'ok' ? 'validée' : st === 'no' ? 'refusée' : `${r.candidateCount} chambres possibles`}</span>
        </div>
      </div>`;
    }).join('');

    return `
      ${data.source === 'mock' ? notice('mock', '<strong>Données de démonstration.</strong> Les propositions ci-dessous sont produites par un substitut déterministe, pas par le modèle — les réservations, commentaires et chambres candidates sont en revanche réels. Le branchement de l’agent est prévu ensuite.') : ''}
      <div class="card">
        <h2>${esc(data.propertyName)} · ${esc(fmtDate(data.date))}</h2>
        <div class="stats">
          <div class="stat"><b>${data.totals.rows}</b><span>arrivées sans chambre</span></div>
          <div class="stat"><b>${data.totals.needsReview}</b><span>à vérifier</span></div>
          <div class="stat"><b>${data.totals.withComment}</b><span>avec commentaire</span></div>
        </div>
      </div>
      ${bar('top', chosen)}
      <div class="proposals">${cards}</div>
      ${bar('bottom', chosen)}`;
  }

  let current = null;
  function paint() {
    $('#alloc-out').innerHTML = renderRows(current);
    for (const card of document.querySelectorAll('.prop')) {
      const id = card.dataset.id;
      card.querySelector('.pick')?.addEventListener('click', () => {
        decisions.set(id, decisions.get(id) === 'ok' ? undefined : 'ok');
        if (!decisions.get(id)) decisions.delete(id);
        paint();
      });
      card.querySelector('.drop')?.addEventListener('click', () => {
        decisions.set(id, decisions.get(id) === 'no' ? undefined : 'no');
        if (!decisions.get(id)) decisions.delete(id);
        paint();
      });
    }
    for (const b of document.querySelectorAll('.btn-apply')) b.addEventListener('click', applyApproved);
  }

  async function applyApproved() {
    const approved = rows.filter((r) => decisions.get(r.reservationId) === 'ok' && r.unitId)
      .map((r) => ({ reservationId: r.reservationId, unitId: r.unitId }));
    if (!approved.length) return;
    if (!confirm(`Attribuer ${approved.length} chambre(s) dans Apaleo ?`)) return;
    const buttons = [...document.querySelectorAll('.btn-apply')];
    for (const b of buttons) { b.disabled = true; b.textContent = 'Attribution…'; }
    try {
      const res = await api('/api/ops/allocation/apply', {
        method: 'POST',
        body: JSON.stringify({ propertyId: $('#aprop').value, date: $('#adate').value, approved }),
      });
      const failed = res.results.filter((r) => !r.applied);
      $('#alloc-out').insertAdjacentHTML('afterbegin', notice(failed.length ? 'err' : 'ok',
        `<strong>${res.applied}/${res.total} chambre(s) attribuée(s).</strong>` +
        (failed.length ? `<br>${failed.map((f) => `${esc(f.reservationId)} : ${esc(f.error)}`).join('<br>')}` : '')));
      for (const r of res.results) if (r.applied) decisions.delete(r.reservationId);
      await loadProposals(true);
    } catch (e) {
      $('#alloc-out').insertAdjacentHTML('afterbegin', notice('err', esc(e.message)));
      for (const b of buttons) { b.disabled = false; b.textContent = 'Appliquer les validées'; }
    }
  }

  async function loadProposals(silent) {
    const btn = $('#btn-load');
    if (!silent) { btn.disabled = true; btn.textContent = 'Chargement…'; $('#alloc-out').innerHTML = ''; }
    try {
      const data = await api(`/api/ops/allocation/proposals?propertyId=${encodeURIComponent($('#aprop').value)}&date=${$('#adate').value}`);
      current = data; rows = data.rows;
      if (!rows.length) { $('#alloc-out').innerHTML = notice('info', 'Aucune arrivée sans chambre à cette date.'); return; }
      applyMode($('#amode').value);
      paint();
    } catch (e) {
      $('#alloc-out').innerHTML = notice('err', esc(e.message));
    } finally { btn.disabled = false; btn.textContent = 'Charger les propositions'; }
  }

  $('#btn-load').addEventListener('click', () => loadProposals(false));
  $('#amode').addEventListener('change', () => { if (rows.length) { applyMode($('#amode').value); paint(); } });

  // Apaleo resizes the iframe height only, and only if the page broadcasts it.
  // Loaded solely when embedded: outside Apaleo the script has nothing to talk to.
  if (embedded) {
    const tag = document.createElement('script');
    tag.src = 'https://cdn.apaleo.com/scripts/broadcast-iframe-resize.min.js';
    tag.defer = true;
    tag.onload = () => { try { window.broadcastIframeHeight?.(); } catch { /* not embedded after all */ } };
    document.head.appendChild(tag);
  }

  // Writes disabled server-side, or the page opened under another account: say so
  // up front rather than letting someone fill in a form that will be refused.
  async function checkConfig() {
    try {
      const cfg = await api('/api/ops/config');
      const account = qs.get('accountCode');
      const notices = [];
      if (!cfg.writesEnabled) {
        notices.push(notice('err', '<strong>Écritures désactivées.</strong> OPS_WRITE_PASSWORD n’est pas défini côté serveur : « Remplir », « Nettoyer » et « Appliquer » seront refusés.'));
      }
      if (account && cfg.accountCode && account !== cfg.accountCode) {
        notices.push(notice('err', `<strong>Compte inattendu.</strong> Cette page est réservée au compte ${esc(cfg.accountCode)} ; elle est ouverte sous ${esc(account)}. Les écritures seront refusées.`));
      }
      if (notices.length) document.querySelector('.tabs').insertAdjacentHTML('beforebegin', notices.join(''));
    } catch { /* la page reste utilisable en lecture */ }
  }

  // ── boot ────────────────────────────────────────────────────────────────
  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  $('#adate').value = qs.get('date') || tomorrow;
  checkConfig();
  loadProperties().catch((e) => { $('#ctx').textContent = `Erreur : ${e.message}`; });
})();

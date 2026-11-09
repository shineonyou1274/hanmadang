/* Stage-only adapter; load as a classic same-origin script before the page script.
   getState/vote return {votingOpen, resultsPublished, selectedCandidateId,
   phase:'preparing'|'open'|'closed', results?}; errors reject rather than posing as closed.
   Missing settings or vstate, missing dates, and not-yet-open are 'preparing'.
   State/window display uses the device clock as an estimate; server rules authorize votes.
   Results require current vstate epoch, current reveal epoch, and a fresh anonymous
   server-allowed public result of the same epoch, followed by a fresh state check.
   Publication remains disabled until the actual target deployment's rules are verified;
   emulator-only success does not verify live rules. No token is needed for getState. */
(() => {
  'use strict';
  const config = {
    apiKey: 'AIzaSyAm-uo720r9Lq4ZzbTgwVnCmrej6Yohf2w',
    authDomain: 'gdeal-hanmadang.firebaseapp.com',
    projectId: 'gdeal-hanmadang',
    storageBucket: 'gdeal-hanmadang.firebasestorage.app',
    messagingSenderId: '428027399816',
    appId: '1:428027399816:web:4d8a8177dd5e69b79cd93d'
  };
  const appUrl = 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
  const dbUrl = 'https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js';
  const PUBLIC_READ_ENFORCES_CLOSED = false;
  let clientPromise;
  function client() {
    if (!clientPromise) clientPromise = Promise.all([import(appUrl), import(dbUrl)])
      .then(([app, db]) => {
        const name = 'mascot-vote-stage';
        const existing = app.getApps().find(a => a.name === name);
        const instance = existing || app.initializeApp(config, name);
        if (instance.options.projectId !== config.projectId || instance.options.appId !== config.appId)
          throw new Error('CONFIG');
        return { sdk: db, db: db.getFirestore(instance) };
      }).catch(() => { clientPromise = undefined; throw new Error('SERVICE_UNAVAILABLE'); });
    return clientPromise;
  }
  // Firestore document IDs are single path segments, never normalise or repair a credential.
  function validId(value, maxBytes = 1500) {
    return typeof value === 'string' && value.length > 0 && value !== '.' && value !== '..'
      && !value.includes('/') && !/^__.*__$/.test(value)
      && !/[\u0000-\u001f\u007f]/.test(value) && new TextEncoder().encode(value).length <= maxBytes;
  }
  function validToken(token) { return validId(token) && [...token].length >= 20; }
  function validCandidate(id) { return validId(id) && [...id].length <= 64; }
  function millis(t) {
    if (!t || typeof t.toMillis !== 'function') return null;
    const n = t.toMillis();
    return Number.isFinite(n) ? n : null;
  }
  function calculate(settings, progress, now) {
    const base = { votingOpen: false, resultsPublished: false, phase: 'preparing' };
    if (!settings || !progress) return base;
    if (!Number.isSafeInteger(progress.epoch) || progress.epoch < 1 || !['open','closed'].includes(progress.phase))
      throw new Error('INVALID_DATA');
    const start = millis(settings.openAt), end = millis(settings.closeAt);
    if (progress.phase === 'closed') { base.phase = 'closed'; return base; }
    if (end !== null && now >= end) { base.phase = 'closed'; return base; }
    if (settings.open === true && start !== null && end !== null && now >= start && now < end) {
      base.votingOpen = true; base.phase = 'open';
    }
    return base;
  }
  async function readState(c, token) {
    const { sdk, db } = c;
    const settingsDoc = await sdk.getDocFromServer(sdk.doc(db, 'settings', 'vote'));
    const settings = settingsDoc.exists() ? settingsDoc.data() : null;
    const progressDoc = await sdk.getDocFromServer(sdk.doc(db, 'vstate', 'main'));
    const progress = progressDoc.exists() ? progressDoc.data() : null;
    const state = calculate(settings, progress, Date.now());
    state.selectedCandidateId = null;
    if (token !== null) {
      const mine = await sdk.getDocFromServer(sdk.doc(db, 'votes', token));
      if (mine.exists()) {
        const chosen = mine.data().e;
        if (!validCandidate(chosen)) throw new Error('INVALID_DATA');
        state.selectedCandidateId = chosen;
      }
    }
    // Server rules must enforce final closed state, event day, and both epoch checks.
    // Permission denied means unpublished; a network error remains a real error.
    if (PUBLIC_READ_ENFORCES_CLOSED && progress && progress.phase === 'closed' && settings) {
      const marker = await sdk.getDocFromServer(sdk.doc(db, 'vreveal', 'main'));
      const mark = marker.exists() ? marker.data() : null;
      let result = null;
      if (mark && mark.epoch === progress.epoch && millis(mark.at) !== null) {
        try { result = await sdk.getDocFromServer(sdk.doc(db, 'vresults', 'public')); }
        catch (error) { if (!error || error.code !== 'permission-denied') throw error; }
      }
      if (result && result.exists()) {
        const data = result.data(), counts = data.counts;
        if (data.epoch !== progress.epoch) throw new Error('INVALID_DATA');
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('INVALID_DATA');
        const safe = Object.create(null);
        for (const [id, count] of Object.entries(counts)) {
          if (!validCandidate(id) || !Number.isSafeInteger(count) || count < 0) throw new Error('INVALID_DATA');
          safe[id] = count;
        }
        // Discard an earlier response if a reopen/reveal removal was observed in the meantime.
        const [latestState, latestMarker] = await Promise.all([
          sdk.getDocFromServer(sdk.doc(db, 'vstate', 'main')),
          sdk.getDocFromServer(sdk.doc(db, 'vreveal', 'main'))
        ]);
        if (latestState.exists() && latestMarker.exists()
            && latestState.data().phase === 'closed' && latestState.data().epoch === progress.epoch
            && latestMarker.data().epoch === progress.epoch && millis(latestMarker.data().at) !== null) {
          state.results = safe;
          state.resultsPublished = true;
          state.votingOpen = false;
          state.phase = 'closed';
        }
      }
    }
    return state;
  }
  function safeError(error) {
    const allowed = ['INVALID_TOKEN', 'INVALID_CANDIDATE', 'NOT_ELIGIBLE', 'CLOSED', 'INVALID_DATA', 'SERVICE_UNAVAILABLE'];
    if (error && allowed.includes(error.message)) return new Error(error.message);
    if (error && error.code === 'permission-denied') return new Error('NOT_ELIGIBLE');
    return new Error('SERVICE_UNAVAILABLE');
  }
  window.MascotVoteAdapter = Object.freeze({
    async getState({ token } = {}) {
      try {
        if (token == null || token === '') token = null;
        else if (!validToken(token)) throw new Error('INVALID_TOKEN');
        return await readState(await client(), token);
      } catch (error) { throw safeError(error); }
    },
    async vote({ token, candidateId } = {}) {
      try {
        if (!validToken(token)) throw new Error('INVALID_TOKEN');
        if (!validCandidate(candidateId)) throw new Error('INVALID_CANDIDATE');
        const c = await client(), { sdk, db } = c;
        const [settingsDoc, progressDoc, entry, participant] = await Promise.all([
          sdk.getDocFromServer(sdk.doc(db, 'settings', 'vote')),
          sdk.getDocFromServer(sdk.doc(db, 'vstate', 'main')),
          sdk.getDocFromServer(sdk.doc(db, 'entries', candidateId)),
          sdk.getDocFromServer(sdk.doc(db, 'participants', token))
        ]);
        const settings = settingsDoc.exists() ? settingsDoc.data() : null;
        const progress = progressDoc.exists() ? progressDoc.data() : null;
        if (!calculate(settings, progress, Date.now()).votingOpen) throw new Error('CLOSED');
        if (!entry.exists() || (Object.hasOwn(entry.data(), 'on') && entry.data().on !== true)) throw new Error('INVALID_CANDIDATE');
        if (!participant.exists() || participant.data().status !== 'active'
          || (participant.data().test === true && settings.allowTest !== true)) throw new Error('NOT_ELIGIBLE');
        // One write only; server rules re-check entry, ticket and deadline atomically.
        await sdk.setDoc(sdk.doc(db, 'votes', token), { e: candidateId, at: sdk.serverTimestamp() });
        return await readState(c, token);
      } catch (error) { throw safeError(error); }
    }
  });
})();

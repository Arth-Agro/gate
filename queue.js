// Shared by the page and the service worker: the store on the phone, and the upload.
// IndexedDB "gate": "entries" keeps every entry until it is uploaded (then 3 more days,
// without the photo, for the on-screen list); "kv" keeps the server link, the logged-in
// guard, the guard names and the people list, so the app works with no internet.
const Q = (() => {
  // Google's Apps Script takes about 2 s when awake but 30-40 s to wake after being idle
  // (measured 8 Oct 2026), so a slow answer is waited for, not called "no internet".
  const TIMEOUT = 90000;
  let dbp, lastAnswer = 0, lastError = '';
  const db = () => dbp || (dbp = new Promise((ok, fail) => {
    const r = indexedDB.open('gate', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('entries', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  }));

  async function tx(store, mode, fn) {
    const t = (await db()).transaction(store, mode), req = fn(t.objectStore(store));
    return new Promise((ok, fail) => {
      t.oncomplete = () => ok(req.result);
      t.onerror = () => fail(t.error);
    });
  }

  // kv(key) reads, kv(key, value) writes, kv(key, null) deletes.
  const kv = (k, v) => v === undefined ? tx('kv', 'readonly', (s) => s.get(k))
    : tx('kv', 'readwrite', (s) => v === null ? s.delete(k) : s.put(v, k));
  const all = () => tx('entries', 'readonly', (s) => s.getAll());
  const put = (rec) => tx('entries', 'readwrite', (s) => s.put(rec));
  const del = (id) => tx('entries', 'readwrite', (s) => s.delete(id));

  // text/plain POST: Apps Script answers it cross-origin with no CORS preflight.
  // Fails with a short reason the screen can show: TIMEOUT, NETWORK, HTTP <code> or BAD_REPLY.
  async function call(body) {
    let r;
    try {
      r = await fetch(await kv('api'), {
        method: 'POST', body: JSON.stringify(body),
        signal: AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT) : undefined,   // older phones lack it
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' || e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    try {
      const out = await r.json();
      lastAnswer = Date.now();
      return out;
    } catch (e) {
      throw new Error('BAD_REPLY');
    }
  }

  // Wakes the server ahead of an upload if it has not answered for 5 minutes, so the
  // upload after Submit finds it awake.
  const warm = () => { if (Date.now() - lastAnswer > 300000) call({ action: 'guards' }).catch(() => {}); };

  // Oldest first, up to 5 entries or about 800 KB of photos per request: one server wake-up for
  // many entries, small enough for a slow connection. Resolves true when nothing is left to send.
  // An entry the server rejects as INVALID is kept (marked bad) and never sent again.
  async function upload() {
    const s = await kv('session');
    if (!s) return false;
    const recs = (await all()).sort((a, b) => (a.entry.time < b.entry.time ? -1 : 1));
    for (const r of recs) if (r.sent && Date.now() - r.sent > 3 * 864e5) await del(r.id);
    let waiting = recs.filter((r) => !r.sent && !r.bad), left = 0;
    while (waiting.length) {
      const batch = [];
      let size = 0;
      for (const r of waiting) {
        const n = (r.entry.photo || '').length;
        if (batch.length && (batch.length === 5 || size + n > 800000)) break;
        batch.push(r);
        size += n;
      }
      let res;
      try {
        res = await call({ action: 'submit', guard: s.guard, pin: s.pin, entries: batch.map((r) => r.entry) });
      } catch (e) {
        lastError = e.message;
        return false;                    // offline or server unreachable: everything stays, try again later
      }
      lastError = '';
      if (!res.ok || !res.results) {     // wrong PIN, locked, or a server too old for batches: stop, keep all
        for (const r of batch) { r.error = res.ok ? 'SERVER_NEEDS_UPDATE' : res.error; await put(r); }
        return false;
      }
      for (let i = 0; i < batch.length; i++) {
        const r = batch[i], out = res.results[i] || { ok: false, error: 'NO_ANSWER' };
        if (out.ok) {
          r.sent = Date.now();
          r.error = '';
          delete r.entry.photo;
        } else {
          r.error = out.error;
          r.bad = String(out.error).startsWith('INVALID');
          if (!r.bad) left++;            // e.g. Drive failed for a moment: retried next time
        }
        await put(r);
      }
      waiting = waiting.slice(batch.length);
    }
    return left === 0;
  }

  let running = null;
  const flush = () => running || (running = upload().finally(() => { running = null; }));
  const add = (entry) => put({ id: entry.id, entry, sent: 0, error: '' });

  return { kv, all, call, flush, add, warm, lastError: () => lastError };
})();

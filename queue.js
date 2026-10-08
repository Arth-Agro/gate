// Shared by the page and the service worker: the store on the phone, and the upload.
// IndexedDB "gate": "entries" keeps every entry until it is uploaded (then 3 more days,
// without the photo, for the on-screen list); "kv" keeps the server link, the logged-in
// guard and the people list, so the app works with no internet.
const Q = (() => {
  let dbp;
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
  async function call(body) {
    const r = await fetch(await kv('api'), {
      method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // Oldest first, one at a time. Resolves true when nothing is left to upload.
  async function upload() {
    const s = await kv('session');
    if (!s) return false;
    let left = 0;
    for (const rec of (await all()).sort((a, b) => (a.entry.time < b.entry.time ? -1 : 1))) {
      if (rec.sent) {
        if (Date.now() - rec.sent > 3 * 864e5) await del(rec.id);
        continue;
      }
      let res;
      try {
        res = await call({ action: 'submit', guard: s.guard, pin: s.pin, entry: rec.entry });
      } catch (e) {
        return false; // offline or server unreachable: everything stays, try again later
      }
      if (res.ok) {
        rec.sent = Date.now();
        rec.error = '';
        delete rec.entry.photo;
      } else {
        rec.error = res.error;
        left++;
      }
      await put(rec);
      if (!res.ok && !String(res.error).startsWith('INVALID')) return false; // wrong PIN or locked: stop
    }
    return left === 0;
  }

  let running = null;
  const flush = () => running || (running = upload().finally(() => { running = null; }));
  const add = (entry) => put({ id: entry.id, entry, sent: 0, error: '' });

  return { kv, all, call, flush, add };
})();

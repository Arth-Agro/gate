// The guard's screen, for one estate.
//   IN:  pick a registered person (or "+ New person": name, type), purpose unless a siri, photo
//        (location taken with it), Submit.
//   OUT: the people inside today; tap OUT. No photo, no location: only the time.
// Everything is saved on the phone first (queue.js), then uploaded; nothing waits for the internet.
const $ = (id) => document.getElementById(id);
const S = { session: null, roster: { people: [], types: [], noPurpose: [] }, tab: 'IN', photo: '', loc: null, facing: 'environment' };
const ERR = {
  BAD_PIN: 'Wrong PIN, or this guard is switched off. / गलत पिन',
  LOCKED: 'Too many wrong PINs. Try again in 15 minutes. / 15 मिनट बाद कोशिश करें',
};
let stream = null;

init();

async function init() {
  // No service worker inside the Android app: its files are already on the phone.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  await takeSetupLink();
  // A setup link opened in a tab that already shows the app changes only the "#" part: no reload.
  window.addEventListener('hashchange', () => takeSetupLink().then((got) => got && route()));
  window.addEventListener('online', sync);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    sync();
    // Back in the app (also after switching Location on): refresh a missing or stale location.
    if (!$('vEntry').hidden && !fresh()) locate();
  });
  setInterval(sync, 60000);
  route();
}

// The setup link is <app>#api=<Apps Script /exec URL>. After "#" it is never sent to the web host.
async function takeSetupLink() {
  const api = new URLSearchParams(location.hash.slice(1)).get('api');
  if (!api) return false;
  await Q.kv('api', api);
  history.replaceState(null, '', location.pathname);
  return true;
}

async function route() {
  const api = await Q.kv('api');
  S.session = await Q.kv('session');
  if (S.session && !S.session.estate) S.session = null;     // a login from before estates: log in again
  for (const v of ['vSetup', 'vLogin', 'vEntry']) $(v).hidden = true;
  $('who').textContent = '';
  $('sync').hidden = true;
  if (!api) return ($('vSetup').hidden = false);
  if (!S.session) {
    $('vLogin').hidden = false;
    return loadGuards();
  }
  $('vEntry').hidden = false;
  $('who').textContent = `${S.session.guard} · ${S.session.estate}`;
  S.roster = (await Q.kv('roster:' + S.session.estate)) || S.roster;
  fillTypes();
  resetForm();
  if (!fresh()) locate();                 // ready before the first photo
  sync();
  refreshRoster();
}

/* ---------- setup and login ---------- */

$('apiSave').onclick = async () => {
  const text = $('apiIn').value.trim();
  let api = text;
  try { api = new URLSearchParams(new URL(text).hash.slice(1)).get('api') || text; } catch (e) { /* not a link */ }
  if (!/^https?:\/\//.test(api)) return ($('setupMsg').textContent = 'That is not the setup link.');
  await Q.kv('api', api);
  route();
};

// Why the server could not be reached, in words a guard can act on. The code in brackets is
// for whoever fixes it: a screenshot then says exactly what happened.
const REASON = {
  TIMEOUT: 'The server did not answer in 90 seconds. It is slow right now; trying again.',
  NETWORK: 'Could not reach the server. If the internet works, allow Mobile data and Wi-Fi for this app in phone Settings > Apps.',
  BAD_REPLY: 'The server sent an unexpected answer.',
};
const reason = (e) => `${REASON[e.message] || 'Server error.'} [${e.message}] / सर्वर से जवाब नहीं आया`;

function note(id, text, bad) {
  $(id).textContent = text;
  $(id).className = bad ? 'msg' : 'msg wait';
}

// Google wakes the server in 2 to 40 seconds. A running count shows the app is working.
function ticking(id, text) {
  const t0 = Date.now(), show = () => note(id, `${text} ${Math.round((Date.now() - t0) / 1000)} s`);
  show();
  const t = setInterval(show, 1000);
  return () => clearInterval(t);
}

// The estate is picked first; the name list then shows that estate's guards only.
function fillGuards(guards) {
  guards = guards.filter((g) => g && g.estate);             // lists saved before estates are ignored
  const estates = [...new Set(guards.map((g) => g.estate))].sort();
  const keepE = $('estate').value, keepG = $('guard').value;
  $('estate').innerHTML = '<option value="">Select / चुनें</option>' + estates.map((e) => `<option>${esc(e)}</option>`).join('');
  $('estate').value = estates.includes(keepE) ? keepE : estates.length === 1 ? estates[0] : '';
  const names = guards.filter((g) => g.estate === $('estate').value).map((g) => g.name);
  $('guard').innerHTML = '<option value="">Select / चुनें</option>' + names.map((g) => `<option>${esc(g)}</option>`).join('');
  if (names.includes(keepG)) $('guard').value = keepG;
}

$('estate').oninput = async () => fillGuards((await Q.kv('guards')) || []);

// Names saved on the phone show at once; the server's list replaces them when it answers.
// With no saved names (the phone's first login) it shows progress and keeps retrying.
let guardRetry;
async function loadGuards() {
  clearTimeout(guardRetry);
  const saved = ((await Q.kv('guards')) || []).filter((g) => g && g.estate);
  if (saved.length) fillGuards(saved);
  const stop = saved.length ? () => {} : ticking('loginMsg', 'Connecting to the server… / सर्वर से जुड़ रहे हैं');
  try {
    const r = await Q.call({ action: 'guards' });
    stop();
    if (!saved.length) note('loginMsg', '');
    await Q.kv('guards', r.guards);
    fillGuards(r.guards);
  } catch (e) {
    stop();
    if (saved.length) return;
    note('loginMsg', reason(e), true);
    guardRetry = setTimeout(() => { if (!$('vLogin').hidden) loadGuards(); }, 10000);
  }
}

$('loginBtn').onclick = async () => {
  const guard = $('guard').value, pin = $('pin').value.trim();
  if (!$('estate').value || !guard || !/^\d{4,8}$/.test(pin)) return note('loginMsg', 'Select estate and name, and enter your PIN.', true);
  // A guard who has logged in on this phone before is let in at once, even offline.
  // The server still checks the PIN with every upload, and logs the guard out if it changed.
  const known = (await Q.kv('known')) || {};
  if (known[guard] && known[guard].pin === pin) return enter(guard, pin, known[guard].estate);
  $('loginBtn').disabled = true;
  const stop = ticking('loginMsg', 'Checking PIN with the server… / पिन जांच रहे हैं');
  try {
    const r = await Q.call({ action: 'login', guard, pin });
    stop();
    if (!r.ok) return note('loginMsg', ERR[r.error] || r.error, true);
    await keep(r);
    known[r.guard] = { pin, estate: r.estate };
    await Q.kv('known', known);
    enter(r.guard, pin, r.estate);
  } catch (e) {
    stop();
    note('loginMsg', reason(e), true);
  } finally {
    $('loginBtn').disabled = false;
  }
};

$('pin').onkeydown = (ev) => { if (ev.key === 'Enter') $('loginBtn').click(); };

// The estate's people, the types, and the server's view of who is inside, kept on the phone.
async function keep(r) {
  await Q.kv('roster:' + r.estate, { people: r.people, types: r.types, noPurpose: r.noPurpose });
  await Q.kv('inside:' + r.estate, r.inside);
}

async function enter(guard, pin, estate) {
  clearTimeout(guardRetry);
  await Q.kv('session', { guard, pin, estate });
  $('pin').value = '';
  note('loginMsg', '');
  route();
}

// When online: pick up changes to People, the inside list from other phones, and a changed PIN.
async function refreshRoster() {
  try {
    const r = await Q.call({ action: 'login', guard: S.session.guard, pin: S.session.pin });
    if (r.ok) {
      await keep(r);
      S.roster = await Q.kv('roster:' + r.estate);
      if (!$('pick').value) fillTypes();
      show();
    } else if (r.error === 'BAD_PIN') {
      const known = (await Q.kv('known')) || {};
      delete known[S.session.guard];
      await Q.kv('known', known);
      await Q.kv('session', null);
      await route();
      note('loginMsg', 'Your PIN was changed or switched off. Please log in again. / दोबारा लॉगिन करें', true);
    }
  } catch (e) { /* offline: keep the saved lists */ }
}

$('logout').onclick = async () => {
  const waiting = (await Q.all()).filter((r) => !r.sent).length;
  if (waiting && !confirm(`${waiting} entries are not uploaded yet. They will upload after the next guard logs in. Log out?`)) return;
  await Q.kv('session', null);
  route();
};

/* ---------- who is inside ---------- */

const istDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istTime = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

// Today's INs at this estate with no OUT: the server's list (which knows other phones) plus
// this phone's own entries, uploaded or not, minus everyone this phone has marked OUT.
async function insideNow() {
  const today = istDay(Date.now()), estate = S.session.estate;
  const mine = (await Q.all()).filter((r) => !r.bad && r.entry.estate === estate).map((r) => r.entry);
  const closed = new Set(mine.filter((e) => e.direction === 'OUT').map((e) => e.inId));
  const all = new Map();
  for (const r of (await Q.kv('inside:' + estate)) || []) if (r.date === today) all.set(r.id, { ...r, time: r.time.slice(0, 5) });
  for (const e of mine) {
    if (e.direction === 'IN' && istDay(e.time) === today) {
      all.set(e.id, { id: e.id, name: e.name, type: e.type, polyhouse: e.polyhouse || '', time: istTime(e.time) });
    }
  }
  return [...all.values()].filter((r) => !closed.has(r.id)).sort((a, b) => (a.time < b.time ? -1 : 1));
}

$('tabs').onclick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  S.tab = b.dataset.v;
  showTab();     // at once; the lists follow
  show();
};

function showTab() {
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === S.tab);
  $('pIn').hidden = S.tab !== 'IN';
  $('pOut').hidden = S.tab !== 'OUT';
}

$('inside').onclick = async (ev) => {
  const b = ev.target.closest('button[data-id]');
  if (!b) return;
  const r = (await insideNow()).find((x) => x.id === b.dataset.id);
  if (!r || !confirm(`${r.name}: OUT? / बाहर?`)) return;
  await Q.add({ id: newId(), time: new Date().toISOString(), direction: 'OUT', inId: r.id, estate: S.session.estate,
    guard: S.session.guard, name: r.name, type: r.type, polyhouse: r.polyhouse });
  toast(`OUT ✓ ${r.name} / बाहर दर्ज`);
  sync();
};

/* ---------- IN ---------- */

const label = (p) => [p.name, p.polyhouse, p.type].filter(Boolean).join(' · ');

function fillTypes() {
  $('type').innerHTML = '<option value="">Select / चुनें</option>' +
    S.roster.types.map((t) => `<option>${esc(t)}</option>`).join('');
}

// Registered people of this estate who are not inside; anyone else is a "New person".
function fillPick(inside) {
  const inNames = new Set(inside.map((r) => r.name)), keep = $('pick').value;
  $('pick').innerHTML = '<option value="">Select name / नाम चुनें</option>' +
    S.roster.people.map((p, i) => (inNames.has(p.name) ? '' : `<option value="${i}">${esc(label(p))}</option>`)).join('') +
    '<option value="new">+ New person / नया व्यक्ति</option>';
  if ([...$('pick').options].some((o) => o.value === keep)) $('pick').value = keep;
}

for (const id of ['pick', 'name', 'type', 'purpose']) $(id).oninput = form;

function current() {
  const pick = $('pick').value, p = pick !== '' && pick !== 'new' ? S.roster.people[pick] : null;
  return {
    name: p ? p.name : pick === 'new' ? $('name').value.trim() : '',
    type: p ? p.type : pick === 'new' ? $('type').value : '',
    polyhouse: p ? p.polyhouse : '',
    registered: !!p,
    purpose: $('purpose').value.trim(),
  };
}

// Shows the fields that apply and enables Submit only when nothing compulsory is missing.
// Purpose is compulsory for everyone except Primary and Secondary Siris.
function form() {
  const e = current(), needPurpose = !!e.type && !S.roster.noPurpose.includes(e.type);
  $('newRow').hidden = $('pick').value !== 'new';
  $('info').textContent = e.registered ? [e.type, e.polyhouse && `Polyhouse ${e.polyhouse}`].filter(Boolean).join(' · ') : '';
  $('purposeRow').hidden = !needPurpose;
  const miss = [];
  if (!e.name) miss.push('name');
  if (!e.type) miss.push('type');
  if (needPurpose && !e.purpose) miss.push('purpose');
  if (!S.photo) miss.push('photo');
  if (!fresh()) miss.push('location');
  $('missing').textContent = miss.length ? 'Missing / बाकी: ' + miss.join(', ') : '';
  $('submit').disabled = miss.length > 0;
  return miss.length === 0;
}

function resetForm() {
  S.photo = '';                          // the location is kept for the next entry
  for (const id of ['pick', 'name', 'type', 'purpose']) $(id).value = '';
  $('photo').hidden = true;
  $('photoBtn').innerHTML = '📷 Take photo <small>फोटो लें</small>';
  form();
}

$('submit').onclick = async () => {
  if (!form()) return;
  const e = current(), needPurpose = !S.roster.noPurpose.includes(e.type);
  $('submit').disabled = true;
  await Q.add({
    id: newId(), time: new Date().toISOString(), direction: 'IN', estate: S.session.estate, guard: S.session.guard,
    name: e.name, type: e.type, polyhouse: e.polyhouse, registered: e.registered, purpose: needPurpose ? e.purpose : '',
    lat: S.loc.lat, lng: S.loc.lng, acc: S.loc.acc, photo: S.photo,
  });
  toast(`IN ✓ ${e.name} / अंदर दर्ज`);
  resetForm();
  scrollTo(0, 0);
  if (navigator.serviceWorker) navigator.serviceWorker.ready.then((r) => r.sync && r.sync.register('upload')).catch(() => {});
  sync();
};

/* ---------- camera: live photo only, there is no gallery option ---------- */

$('photoBtn').onclick = async () => {
  if (!fresh()) locate(); // normally the kept location is used and nobody waits
  Q.warm();               // wake a sleeping server now, so the upload after Submit is quick
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: S.facing, width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    return toast('Camera blocked. Allow Camera for this app in phone Settings > Apps. / कैमरा की अनुमति दें', true);
  }
  $('video').srcObject = stream;
  $('cam').hidden = false;
  await $('video').play();
};

$('camSnap').onclick = () => {
  const v = $('video');
  if (!v.videoWidth) return;
  // 1024 px on the long side at JPEG 0.8: about 100-200 KB, faces stay sharp.
  const k = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * k);
  c.height = Math.round(v.videoHeight * k);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  S.photo = c.toDataURL('image/jpeg', 0.8);
  closeCamera();
  $('photo').src = S.photo;
  $('photo').hidden = false;
  $('photoBtn').innerHTML = '📷 Retake photo <small>दोबारा फोटो लें</small>';
  form();
};

$('camFlip').onclick = () => {
  S.facing = S.facing === 'environment' ? 'user' : 'environment';
  closeCamera();
  $('photoBtn').onclick();
};

$('camClose').onclick = closeCamera;

function closeCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('cam').hidden = true;
}

/* ---------- location: from the phone's GPS, never typed or picked on a map ---------- */

// Taken when the entry screen opens and kept for 3 minutes (Yashswi, 9 Oct 2026); a photo uses
// it at once. It is refreshed in the background every 2 minutes while the app is on screen, so
// it never runs out mid-entry. The guard waits only when there is none yet or it is older than
// 3 minutes (phone just unlocked). Every entry's location is at most 3 minutes old.
const FRESH = 180000, REFRESH = 120000;
const fresh = () => !!S.loc && Date.now() - S.loc.at < FRESH;
let locating = false;

function locate() {
  if (locating) return;
  if (!navigator.geolocation) return gps('This phone gives no location.', 'bad');
  locating = true;
  if (!fresh()) gps('📍 Getting location… / लोकेशन ली जा रही है', '');
  navigator.geolocation.getCurrentPosition((p) => {
    locating = false;
    S.loc = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy), at: Date.now() };
    gps(`📍 Location ready · ±${S.loc.acc} m · ${istTime(S.loc.at)} / लोकेशन तैयार`, 'ok');
    form();
  }, (err) => {
    locating = false;
    if (fresh()) return;                 // the kept location is still good; try again at the next refresh
    gps((err.code === 1 ? 'Location blocked. Allow Location for this app in phone Settings > Apps.'
      : 'Location not found. Is Location (GPS) on?') + ' Tap to try again. / लोकेशन चालू करें, फिर टैप करें', 'bad');
    form();
  }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

// Refresh in the background while the entry screen is showing. Phones pause timers while the
// screen is off; coming back to the app refreshes a stale location (see init).
setInterval(() => { if (!document.hidden && S.session && !$('vEntry').hidden) locate(); }, REFRESH);

function gps(text, cls) {
  const b = $('gps');
  b.hidden = false;
  b.textContent = text;
  b.className = 'gps ' + cls;
  b.disabled = cls !== 'bad';
}

$('gps').onclick = locate;

/* ---------- the screen and upload status ---------- */

async function sync() {
  if (!S.session) return;
  await show();
  await Q.flush();
  await show();
}

$('sync').onclick = async () => {
  await sync();
  if ((await Q.all()).some((r) => !r.sent && !r.bad) && Q.lastError()) toast(reason({ message: Q.lastError() }), true);
};

async function show() {
  if (!S.session) return;
  showTab();
  const inside = await insideNow(), recs = await Q.all(), today = istDay(Date.now());
  $('insideCount').textContent = inside.length || '';
  fillPick(inside);
  form();
  $('inside').innerHTML = inside.map((r) => `<li><div><b>${esc(r.name)}</b><small>` +
    `${esc([r.type, r.polyhouse && 'P: ' + r.polyhouse, 'in ' + r.time].filter(Boolean).join(' · '))}</small></div>` +
    `<button data-id="${esc(r.id)}">OUT</button></li>`).join('') || '<li>Nobody inside / कोई अंदर नहीं</li>';

  const waiting = recs.filter((r) => !r.sent).length;
  $('sync').hidden = false;
  $('sync').className = 'pill ' + (waiting ? 'wait' : 'ok');
  $('sync').textContent = waiting ? `⏳ ${waiting} to upload` : '✓ All uploaded';
  $('recent').innerHTML = recs
    .filter((r) => istDay(r.entry.time) === today && r.entry.estate === S.session.estate)
    .sort((a, b) => (a.entry.time < b.entry.time ? 1 : -1))
    .map((r) => `<li><span>${istTime(r.entry.time)}</span>` +
      `<span class="${r.entry.direction}">${r.entry.direction}</span><span>${esc(r.entry.name)}</span>` +
      `<span${r.error ? ' class="err"' : ''}>${r.sent ? '✓' : r.error ? '⚠ ' + esc(r.error) : '⏳'}</span></li>`)
    .join('') || '<li>None yet</li>';
}

/* ---------- small helpers ---------- */

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

let toastTimer;
function toast(text, bad) {
  const t = $('toast');
  t.textContent = text;
  t.className = bad ? 'bad' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

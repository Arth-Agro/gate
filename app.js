// The guard's screen. Flow: person -> IN/OUT -> photo (location is taken with it) -> Submit.
// Submit saves on the phone first (queue.js), then uploads; nothing waits for the internet.
const $ = (id) => document.getElementById(id);
const S = { session: null, people: [], cat: 'Employee', dir: '', photo: '', loc: null, facing: 'environment' };
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
    // Back from switching Location on: take the missing location for the photo already taken.
    if (!$('vEntry').hidden && S.photo && !S.loc) locate();
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
  for (const v of ['vSetup', 'vLogin', 'vEntry']) $(v).hidden = true;
  $('who').textContent = '';
  $('sync').hidden = true;
  if (!api) return ($('vSetup').hidden = false);
  if (!S.session) {
    $('vLogin').hidden = false;
    return loadGuards();
  }
  $('vEntry').hidden = false;
  $('who').textContent = S.session.guard;
  S.people = (await Q.kv('people')) || [];
  fillPeople();
  resetForm();
  sync();
  refreshPeople();
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

function fillGuards(names) {
  const keep = $('guard').value;
  $('guard').innerHTML = '<option value="">Select / चुनें</option>' + names.map((g) => `<option>${esc(g)}</option>`).join('');
  if (names.includes(keep)) $('guard').value = keep;
}

// Names saved on the phone show at once; the server's list replaces them when it answers.
// With no saved names (the phone's first login) it shows progress and keeps retrying.
let guardRetry;
async function loadGuards() {
  clearTimeout(guardRetry);
  const saved = (await Q.kv('guards')) || [];
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
  if (!guard || !/^\d{4,8}$/.test(pin)) return note('loginMsg', 'Select your name and enter your PIN.', true);
  // A guard who has logged in on this phone before is let in at once, even offline.
  // The server still checks the PIN with every upload, and logs the guard out if it changed.
  const known = (await Q.kv('known')) || {};
  if (known[guard] === pin) return enter(guard, pin, await Q.kv('people'));
  $('loginBtn').disabled = true;
  const stop = ticking('loginMsg', 'Checking PIN with the server… / पिन जांच रहे हैं');
  try {
    const r = await Q.call({ action: 'login', guard, pin });
    stop();
    if (!r.ok) return note('loginMsg', ERR[r.error] || r.error, true);
    known[r.guard] = pin;
    await Q.kv('known', known);
    enter(r.guard, pin, r.people);
  } catch (e) {
    stop();
    note('loginMsg', reason(e), true);
  } finally {
    $('loginBtn').disabled = false;
  }
};

async function enter(guard, pin, people) {
  clearTimeout(guardRetry);
  await Q.kv('session', { guard, pin });
  if (people) await Q.kv('people', people);
  $('pin').value = '';
  note('loginMsg', '');
  route();
}

$('pin').onkeydown = (ev) => { if (ev.key === 'Enter') $('loginBtn').click(); };

// When online, pick up changes the admin made to the People list, and notice a PIN that was changed.
async function refreshPeople() {
  try {
    const r = await Q.call({ action: 'login', guard: S.session.guard, pin: S.session.pin });
    if (r.ok) {
      S.people = r.people;
      await Q.kv('people', r.people);
      if (!$('pick').value) fillPeople();
    } else if (r.error === 'BAD_PIN') {
      const known = (await Q.kv('known')) || {};
      delete known[S.session.guard];
      await Q.kv('known', known);
      await Q.kv('session', null);
      await route();
      note('loginMsg', 'Your PIN was changed or switched off. Please log in again. / दोबारा लॉगिन करें', true);
    }
  } catch (e) { /* offline: keep the saved list */ }
}

$('logout').onclick = async () => {
  const waiting = (await Q.all()).filter((r) => !r.sent).length;
  if (waiting && !confirm(`${waiting} entries are not uploaded yet. They will upload after the next guard logs in. Log out?`)) return;
  await Q.kv('session', null);
  route();
};

/* ---------- the entry form ---------- */

function fillPeople() {
  $('pick').innerHTML = '<option value="">Select name / नाम चुनें</option>' +
    S.people.map((p, i) => `<option value="${i}">${esc(p.name)} · ${esc(p.type)}</option>`).join('') +
    '<option value="new">+ New person / नया व्यक्ति</option>';
}

function seg(id, value) {
  for (const b of $(id).querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === value);
}

$('cat').onclick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  S.cat = b.dataset.v;
  $('pick').value = '';
  $('name').value = '';
  $('empType').value = '';
  form();
};

$('dir').onclick = (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  S.dir = b.dataset.v;
  form();
};

for (const id of ['pick', 'name', 'empType', 'remarks']) $(id).oninput = form;

// Shows the fields that apply and enables Submit only when nothing compulsory is missing.
function form() {
  const emp = S.cat === 'Employee', isNew = !emp || $('pick').value === 'new';
  seg('cat', S.cat);
  seg('dir', S.dir);
  $('pickRow').hidden = !emp;
  $('newRow').hidden = !isNew;
  $('typeRow').hidden = !emp;
  $('remarksHint').textContent = emp ? 'टिप्पणी (optional)' : 'Reason for visit / आने का कारण (optional)';

  const e = current(), miss = [];
  if (!e.name) miss.push('name');
  if (emp && !e.empType) miss.push('type');
  if (!e.direction) miss.push('IN/OUT');
  if (!S.photo) miss.push('photo');
  if (!S.loc) miss.push('location');
  $('missing').textContent = miss.length ? 'Missing / बाकी: ' + miss.join(', ') : '';
  $('submit').disabled = miss.length > 0;
  return miss.length === 0;
}

function current() {
  const emp = S.cat === 'Employee', pick = $('pick').value;
  const p = emp && pick !== '' && pick !== 'new' ? S.people[pick] : null;
  return {
    category: S.cat,
    name: p ? p.name : $('name').value.trim(),
    fromList: !!p,
    empType: emp ? (p ? p.type : $('empType').value) : '',
    direction: S.dir,
    remarks: $('remarks').value.trim(),
  };
}

function resetForm() {
  Object.assign(S, { cat: 'Employee', dir: '', photo: '', loc: null });
  for (const id of ['pick', 'name', 'empType', 'remarks']) $(id).value = '';
  $('photo').hidden = true;
  $('gps').hidden = true;
  $('photoBtn').innerHTML = '📷 Take photo <small>फोटो लें</small>';
  form();
}

$('submit').onclick = async () => {
  if (!form()) return;
  const e = current();
  $('submit').disabled = true;
  await Q.add({
    id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2),
    time: new Date().toISOString(), ...e,
    guard: S.session.guard, lat: S.loc.lat, lng: S.loc.lng, acc: S.loc.acc, photo: S.photo,
  });
  toast(`Saved ✓ ${e.name} ${e.direction} / सेव हो गया`);
  resetForm();
  scrollTo(0, 0);
  if (navigator.serviceWorker) navigator.serviceWorker.ready.then((r) => r.sync && r.sync.register('upload')).catch(() => {});
  sync();
};

/* ---------- camera: live photo only, there is no gallery option ---------- */

$('photoBtn').onclick = async () => {
  locate(); // the location is taken at the same moment as the photo
  Q.warm(); // wake a sleeping server now, so the upload after Submit is quick
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

function locate() {
  S.loc = null;
  gps('📍 Getting location… / लोकेशन ली जा रही है', '');
  if (!navigator.geolocation) return gps('This phone gives no location.', 'bad');
  navigator.geolocation.getCurrentPosition((p) => {
    S.loc = { lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), acc: Math.round(p.coords.accuracy) };
    gps(`📍 ${S.loc.lat}, ${S.loc.lng} (±${S.loc.acc} m)`, 'ok');
    form();
  }, (err) => {
    gps((err.code === 1 ? 'Location blocked. Allow Location for this app in phone Settings > Apps.'
      : 'Location not found. Is Location (GPS) on?') + ' Tap to try again. / लोकेशन चालू करें, फिर टैप करें', 'bad');
    form();
  }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

function gps(text, cls) {
  const b = $('gps');
  b.hidden = false;
  b.textContent = text;
  b.className = 'gps ' + cls;
  b.disabled = cls !== 'bad';
}

$('gps').onclick = locate;

/* ---------- upload status ---------- */

async function sync() {
  if (!S.session) return;
  await render();
  await Q.flush();
  await render();
}

$('sync').onclick = async () => {
  await sync();
  if ((await Q.all()).some((r) => !r.sent && !r.bad) && Q.lastError()) toast(reason({ message: Q.lastError() }), true);
};

async function render() {
  const recs = await Q.all(), today = new Date().toDateString();
  const waiting = recs.filter((r) => !r.sent).length;
  $('sync').hidden = false;
  $('sync').className = 'pill ' + (waiting ? 'wait' : 'ok');
  $('sync').textContent = waiting ? `⏳ ${waiting} to upload` : '✓ All uploaded';
  $('recent').innerHTML = recs
    .filter((r) => new Date(r.entry.time).toDateString() === today)
    .sort((a, b) => (a.entry.time < b.entry.time ? 1 : -1))
    .map((r) => `<li><span>${new Date(r.entry.time).toTimeString().slice(0, 5)}</span>` +
      `<span class="${r.entry.direction}">${r.entry.direction}</span><span>${esc(r.entry.name)}</span>` +
      `<span${r.error ? ' class="err"' : ''}>${r.sent ? '✓' : r.error ? '⚠ ' + esc(r.error) : '⏳'}</span></li>`)
    .join('') || '<li>None yet</li>';
}

/* ---------- small helpers ---------- */

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

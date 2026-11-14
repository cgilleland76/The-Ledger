/* ---------------------------------------------------------
   THE LEDGER — remote tabletop hub (hosted version)
   Backend: Supabase (rooms / characters / log_entries tables)
   GM calls: POST /api/gm  ->  Netlify Function -> Anthropic API
--------------------------------------------------------- */

(function () {

const cfg = window.LEDGER_CONFIG || {};
let supabase = null;
if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && cfg.SUPABASE_URL.indexOf("YOUR-PROJECT") === -1) {
  supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
}

let VIEW = 'landing';
let MODE = 'group';        // 'solo' | 'group'
let ROOM = null;
let META = null;
let ROSTER = {};
let LOG = [];
let MY_CHAR_ID = null;
let ACTIVE_TAB = 'story';
let draftChar = null;
let realtimeChannel = null;
let GM_PENDING = false;
let GM_ABORT = null;
let charGenMode = 'auto'; // 'auto' | 'manual'
let composerDraft = '';
let newItemDraft = '';
let notesDraft = null; // null = show the saved value; string = an unsaved in-progress edit
let appearanceDraft = null; // same idea, for the Sheet tab's Appearance box
let genderDraft = null;
let ageDraft = null;
let portraitPendingSince = 0; // when this browser last asked for a portrait (0 = not waiting)
let portraitBaseline = '';    // the character's portrait_updated_at at that moment
let portraitPoll = null;
let CHARGEN_PENDING = false;
let CHARGEN_ABORT = null;
let CHARGEN_ERROR = '';

const el = id => document.getElementById(id);
// Alphabet skips look-alikes (i, l, o, 0, 1). Index by its real length — it has 31 characters, and
// picking from 32 slots used to produce an empty character about 1 time in 32 (short codes/IDs).
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const uid = (n = 8) => Array.from({ length: n }, () => ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]).join('');
const roomCode = () => uid(8).toUpperCase(); // older rooms have 5-character codes; both work

/* ---------------- Android app + ink (the paywall) ----------------
   In the Android app (Capacitor) the pages are bundled inside the app, so server calls go to the
   live site (APP_API_BASE). Every device has a random player id: its "ink key". The server keeps the
   ink balance for that id (free allowance each month + ink bought on Google Play via RevenueCat). */
const IS_APP = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
const API_BASE = IS_APP ? String(cfg.APP_API_BASE || 'https://thedndledger.com').replace(/\/$/, '') : '';
const api = path => API_BASE + path;
const PLAYER_KEY = 'ledger:player';
const PLAYER_ID_RE = /^[a-z0-9]{16,40}$/;
let memoryPlayerId = '';
function newPlayerId() {
  const a = new Uint32Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, n => ID_ALPHABET[n % ID_ALPHABET.length]).join('');
}
function playerId() {
  try {
    let id = localStorage.getItem(PLAYER_KEY);
    if (!id || !PLAYER_ID_RE.test(id)) { id = newPlayerId(); localStorage.setItem(PLAYER_KEY, id); }
    return id;
  } catch (e) {
    return memoryPlayerId || (memoryPlayerId = newPlayerId());
  }
}

// Table hosts are stored as a hash of the ink key (rooms are readable by everyone at the table).
let MY_HASH = { key: '', hash: '' };
async function refreshMyHash() {
  const key = playerId();
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    MY_HASH = { key, hash: Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('') };
  } catch (e) { MY_HASH = { key, hash: '' }; }
  return MY_HASH.hash;
}
const myHostId = () => (MY_HASH.key === playerId() && MY_HASH.hash) || playerId();
const isMyHostId = v => !!v && (v === playerId() || (MY_HASH.key === playerId() && v === MY_HASH.hash));

// Opening the site with ?tester=1 tags every story this browser creates as a test (?tester=0 turns it off),
// so the owner's own test rooms can be told apart from real players' stories when counting.
try {
  const t = new URLSearchParams(location.search).get('tester');
  if (t === '1') localStorage.setItem('ledger:tester', '1');
  else if (t === '0') localStorage.removeItem('ledger:tester');
} catch (e) {}
function isTester() { try { return localStorage.getItem('ledger:tester') === '1'; } catch (e) { return false; } }

function checkConfigured() {
  if (!supabase) {
    el('app').innerHTML = `
      <div class="panel" style="max-width:560px;margin:80px auto;">
        <div class="eyebrow">Setup Needed</div>
        <h2>Supabase isn't configured yet</h2>
        <p class="helptext">Copy <code>public/config.example.js</code> to <code>public/config.js</code> and fill in your Supabase project URL and anon key. See the README for the full setup steps.</p>
      </div>`;
    return false;
  }
  return true;
}

/* ---------------- Capacity limits ---------------- */
const MAX_PLAYERS_PER_ROOM = 6;
const MAX_TOTAL_ROOMS = 20;

/* ---------------- Supabase helpers ---------------- */
async function dbGetRoom(code) {
  const { data, error } = await supabase.from('rooms').select('*').eq('code', code).maybeSingle();
  if (error) { console.error(error); return null; }
  return data;
}
async function dbCountRooms() {
  const { count, error } = await supabase.from('rooms').select('code', { count: 'exact', head: true });
  if (error) { console.error(error); return 0; }
  return count || 0;
}
// Guest tables are capped site-wide; the database removes the least recently played guest table to make
// space (supabase/accounts.sql, make_room_space). Account tables are never removed for space.
async function dbEvictOldestRoomIfAtCapacity() {
  const { error } = await supabase.rpc('make_room_space');
  if (error) console.error(error);
}
async function dbInsertRoom(code, mode, meta) {
  const { error } = await supabase.from('rooms').insert({ code, mode, meta });
  if (error) console.error(error);
}
async function dbUpdateRoomMeta(code, meta) {
  const { error } = await supabase.from('rooms').update({ meta }).eq('code', code);
  if (error) console.error(error);
}
async function dbGetCharacters(code) {
  const { data, error } = await supabase.from('characters').select('*').eq('room_code', code);
  if (error) { console.error(error); return []; }
  return data;
}
// Portrait info lives in dedicated columns (the portrait function writes them), so it must
// never be copied back into the character's data blob.
function stripPortraitFields(data) {
  const { portrait, portraitStatus, portraitAt, ...clean } = data || {};
  return clean;
}
async function dbUpsertCharacter(id, roomCode, data) {
  const { error } = await supabase.from('characters').upsert({ id, room_code: roomCode, data: stripPortraitFields(data) });
  if (error) console.error(error);
}
async function dbGetLog(code) {
  const { data, error } = await supabase.from('log_entries').select('*').eq('room_code', code).order('created_at', { ascending: true });
  if (error) { console.error(error); return []; }
  return data;
}
async function dbInsertLog(code, entry) {
  const { error } = await supabase.from('log_entries').insert({
    id: entry.id, room_code: code, author: entry.author, type: entry.type, text: entry.text
  });
  if (error) console.error(error);
}

function rosterFromRows(rows) {
  const out = {};
  rows.forEach(r => { out[r.id] = { ...r.data, portrait: r.portrait_url || null, portraitStatus: r.portrait_status || '', portraitAt: r.portrait_updated_at || '' }; });
  return out;
}
function logFromRows(rows) {
  return rows.map(r => ({ id: r.id, ts: new Date(r.created_at).getTime(), author: r.author, type: r.type, text: r.text }));
}

/* ---------------- Realtime ---------------- */
function subscribeRealtime(code) {
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  realtimeChannel = supabase.channel(`room-${code}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'log_entries', filter: `room_code=eq.${code}` }, async () => {
      LOG = logFromRows(await dbGetLog(code));
      if (VIEW === 'game') render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'characters', filter: `room_code=eq.${code}` }, async () => {
      ROSTER = rosterFromRows(await dbGetCharacters(code));
      if (VIEW === 'game') render();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `code=eq.${code}` }, async () => {
      const r = await dbGetRoom(code);
      if (!r) return;
      const strip = m => JSON.stringify({ ...(m || {}), grid: null });
      const onlyMap = strip(META) === strip(r.meta);
      META = r.meta;
      SCENE = sceneFromRow(r);
      if (VIEW !== 'game') return;
      if (onlyMap && ACTIVE_TAB !== 'map') {
        const tab = document.querySelector('.tab[onclick="setTab(\'map\')"]');
        if (tab) tab.textContent = mapState() ? 'Battle Map ⚔' : 'Battle Map';
        return;
      }
      render();
    })
    .subscribe();
}

/* ---------------- Local persistence (real browser, real localStorage) ---------------- */
function rememberCharacter(code, charId) {
  try { localStorage.setItem(`ledger:${code}`, JSON.stringify({ characterId: charId })); } catch (e) {}
  if (ROOM_INFO && ROOM_INFO.kind === 'account' && code === ROOM && supabase && supabase.rpc) {
    supabase.rpc('claim_seat', { p_room: code, p_character: charId }).then(() => {}, () => {});
  }
}
function recallCharacter(code) {
  try { const raw = localStorage.getItem(`ledger:${code}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
// The table this device is sitting at right now, so a tapped NFC mini (which opens a fresh page) knows where to go.
const CURRENT_ROOM_KEY = 'ledger:currentRoom';
function rememberCurrentRoom(code) { try { localStorage.setItem(CURRENT_ROOM_KEY, code); } catch (e) {} }
function forgetCurrentRoom() { try { localStorage.removeItem(CURRENT_ROOM_KEY); } catch (e) {} }
function recallCurrentRoom() { try { return localStorage.getItem(CURRENT_ROOM_KEY) || ''; } catch (e) { return ''; } }

function render() {
  renderView();
  const app = el('app');
  if (app) app.insertAdjacentHTML('beforeend', feedbackFooterHTML());
  renderFeedbackFab();
}
function renderView() {
  if (VIEW === 'landing') return renderLanding();
  if (VIEW === 'modepick') return renderModePick();
  if (VIEW === 'create') return renderCreate();
  if (VIEW === 'join') return renderJoin();
  if (VIEW === 'charsetup') return renderCharSetup();
  if (VIEW === 'game') return renderGame();
  if (VIEW === 'tag') return renderTag();
  if (VIEW === 'minis') return renderMinis();
  if (VIEW === 'account') return renderAccount();
}

/* ---------------- Feedback / contact / support ---------------- */
let CONTACT_EMAIL = (cfg.CONTACT_EMAIL || '').trim(); // config.js value is the fallback; the SUPPORT_EMAIL Netlify variable wins (see loadSiteConfig)
// Google Play doesn't allow links to outside payments (tips included) inside the app, so it's web-only.
const SUPPORT_URL = IS_APP ? '' : (cfg.SUPPORT_URL || '').trim();
const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The support email lives in a Netlify environment variable; ask the site-config function for it.
// Any failure (offline, local file preview) just keeps the config.js address.
async function loadSiteConfig() {
  try {
    const resp = await fetch(api('/api/site-config'));
    if (!resp.ok) return;
    const conf = await resp.json();
    SITE = { sceneImages: conf.sceneImages === true, sceneMax: parseInt(conf.sceneMaxPerRoom) || 3, sceneInk: parseInt(conf.sceneInk) || 0 };
    if (VIEW === 'game' && (ACTIVE_TAB === 'map' || ACTIVE_TAB === 'help')) render();
    const email = String(conf.supportEmail || '').trim();
    if (!email || email === CONTACT_EMAIL) return;
    CONTACT_EMAIL = email;
    const app = el('app');
    if (app) { app.querySelectorAll('.footer-contact').forEach(n => n.remove()); app.insertAdjacentHTML('beforeend', feedbackFooterHTML()); }
    renderFeedbackFab();
    if (VIEW === 'game' && ACTIVE_TAB === 'help') renderHelpTab();
  } catch (e) { /* keep the fallback */ }
}

function feedbackMailto() {
  const screens = { landing: 'Home', modepick: 'Mode select', create: 'Create campaign', join: 'Join with code', charsetup: 'Character setup', game: 'In game (' + ACTIVE_TAB + ' tab)' };
  const lines = ['(Describe the bug or suggestion here)', '', '', '---', 'Screen: ' + (screens[VIEW] || VIEW)];
  if (ROOM) lines.push('Room code: ' + ROOM);
  if (META && META.name) lines.push('Campaign: ' + META.name);
  lines.push('Browser: ' + navigator.userAgent);
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('The Ledger feedback')}&body=${encodeURIComponent(lines.join('\n'))}`;
}
function renderFeedbackFab() {
  let fab = el('feedbackFab');
  if (!CONTACT_EMAIL) { if (fab) fab.remove(); return; }
  if (!fab) {
    fab = document.createElement('a');
    fab.id = 'feedbackFab';
    fab.className = 'feedback-fab';
    fab.textContent = '✉ Feedback';
    document.body.appendChild(fab);
  }
  fab.href = feedbackMailto();
}
function feedbackFooterHTML() {
  const parts = [];
  if (CONTACT_EMAIL) parts.push(`Found a bug or have a suggestion? <a href="${escapeAttr(feedbackMailto())}">Email ${escapeAttr(CONTACT_EMAIL)}</a>`);
  if (SUPPORT_URL) parts.push(`Enjoying The Ledger? <a href="${escapeAttr(SUPPORT_URL)}" target="_blank" rel="noopener">Buy me a coffee ☕</a>`);
  parts.push(`<a href="changelog.html#credits">Credits &amp; licenses</a>`);
  return `<div class="footer-contact">${parts.join(' &middot; ')}</div>`;
}
function feedbackBoxHTML() {
  if (!CONTACT_EMAIL && !SUPPORT_URL) return '';
  return `<div class="feedback-box">
    <h3>Feedback</h3>
    ${CONTACT_EMAIL ? `<p class="helptext">Something broken, confusing, or missing? Send a note — it pre-fills which screen and room you were on.</p><a class="btn" href="${escapeAttr(feedbackMailto())}">Email feedback</a>` : ''}
    ${SUPPORT_URL ? `<p class="helptext" style="margin-top:${CONTACT_EMAIL ? '16px' : '0'};">Enjoying the game? Consider supporting the project.</p><a class="btn rust" href="${escapeAttr(SUPPORT_URL)}" target="_blank" rel="noopener">Buy me a coffee ☕</a>` : ''}
  </div>`;
}

/* ---------------- LANDING ---------------- */
function renderLanding() {
  el('app').innerHTML = `
    <div class="landing">
      <svg class="lantern" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path d="M32 24 C24 20 14 20 7 23 L7 49 C14 46 24 46 32 50 C40 46 50 46 57 49 L57 23 C50 20 40 20 32 24 Z" fill="rgba(217,180,90,0.14)" stroke="#d9b45a" stroke-width="2" stroke-linejoin="round"/>
        <line x1="32" y1="24" x2="32" y2="50" stroke="#d9b45a" stroke-width="2"/>
        <path d="M12 29 C18 27 25 27 28 29 M12 35 C18 33 25 33 28 35 M12 41 C18 39 25 39 28 41 M36 29 C39 27 46 27 52 29 M36 35 C39 33 46 33 52 35 M36 41 C39 39 46 39 52 41" stroke="#d9b45a" stroke-width="1.2" opacity="0.6" stroke-linecap="round"/>
        <path d="M32 4 L34.4 11 L41.5 11.4 L36 15.8 L38 22.5 L32 18.6 L26 22.5 L28 15.8 L22.5 11.4 L29.6 11 Z" fill="#d9b45a"/>
      </svg>
      <div class="eyebrow">Remote Tabletop</div>
      <h1>The Ledger</h1>
      <p class="sub">A shared table for you and your party, or a story just for you — either way, a tireless Game Master keeps the tale moving.</p>
      <div class="choice-row">
        <div class="choice-card">
          <h3>Play Solo</h3>
          <p>Run your own character through an AI-narrated storyline. No party, no waiting on anyone else.</p>
          <button class="btn solid wide" onclick="startNewCampaign('solo')">Start Solo Story</button>
        </div>
        <div class="choice-card">
          <h3>Break Ground</h3>
          <p>Start a brand new group campaign — any genre, any world. Invite your table with a room code.</p>
          <button class="btn solid wide" onclick="startNewCampaign('group')">New Group Campaign</button>
        </div>
        <div class="choice-card">
          <h3>Enter the Hollow</h3>
          <p>Got a room code from a friend, or the code from a solo story you paused? Enter it to join the table or pick your story back up.</p>
          <button class="btn wide" onclick="goToJoin()">Join or Resume with Code</button>
        </div>
      </div>
      ${isTester() ? '<p class="helptext" style="text-align:center;">Tester mode is on: stories you create in this browser are tagged as tests.</p>' : ''}
      ${pausedNote()}
      ${ACCT.msg && !ACCT.merge ? `<p class="${ACCT.ok ? 'hero-note' : 'error-text'}" style="text-align:center;">${escapeHtml(ACCT.msg)}</p>` : ''}
      ${myTablesHTML()}
      ${accountChipHTML()}
      ${whatsNewHTML()}
    </div>
  `;
}
function whatsNewHTML() {
  const items = (window.LEDGER_CHANGELOG || []).slice(0, 3);
  if (!items.length) return '';
  return `
    <details class="whats-new">
      <summary>What's New — ${escapeHtml(items[0].title)}</summary>
      <div class="whats-new-body">
        ${items.map(i => `
          <div class="changelog-entry">
            <div class="changelog-entry-title">
              <span class="badge ${i.type === 'fix' ? 'rust' : ''}">${i.type === 'fix' ? 'Fix' : 'Feature'}</span>
              ${escapeHtml(i.title)}
              <span class="changelog-date">${escapeHtml(i.date)}</span>
            </div>
            <p class="changelog-entry-detail">${escapeHtml(i.detail)}</p>
          </div>`).join('')}
        <a class="link-btn" href="changelog.html">See the full changelog &amp; roadmap &rarr;</a>
      </div>
    </details>`;
}
function startNewCampaign(mode) { pausedStory = null; MODE = mode; VIEW = 'create'; render(); }
function goToJoin() { VIEW = 'join'; render(); }
function goToLanding() {
  if (draftChar && draftChar.heroTag) draftChar = null; // a mini's hero shouldn't prefill the next, unrelated campaign
  VIEW = 'landing'; render();
}

/* ---------------- CREATE CAMPAIGN ---------------- */
let createDraft = { name: '', length: 'arc', ruleset: '5e2014', tone: '', seed: '', seedMode: 'blank' };

function renderCreate() {
  const lengths = MODE === 'solo'
    ? [
        { k: 'oneshot', t: 'One-Shot', d: 'A single sitting, wrapped tonight' },
        { k: 'arc', t: 'Short Arc', d: 'A handful of sessions, one contained story' },
        { k: 'long', t: 'Ongoing', d: 'Open-ended, keep coming back to it' },
      ]
    : [
        { k: 'oneshot', t: 'One-Shot', d: 'A single sitting, wrapped tonight' },
        { k: 'arc', t: 'Short Arc', d: '3–5 sessions, one contained story' },
        { k: 'long', t: 'Long Campaign', d: 'Open-ended, builds over months' },
      ];
  el('app').innerHTML = `
    <div class="top-nav"><button class="link-btn" onclick="goToLanding()">&larr; Back</button></div>
    <div class="panel" style="max-width:640px;margin:0 auto;">
      <div class="eyebrow">${MODE === 'solo' ? 'New Solo Story' : 'New Group Campaign'}</div>
      <h2>${MODE === 'solo' ? 'Play Solo' : 'Break Ground'}</h2>

      <div class="field">
        <label>${MODE === 'solo' ? 'Story Title' : 'Campaign Name'}</label>
        <input type="text" id="cname" placeholder="e.g. The Last Tide, Ashwood Reach, Nine of Cups..." value="${escapeAttr(createDraft.name)}" oninput="setCreateName(this.value)">
      </div>

      <div class="field">
        <label>Length</label>
        <div class="radio-grid" id="lengthGrid">
          ${lengths.map(l => `<div class="radio-card ${createDraft.length === l.k ? 'active' : ''}" onclick="setLen('${l.k}')"><b>${l.t}</b><span>${l.d}</span></div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Ruleset</label>
        <select id="ruleset" onchange="setCreateRuleset(this.value)">
          <option value="5e2014" ${createDraft.ruleset === '5e2014' ? 'selected' : ''}>5e (2014 rules, SRD 5.1)</option>
          <option value="5e2024" ${createDraft.ruleset === '5e2024' ? 'selected' : ''}>5e (2024 rules, SRD 5.2)</option>
          <option value="loose" ${createDraft.ruleset === 'loose' ? 'selected' : ''}>Loose narrative (light rules, GM's judgment)</option>
        </select>
      </div>

      <div class="field">
        <label>Genre / Tone</label>
        <input type="text" id="tone" placeholder="e.g. dark survival horror, swashbuckling heist, cozy village mystery..." value="${escapeAttr(createDraft.tone)}" oninput="setCreateTone(this.value)">
      </div>

      <div class="field">
        <label>Opening Story Seed</label>
        <div class="radio-grid" style="margin-bottom:10px;">
          <div class="radio-card ${createDraft.seedMode === 'blank' ? 'active' : ''}" onclick="setSeedMode('blank')"><b>Let the GM invent it</b><span>Fresh hook from your genre/tone</span></div>
          <div class="radio-card ${createDraft.seedMode === 'custom' ? 'active' : ''}" onclick="setSeedMode('custom')"><b>I'll write it</b><span>Bring your own premise</span></div>
        </div>
        ${createDraft.seedMode === 'custom' ? `<textarea id="seed" placeholder="Describe the opening situation, setting, and hook..." oninput="setCreateSeed(this.value)">${escapeAttr(createDraft.seed)}</textarea>` : `<p class="helptext">Leave this — once you continue, the GM will generate an opening scene from the genre and tone above.</p>`}
      </div>

      <p class="helptext">${signedIn() ? 'This will be a private table on your account: only players you invite with its code can see it.' : 'Guest tables are open to anyone with the code, and can be removed when space is needed. <button class="link-btn" onclick="openAccount()">Sign in</button> to make a private table.'}</p>
      <button class="btn solid wide" onclick="submitCreate()">${MODE === 'solo' ? 'Create My Story' : 'Create Room'}</button>
    </div>
  `;
}
function setLen(k) { createDraft.length = k; renderCreate(); }
function setSeedMode(m) { createDraft.seedMode = m; renderCreate(); }
function setCreateName(v) { createDraft.name = v; }
function setCreateTone(v) { createDraft.tone = v; }
function setCreateSeed(v) { createDraft.seed = v; }
function setCreateRuleset(v) { createDraft.ruleset = v; }

let CREATE_PENDING = false;
async function submitCreate() {
  if (CREATE_PENDING) return; // guards against a double-click firing two inserts
  CREATE_PENDING = true;
  try {
    createDraft.name = el('cname').value.trim() || (MODE === 'solo' ? 'Untitled Story' : 'Untitled Campaign');
    createDraft.ruleset = el('ruleset').value;
    createDraft.tone = el('tone').value.trim();
    if (createDraft.seedMode === 'custom') createDraft.seed = el('seed').value.trim();

    const code = roomCode();
    META = {
      name: createDraft.name,
      length: createDraft.length,
      ruleset: createDraft.ruleset,
      tone: createDraft.tone,
      seed: createDraft.seed,
      seedMode: createDraft.seedMode,
      session: 1,
      created: Date.now(),
      openingGenerated: false,
      host: myHostId(),
      ...(isTester() ? { tester: true } : {})
    };
    if (signedIn()) {
      const { data: r, error } = await supabase.rpc('create_account_room', { p_mode: MODE, p_meta: META });
      if (error || !r || !r.ok) { alert("The table couldn't be made just now. Try again in a moment."); return; }
      ROOM = r.room;
      ROOM_INFO = { kind: 'account', join_code: r.join_code, allow_guests: true, role: 'host', archived: false };
      TABLES = null;
      ACCT.notice = r.archived && r.archived.length ? 'To make room, the table you played least recently was archived. Restore it from My tables.' : '';
    } else {
      ROOM = code;
      ROOM_INFO = { kind: 'guest' };
      await dbEvictOldestRoomIfAtCapacity();
      await dbInsertRoom(code, MODE, META);
    }
    VIEW = 'charsetup';
    render();
  } finally {
    CREATE_PENDING = false;
  }
}

/* ---------------- JOIN (group mode only) ---------------- */
function renderJoin() {
  el('app').innerHTML = `
    <div class="top-nav"><button class="link-btn" onclick="goToLanding()">&larr; Back</button></div>
    <div class="panel" style="max-width:480px;margin:0 auto;">
      <div class="eyebrow">Join or Resume</div>
      <h2>Enter the Hollow</h2>
      <div class="field">
        <label>Room Code (a friend's, or the story code from a solo story you paused)</label>
        <input type="text" id="joinCode" placeholder="e.g. F3K9M" style="text-transform:uppercase;letter-spacing:0.1em;">
      </div>
      <div id="joinErr" class="error-text"></div>
      <button class="btn solid wide" onclick="submitJoin()">Continue</button>
    </div>
  `;
}
// Opens an existing room by code: a friend's table, or a solo story you paused. Returns an error message, or '' on success.
async function enterRoom(code) {
  const notFound = "No campaign found with that code — double-check it with whoever created the room, or use the code shown when you paused.";
  let room = await dbGetRoom(code);
  if (!room) {
    const j = await joinByCode(code); // an account table's join code (or a table that was saved to an account)
    if (j.error) return j.error;
    if (!j.room) return notFound;
    code = j.room;
    room = await dbGetRoom(code);
    if (!room) return notFound;
  }
  ROOM_INFO = room.kind === 'account' ? await dbRoomInfo(code) : { kind: 'guest' };
  ROOM = code; META = room.meta; MODE = room.mode || 'group'; SCENE = sceneFromRow(room);
  ROSTER = rosterFromRows(await dbGetCharacters(code));
  LOG = logFromRows(await dbGetLog(code));
  let mine = recallCharacter(code);
  if (!(mine && ROSTER[mine.characterId]) && ROOM_INFO.character_id && ROSTER[ROOM_INFO.character_id]) {
    mine = { characterId: ROOM_INFO.character_id }; // your hero at an account table, from any device
    rememberCharacter(code, mine.characterId);
  }
  // A solo story has exactly one character, so resuming from a new device (no saved link) picks it back up.
  if (!(mine && ROSTER[mine.characterId]) && MODE === 'solo' && Object.keys(ROSTER).length === 1) {
    mine = { characterId: Object.keys(ROSTER)[0] };
    rememberCharacter(code, mine.characterId);
  }
  pausedStory = null;
  if (mine && ROSTER[mine.characterId]) {
    MY_CHAR_ID = mine.characterId;
    if (normalizeInventory(ROSTER[MY_CHAR_ID])) dbUpsertCharacter(MY_CHAR_ID, code, ROSTER[MY_CHAR_ID]);
    rememberCurrentRoom(code);
    VIEW = 'game'; subscribeRealtime(code); render();
  } else {
    VIEW = 'charsetup'; render();
  }
  return '';
}
async function submitJoin() {
  const code = el('joinCode').value.trim().toUpperCase();
  if (!code) return;
  const err = await enterRoom(code);
  if (err) el('joinErr').innerText = err;
}
async function resumeStory(code) {
  const err = await enterRoom(code);
  if (err && pausedStory) { pausedStory.error = err; render(); }
}

/* ---------------- CHARACTER SETUP ---------------- */
function blankChar() {
  return {
    player: '', name: '', race: '', klass: '', level: 1, hp: 10, maxhp: 10, ac: 10,
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    skills: [{ name: '', mod: 0 }], inventory: [''], spells: [], notes: '', appearance: '', gender: '', age: ''
  };
}
function abilityMod(score) { return Math.floor(((score ?? 10) - 10) / 2); }
function fmtMod(n) { return (n >= 0 ? '+' : '') + n; }
function passivePerception(c) { return 10 + abilityMod(c.wis); }
function initiativeBonus(c) { return abilityMod(c.dex); }
function renderCharSetup() {
  if (!draftChar) { draftChar = blankChar(); charGenMode = 'auto'; CHARGEN_ERROR = ''; }
  const d = draftChar;
  if (d.heroTag) return renderHeroSetup(d); // a hero from a mini: its sheet is locked, only the player's name is typed
  el('app').innerHTML = `
    <div class="top-nav">
      ${codeBadge()}
      <div style="display:flex;gap:14px;align-items:center;">
        <button class="link-btn" onclick="copyCode()">${MODE === 'solo' ? 'Copy story code' : 'Copy invite code'}</button>
        <button class="link-btn" onclick="${MODE === 'solo' ? 'pauseStory()' : 'leaveTable()'}">${MODE === 'solo' ? 'Pause' : 'Leave'}</button>
      </div>
    </div>
    <div class="panel" style="max-width:680px;margin:0 auto;">
      <div class="eyebrow">Build Your Character</div>
      <h2>${escapeHtml(META.name)}</h2>
      <p class="helptext">${META.ruleset === 'loose' ? 'Loose narrative mode — modifiers are approximate, the GM will use judgment.' : 'Enter your skill modifiers as already-calculated numbers. <code style="color:var(--glow)">/roll +5</code> rolls a d20+5; <code style="color:var(--glow)">/roll 2d6+3</code> rolls any other dice, like damage.'}</p>

      <div class="field"><label>Your Name (player)</label><input type="text" id="pName" value="${escapeAttr(d.player)}" oninput="setDraftField('player', this.value)"></div>
      <div class="field"><label>Character Name</label><input type="text" id="cCharName" value="${escapeAttr(d.name)}" oninput="setDraftField('name', this.value)"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:end;">
        <div class="field"><label>Gender (optional)</label><input type="text" id="cGender" maxlength="30" placeholder="e.g. female, male, nonbinary" value="${escapeAttr(d.gender || '')}" oninput="setDraftField('gender', this.value)"></div>
        <div class="field"><label>Age (optional)</label><input type="text" id="cAge" maxlength="20" placeholder="e.g. 34, or ancient" value="${escapeAttr(d.age || '')}" oninput="setDraftField('age', this.value)"></div>
      </div>
      <div class="field"><label>Appearance (optional — used to paint your portrait)</label><textarea id="cAppearance" maxlength="500" placeholder="e.g. Tall and wiry, silver hair, a scar over one eye, patched green cloak" oninput="setDraftField('appearance', this.value)">${escapeAttr(d.appearance || '')}</textarea></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:end;">
        <div class="field"><label>Race / Species</label>${pickListHTML('cRace', 'race', SRD_RACES, d.race, true)}</div>
        <div class="field"><label>Class</label>${pickListHTML('cClass', 'klass', SRD_CLASSES, d.klass, true)}</div>
      </div>

      <div class="field">
        <label>Character Creation</label>
        <div class="radio-grid" style="margin-bottom:10px;">
          <div class="radio-card ${charGenMode === 'auto' ? 'active' : ''}" onclick="setCharGenMode('auto')"><b>Let the GM build it</b><span>Auto-fills ability scores, HP/AC, skills &amp; starting gear for your class and campaign</span></div>
          <div class="radio-card ${charGenMode === 'manual' ? 'active' : ''}" onclick="setCharGenMode('manual')"><b>I'll roll my own</b><span>Enter everything yourself below</span></div>
        </div>
        ${charGenMode === 'auto' ? (CHARGEN_PENDING
          ? `<div class="gm-pending"><span class="thinking">The GM is building your character<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span><button class="btn rust" onclick="cancelCharGen()">Cancel</button></div>`
          : `<button class="btn" onclick="generateCharacter()">${d.__generated ? 'Regenerate Character' : 'Generate Character'}</button>
             <p class="helptext" style="margin-top:6px;">Everything below is generated for you and fully editable — review it before you begin.</p>`
        ) : ''}
        ${CHARGEN_ERROR ? `<div class="error-text" style="margin-top:8px;">${escapeHtml(CHARGEN_ERROR)}</div>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;">
        <div class="field"><label>Level</label><input type="text" id="cLevel" value="${escapeAttr(d.level)}" oninput="setDraftField('level', this.value)"></div>
        <div class="field"><label>Max HP</label><input type="text" id="cMaxHP" value="${escapeAttr(d.maxhp)}" oninput="setDraftField('maxhp', this.value)"></div>
        <div class="field"><label>AC</label><input type="text" id="cAC" value="${escapeAttr(d.ac)}" oninput="setDraftField('ac', this.value)"></div>
      </div>

      <div class="field">
        <label>Ability Scores</label>
        <div class="ability-grid">
          <div><label>STR</label><input type="text" id="cSTR" value="${escapeAttr(d.str)}" oninput="setDraftField('str', this.value)"></div>
          <div><label>DEX</label><input type="text" id="cDEX" value="${escapeAttr(d.dex)}" oninput="setDraftField('dex', this.value)"></div>
          <div><label>CON</label><input type="text" id="cCON" value="${escapeAttr(d.con)}" oninput="setDraftField('con', this.value)"></div>
          <div><label>INT</label><input type="text" id="cINT" value="${escapeAttr(d.int)}" oninput="setDraftField('int', this.value)"></div>
          <div><label>WIS</label><input type="text" id="cWIS" value="${escapeAttr(d.wis)}" oninput="setDraftField('wis', this.value)"></div>
          <div><label>CHA</label><input type="text" id="cCHA" value="${escapeAttr(d.cha)}" oninput="setDraftField('cha', this.value)"></div>
        </div>
        <p class="helptext">Passive Perception and Initiative are calculated from these automatically.</p>
      </div>

      <div class="field skills-editor">
        <label>Skills &amp; Modifiers (pre-calculated — e.g. Stealth +7)</label>
        <div id="skillRows"></div>
        <button class="add-row" onclick="addSkillRow()">+ add skill</button>
      </div>

      <div class="field skills-editor">
        <label>Starting Inventory</label>
        <div id="invRows"></div>
        <button class="add-row" onclick="addInvRow()">+ add item</button>
      </div>

      <div class="field"><label>Notes / Backstory (optional)</label><textarea id="cNotes" oninput="setDraftField('notes', this.value)">${escapeAttr(d.notes)}</textarea></div>

      <p class="helptext">Anything you leave blank (name, race, class, looks, backstory, skills, gear) the GM fills in when you ${MODE === 'solo' ? 'begin' : 'join'}.</p>
      <div id="charErr" class="error-text"></div>
      <button class="btn solid wide" onclick="submitCharacter()">${MODE === 'solo' ? 'Begin' : 'Join the Table'}</button>
    </div>
  `;
  renderSkillRows(); renderInvRows();
}
function renderSkillRows() {
  el('skillRows').innerHTML = draftChar.skills.map((s, i) => `
    <div class="skill-row">
      <input type="text" placeholder="Skill name" value="${escapeAttr(s.name)}" oninput="setSkillName(${i}, this.value)">
      <input type="number" placeholder="+0" value="${escapeAttr(s.mod)}" oninput="setSkillMod(${i}, this.value)">
      <button class="remove-x" onclick="removeSkillRow(${i})">&times;</button>
    </div>`).join('');
}
function addSkillRow() { draftChar.skills.push({ name: '', mod: 0 }); renderSkillRows(); }
function removeSkillRow(i) { draftChar.skills.splice(i, 1); renderSkillRows(); }
function setDraftField(field, val) { if (draftChar) draftChar[field] = val; }
// SRD 5.1 races and classes for character creation. "Something else…" keeps any genre playable
// (a custom class simply has no SRD spells or class features).
const SRD_RACES = ['Dragonborn', 'Dwarf (Hill)', 'Elf (High)', 'Gnome (Rock)', 'Half-Elf', 'Half-Orc', 'Halfling (Lightfoot)', 'Human', 'Tiefling'];
const SRD_CLASSES = ['Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk', 'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard'];
const listBase = v => String(v || '').replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase();
// Matches free text ("elf", "High Elf", "Halfling (Stout)") to a list entry, or returns it unchanged.
function toListEntry(v, list) {
  const s = String(v || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  return list.find(x => x.toLowerCase() === low) || list.find(x => listBase(x) === listBase(s))
    || [...list].sort((a, b) => listBase(b).length - listBase(a).length).find(x => new RegExp('\\b' + listBase(x).replace(/[^a-z-]/g, '').replace(/-/g, '[- ]?') + '\\b').test(low)) || s;
}
function pickListHTML(id, field, list, value, optional) {
  const v = toListEntry(value, list);
  const custom = v && !list.includes(v);
  return `<select id="${id}" onchange="pickListChange(this, '${field}')">
    ${optional ? `<option value="" ${v ? '' : 'selected'}>Let the GM choose</option>` : `<option value="" disabled ${v ? '' : 'selected'}>Choose…</option>`}
    ${list.map(x => `<option ${x === v ? 'selected' : ''}>${escapeHtml(x)}</option>`).join('')}
    ${custom ? `<option selected>${escapeHtml(v)}</option>` : ''}
    <option value="__other">Something else…</option>
  </select>`;
}
function pickListChange(sel, field) {
  if (sel.value === '__other') {
    const typed = (prompt(field === 'race' ? 'Type a race or species:' : 'Type a class:') || '').trim().slice(0, 40);
    if (!typed) { sel.value = (draftChar && draftChar[field]) || ''; return; }
    if (draftChar) draftChar[field] = typed;
    const o = document.createElement('option'); o.textContent = typed; o.selected = true;
    sel.insertBefore(o, sel.lastElementChild);
    return;
  }
  setDraftField(field, sel.value);
}
window.pickListChange = pickListChange;
function setSkillName(i, val) { draftChar.skills[i].name = val; }
function setSkillMod(i, val) { draftChar.skills[i].mod = parseInt(val || 0); }
function renderInvRows() {
  el('invRows').innerHTML = draftChar.inventory.map((it, i) => `
    <div class="skill-row">
      <input type="text" placeholder="Item" value="${escapeAttr(it)}" style="flex:1;" oninput="setInvItem(${i}, this.value)">
      <button class="remove-x" onclick="removeInvRow(${i})">&times;</button>
    </div>`).join('');
}
function setInvItem(i, val) { draftChar.inventory[i] = val; }
function addInvRow() { draftChar.inventory.push(''); renderInvRows(); }
function removeInvRow(i) { draftChar.inventory.splice(i, 1); renderInvRows(); }

function setCharGenMode(m) { charGenMode = m; CHARGEN_ERROR = ''; renderCharSetup(); }
function cancelCharGen() { if (CHARGEN_ABORT) CHARGEN_ABORT.abort(); }

function parseCharacterJSON(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error("The GM's response wasn't valid JSON.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Anything the player left blank is filled in by the AI GM when they create the character; everything
// they entered is kept exactly. A sheet whose numbers were never set (all 10s) counts as blank too.
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
function characterBlanks(d, statsBlank) {
  const blank = [];
  if (!d.name || d.name === 'Unnamed') blank.push('name');
  if (!d.race || d.race === '__other') blank.push('race');
  if (!d.klass || d.klass === '__other') blank.push('klass');
  for (const k of ['gender', 'age', 'appearance', 'notes']) if (!String(d[k] || '').trim()) blank.push(k);
  if (!(d.skills || []).length) blank.push('skills');
  if (!(d.inventory || []).length) blank.push('inventory');
  if (statsBlank) blank.push(...ABILITY_KEYS, 'maxhp', 'ac');
  return blank;
}
async function fillCharacterBlanks(d, blank) {
  const known = {};
  for (const k of ['name', 'race', 'klass', 'level', 'gender', 'age', 'appearance', 'notes', ...ABILITY_KEYS, 'maxhp', 'ac', 'skills', 'inventory']) {
    if (!blank.includes(k) && d[k] !== undefined && d[k] !== '') known[k] = d[k];
  }
  const prompt = `Fill in the blank parts of a level ${parseInt(d.level) || 1} tabletop RPG character for a ${MODE === 'solo' ? 'solo story' : 'campaign'} titled "${META.name}". Ruleset: ${META.ruleset}. Genre/tone: ${META.tone || 'unspecified, pick something fitting'}.
The player already chose these; keep them exactly and build the rest around them: ${JSON.stringify(known)}
Fill in ONLY these fields: ${blank.join(', ')}.
${blank.includes('race') ? `"race" must be exactly one of: ${SRD_RACES.join(', ')}.` : ''}
${blank.includes('klass') ? `"klass" must be exactly one of: ${SRD_CLASSES.join(', ')}.` : ''}
Respond with ONLY a single JSON object containing just those fields, no markdown code fences, no commentary. Field shapes: "name": a fitting character name; "gender": string; "age": string, e.g. "34"; "appearance": one or two sentences on how they look; "notes": a one or two sentence backstory hook; "skills": [{"name":"string","mod":0}], 3-5 class-appropriate skills with modifiers that match the ability scores; "inventory": ["string"], 4-8 starting items fitting the class and tone, giving counts for ammunition and coins (e.g. "Light crossbow with 20 bolts", "10 gold pieces"); "str".."cha": numbers using the standard array 15/14/13/12/10/8 fitted to the class; "maxhp": the class hit die plus the CON modifier for a level 1 character; "ac": a number fitting the starting armour.`;
  const p = parseCharacterJSON(await fetchGM(prompt));
  const num = (v, lo, hi) => { const n = parseInt(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null; };
  for (const k of blank) {
    const v = p[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'race') d.race = toListEntry(v, SRD_RACES);
    else if (k === 'klass') d.klass = toListEntry(v, SRD_CLASSES);
    else if (ABILITY_KEYS.includes(k)) { const n = num(v, 3, 20); if (n) d[k] = n; }
    else if (k === 'maxhp') { const n = num(v, 1, 300); if (n) { d.maxhp = n; d.hp = n; } }
    else if (k === 'ac') { const n = num(v, 5, 25); if (n) d.ac = n; }
    else if (k === 'skills' && Array.isArray(v)) d.skills = v.filter(x => x && x.name).slice(0, 8).map(x => ({ name: String(x.name).slice(0, 40), mod: num(x.mod, -5, 15) || 0 }));
    else if (k === 'inventory' && Array.isArray(v)) d.inventory = v.map(x => String(x).trim().slice(0, 80)).filter(Boolean).slice(0, 12);
    else if (typeof v === 'string' || typeof v === 'number') d[k] = String(v).slice(0, k === 'appearance' ? 500 : k === 'notes' ? 600 : k === 'name' ? 40 : 30);
  }
}

async function generateCharacter() {
  if (CHARGEN_PENDING) return;
  CHARGEN_PENDING = true;
  CHARGEN_ERROR = '';
  CHARGEN_ABORT = new AbortController();
  const raceHint = (el('cRace')?.value || '').trim();
  const classHint = (el('cClass')?.value || '').trim();
  const appearanceHint = (el('cAppearance')?.value || '').trim().slice(0, 500);
  const genderHint = (el('cGender')?.value || '').trim().slice(0, 30);
  const ageHint = (el('cAge')?.value || '').trim().slice(0, 20);
  renderCharSetup();

  const prompt = `Generate a complete tabletop RPG character sheet for a new level 1 character in a ${MODE === 'solo' ? 'solo story' : 'campaign'} titled "${META.name}". Ruleset: ${META.ruleset}. Genre/tone: ${META.tone || 'unspecified — pick something fitting'}.
${raceHint ? `The player wants a ${raceHint} character.` : `Choose a race that fits the tone from exactly this list: ${SRD_RACES.join(', ')}.`}
${classHint ? `The player wants to play a ${classHint}.` : `Choose a class that fits the tone from exactly this list: ${SRD_CLASSES.join(', ')}.`}
${genderHint ? `The character's gender is: ${genderHint}.` : ''}
${ageHint ? `The character's age is: ${ageHint}.` : ''}
${appearanceHint ? `The player describes their look as: ${appearanceHint}` : ''}

Respond with ONLY a single JSON object, no markdown code fences, no commentary, matching exactly this shape:
{"race":"string","klass":"string","str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10,"maxhp":10,"ac":10,"skills":[{"name":"string","mod":0}],"inventory":["string"],"notes":"one or two sentence backstory hook","appearance":"one or two sentences describing how the character looks","gender":"string","age":"string, e.g. 34"}

Use sensible 5e-appropriate ability scores for the class (e.g. the standard array 15/14/13/12/10/8 assigned to fit the class), a reasonable starting HP and AC for a level 1 character, 3-5 class-appropriate skills with realistic modifiers, and 4-8 pieces of starting gear specifically appropriate to that class and the campaign's tone — not generic fantasy-adventurer gear unless the tone calls for it.`;

  try {
    const text = await fetchGM(prompt, CHARGEN_ABORT.signal);
    const parsed = parseCharacterJSON(text);
    draftChar = {
      ...draftChar,
      race: raceHint || toListEntry(parsed.race, SRD_RACES) || draftChar.race,
      klass: classHint || toListEntry(parsed.klass, SRD_CLASSES) || draftChar.klass,
      str: parsed.str ?? draftChar.str,
      dex: parsed.dex ?? draftChar.dex,
      con: parsed.con ?? draftChar.con,
      int: parsed.int ?? draftChar.int,
      wis: parsed.wis ?? draftChar.wis,
      cha: parsed.cha ?? draftChar.cha,
      maxhp: parsed.maxhp ?? draftChar.maxhp,
      hp: parsed.maxhp ?? draftChar.maxhp,
      ac: parsed.ac ?? draftChar.ac,
      skills: Array.isArray(parsed.skills) && parsed.skills.length ? parsed.skills : draftChar.skills,
      inventory: Array.isArray(parsed.inventory) && parsed.inventory.length ? parsed.inventory : draftChar.inventory,
      notes: parsed.notes || draftChar.notes,
      appearance: (draftChar.appearance || '').trim() ? draftChar.appearance : String(parsed.appearance || '').slice(0, 500),
      gender: (draftChar.gender || '').trim() ? draftChar.gender : String(parsed.gender || '').slice(0, 30),
      age: (draftChar.age || '').trim() ? draftChar.age : String(parsed.age ?? '').slice(0, 20),
      __generated: true,
    };
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      CHARGEN_ERROR = `${e.outOfInk ? e.message : friendlyTrouble(e)} Or switch to "I'll roll my own."`;
    }
  } finally {
    CHARGEN_PENDING = false;
    CHARGEN_ABORT = null;
    if (VIEW === 'charsetup') renderCharSetup();
  }
}

let CHARSUBMIT_PENDING = false;
async function submitCharacter() {
  if (CHARSUBMIT_PENDING) return; // guards against a double-click firing two inserts
  CHARSUBMIT_PENDING = true;
  try {
    if (MODE === 'group') {
      const existing = await dbGetCharacters(ROOM);
      const alreadyMine = MY_CHAR_ID && existing.some(r => r.id === MY_CHAR_ID);
      if (!alreadyMine && existing.length >= MAX_PLAYERS_PER_ROOM) {
        el('charErr').innerText = `This table is full (max ${MAX_PLAYERS_PER_ROOM} players).`;
        return;
      }
    }
    el('charErr').innerText = '';
    if (draftChar.heroTag) {
      // A hero from a mini: rebuild the sheet from the tag as it was read, so nothing typed or
      // tweaked on this screen can change its stats. Only the player's own name comes from the form.
      const src = HERO_SOURCES[draftChar.heroTag];
      if (!src) { el('charErr').innerText = 'Tap your mini again to load this hero.'; return; }
      const player = (el('pName').value.trim() || 'Player').slice(0, 40);
      draftChar = { ...heroFromTag(draftChar.heroTag, src), player };
    } else {
    draftChar.player = el('pName').value.trim() || 'Player';
    draftChar.name = el('cCharName').value.trim() || 'Unnamed';
    draftChar.race = el('cRace').value.trim();
    draftChar.klass = el('cClass').value.trim();
    draftChar.level = parseInt(el('cLevel').value) || 1;
    draftChar.maxhp = parseInt(el('cMaxHP').value) || 10;
    draftChar.hp = draftChar.maxhp;
    draftChar.ac = parseInt(el('cAC').value) || 10;
    draftChar.str = parseInt(el('cSTR').value) || 10;
    draftChar.dex = parseInt(el('cDEX').value) || 10;
    draftChar.con = parseInt(el('cCON').value) || 10;
    draftChar.int = parseInt(el('cINT').value) || 10;
    draftChar.wis = parseInt(el('cWIS').value) || 10;
    draftChar.cha = parseInt(el('cCHA').value) || 10;
    draftChar.notes = el('cNotes').value.trim();
    draftChar.appearance = el('cAppearance').value.trim().slice(0, 500);
    draftChar.gender = el('cGender').value.trim().slice(0, 30);
    draftChar.age = el('cAge').value.trim().slice(0, 20);
    draftChar.skills = draftChar.skills.filter(s => s.name.trim());
    draftChar.inventory = draftChar.inventory.filter(i => i.trim());
    const statsBlank = !draftChar.__generated && ABILITY_KEYS.every(k => draftChar[k] === 10) && draftChar.maxhp === 10 && draftChar.ac === 10;
    const blank = characterBlanks(draftChar, statsBlank);
    if (blank.length) {
      el('charErr').innerHTML = '<span class="thinking">The GM is filling in the blanks…</span>';
      try { await fillCharacterBlanks(draftChar, blank); }
      catch (e) {
        console.error(e);
        if (characterBlanks(draftChar, false).some(k => k === 'race' || k === 'klass')) {
          el('charErr').innerText = `${e.outOfInk ? e.message : friendlyTrouble(e)} Or choose a race and a class yourself.`;
          return;
        }
      }
      el('charErr').innerText = '';
    }
    if (!draftChar.name || draftChar.name === '__other') draftChar.name = 'Unnamed';
    if (draftChar.race === '__other') draftChar.race = '';
    if (draftChar.klass === '__other') draftChar.klass = '';
    if (!(draftChar.handItems || []).length) normalizeInventory(draftChar);
    }

    draftChar.levelSession = (META && META.session) || 1;
    const charId = uid(10);
    await dbUpsertCharacter(charId, ROOM, draftChar);
    ROSTER[charId] = draftChar;
    rememberCharacter(ROOM, charId);
    rememberCurrentRoom(ROOM);
    MY_CHAR_ID = charId;
    draftChar = null;

    LOG = logFromRows(await dbGetLog(ROOM));
    const joinEntry = { id: uid(6), author: 'The Ledger', type: 'system', text: `${ROSTER[MY_CHAR_ID].name} (${ROSTER[MY_CHAR_ID].race || '?'} ${ROSTER[MY_CHAR_ID].klass || '?'}) has joined the table.` };
    await dbInsertLog(ROOM, joinEntry);
    LOG.push({ ...joinEntry, ts: Date.now() });

    VIEW = 'game'; ACTIVE_TAB = 'story';
    subscribeRealtime(ROOM);
    render();

    const room = await dbGetRoom(ROOM);
    if (room && !room.meta.openingGenerated) {
      META = { ...room.meta, openingGenerated: true };
      await dbUpdateRoomMeta(ROOM, META);
      generateOpening();
    }
  } finally {
    CHARSUBMIT_PENDING = false;
  }
}

function copyCode() {
  navigator.clipboard?.writeText(inviteCode());
  const b = event.target; const old = b.innerText; b.innerText = 'Copied!'; setTimeout(() => b.innerText = old, 1200);
}

// The story code is the room code: it is what lets you (or a friend) come back to the same room later.
function codeBadge() {
  return MODE === 'solo'
    ? `<span class="badge">Solo Story</span> <span class="badge">Story code <span class="room-code">${escapeHtml(inviteCode())}</span></span>${privacyBadge()}`
    : `<span class="badge">Room <span class="room-code">${escapeHtml(inviteCode())}</span></span>${privacyBadge()}`;
}
function privacyBadge() {
  if (!ROOM_INFO) return '';
  return ROOM_INFO.kind === 'account'
    ? ' <span class="badge" title="Only members can see this table">Private</span>'
    : ' <span class="badge" title="Guest tables are open to anyone with the code, and can be removed when space is needed. Sign in to make a private table.">Guest table</span>';
}
let pausedStory = null;   // { code, name, error? } shown on the landing page right after pausing
function pauseStory() {
  pausedStory = { code: inviteCode(), name: META.name };
  try { navigator.clipboard?.writeText(inviteCode()); } catch (e) {}
  leaveTable();
}
function pausedNote() {
  if (!pausedStory) return '';
  return `<div class="paused-note">
    <div><b>${escapeHtml(pausedStory.name)}</b> is paused and saved. To pick it up later, on any device, choose <i>Join or Resume with Code</i> and enter <span class="room-code">${escapeHtml(pausedStory.code)}</span>. Keep that code somewhere safe.${pausedStory.error ? `<div class="error-text">${escapeHtml(pausedStory.error)}</div>` : ''}</div>
    <button class="btn solid" onclick="resumeStory('${escapeAttr(pausedStory.code)}')">Resume now</button>
  </div>`;
}

function leaveTable() {
  saveHeroToMini(true);
  closeDiceRoll();
  stopPortraitPoll(); portraitPendingSince = 0; appearanceDraft = null; genderDraft = null; ageDraft = null;
  if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  if (GM_ABORT) GM_ABORT.abort();
  if (CHARGEN_ABORT) CHARGEN_ABORT.abort();
  forgetCurrentRoom();
  ROOM = null; META = null; ROSTER = {}; LOG = []; MY_CHAR_ID = null; draftChar = null; ROOM_INFO = null;
  MODE = 'group'; ACTIVE_TAB = 'story';
  VIEW = 'landing';
  if (signedIn()) { TABLES = null; loadTables(); }
  render();
}

/* ---------------- GAME SCREEN ---------------- */
const lengthLabel = { oneshot: 'One-Shot', arc: 'Short Arc', long: 'Long Campaign' };

function renderGame() {
  const tabs = MODE === 'solo'
    ? [['story', 'The Ledger (Story)'], ['notes', 'Field Notes'], ['map', mapState() ? 'Battle Map ⚔' : 'Battle Map'], ['sheet', 'Your Sheet'], ['help', 'How to Play']]
    : [['story', 'The Ledger (Story)'], ['notes', 'Field Notes'], ['map', mapState() ? 'Battle Map ⚔' : 'Battle Map'], ['party', 'The Party'], ['sheet', 'Your Sheet'], ['help', 'How to Play']];
  el('app').innerHTML = `
    <div class="game-header">
      <div>
        <h1>${escapeHtml(META.name)}</h1>
        ${codeBadge()}
        <span class="badge">${lengthLabel[META.length]}</span>
        <span class="badge">Session ${META.session}</span>
        ${inkBadgeHTML()}
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="copyCode()">${MODE === 'solo' ? 'Copy Story Code' : 'Copy Invite Code'}</button>
        ${tableButtonHTML()}
        <button class="btn rust" onclick="advanceSession()">Advance Session</button>
        ${MODE === 'solo' ? '<button class="btn" onclick="pauseStory()" title="Save your place and come back later with your story code">Pause Story</button>' : '<button class="btn" onclick="leaveTable()">Leave Table</button>'}
      </div>
    </div>
    <div class="tabs">
      ${tabs.map(([k, t]) => `<button class="tab ${ACTIVE_TAB === k ? 'active' : ''}" onclick="setTab('${k}')">${t}</button>`).join('')}
    </div>
    <div id="tabBody"></div>
  `;
  if (ACTIVE_TAB === 'story') renderStoryTab();
  else if (ACTIVE_TAB === 'map') renderMapTab();
  else if (ACTIVE_TAB === 'notes') renderNotesTab();
  else if (ACTIVE_TAB === 'party') renderPartyTab();
  else if (ACTIVE_TAB === 'sheet') renderSheetTab();
  else renderHelpTab();
}
function setTab(k) { ACTIVE_TAB = k; render(); }

async function advanceSession() {
  META.session = (META.session || 1) + 1;
  META.spellWindow = gmCount(); // casters may change their spells until the story moves on
  await dbUpdateRoomMeta(ROOM, META);
  const entry = { id: uid(6), author: 'The Ledger', type: 'system', text: `— Session ${META.session} begins —` };
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
  saveHeroToMini(true);
}

function renderStoryTab() {
  const body = el('tabBody');
  const sideHTML = MODE === 'group' ? `<div class="side-panel" id="rosterMini"></div>` : `<div class="side-panel">${sheetMiniHTML()}</div>`;
  const gmControlsHTML = GM_PENDING
    ? `<div class="gm-pending"><span class="thinking">The GM is thinking<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span><button class="btn rust" onclick="cancelGM()">Cancel</button></div>`
    : `<button class="btn" id="gmBtn" onclick="askGM()">Ask the GM to continue the story</button>`;
  body.innerHTML = `
    <div class="game-grid">
      <div>
        <div class="log" id="logBox">${LOG.filter(e => !heldLogIds.has(e.id)).map(entryHTML).join('') || '<p class="thinking">The story hasn&#39;t begun yet...</p>'}</div>
        <div class="composer">
          ${rollPickerHTML()}
          <input type="text" id="composerInput" placeholder="Type an action, say something in character, or use /roll +modifier..." value="${escapeAttr(composerDraft)}" oninput="setComposerDraft(this.value)" onkeydown="if(event.key==='Enter') submitAction()">
          <button class="btn solid" onclick="submitAction()">Send</button>
        </div>
        <div class="hint-bar">Pick a skill from <b>Roll from sheet</b> to fill in your modifier &middot; <code>/roll +5</code> rolls a d20+5 &middot; add <code>adv</code> or <code>dis</code> for advantage &middot; <code>/roll 2d6+3</code> for damage or any other dice &middot; plain text is narrated as your action.</div>
        <div class="desk-row" style="margin-top:12px;">
          ${gmControlsHTML}
        </div>
      </div>
      ${sideHTML}
    </div>
  `;
  if (MODE === 'group') renderRosterMini();
  placeLogScroll();
}
function abilityGridHTML(c) {
  const abilities = [['STR', c.str], ['DEX', c.dex], ['CON', c.con], ['INT', c.int], ['WIS', c.wis], ['CHA', c.cha]];
  return `<div class="stat-grid">${abilities.map(([k, v]) => `<div class="stat-chip"><span class="k">${k}</span><span class="v">${v ?? 10} (${fmtMod(abilityMod(v))})</span></div>`).join('')}</div>
    <div class="derived-row"><span><b>Passive Perception</b> ${passivePerception(c)}</span><span><b>Initiative</b> ${fmtMod(initiativeBonus(c))}</span></div>`;
}
function sheetMiniHTML() {
  const c = ROSTER[MY_CHAR_ID]; if (!c) return '';
  const pct = Math.max(0, Math.min(100, Math.round((c.hp / c.maxhp) * 100)));
  return `<div class="roster-card mine">
    ${portraitHeader(c, `<div class="rname"><b>${escapeHtml(c.name)}</b><span class="rclass">Lv${c.level} ${escapeHtml(c.race)} ${escapeHtml(c.klass)}</span></div>`)}
    <div class="hpbar"><div class="hpbar-fill ${pct < 30 ? 'low' : ''}" style="width:${pct}%"></div></div>
    <div class="hprow"><span>HP ${c.hp}/${c.maxhp}</span><span>AC ${c.ac}</span></div>
    ${deathSaveHTML(c)}
    ${spellCardHTML(c)}
    ${featureCardHTML(c)}
    ${abilityGridHTML(c)}
  </div>`;
}
/* ---------------- Class features (SRD 5.1) ----------------
   Limited-use features are counted on the character (c.featureUsed) and refilled by rests; the GM spends
   them with [[feature: <name> | <feature> | <amount or slot level> | <target>]] and the game refuses when
   none are left. Second Wind and Lay on Hands heal, Arcane Recovery restores slots, Divine Smite spends a
   spell slot and damages a foe. Always-on features (Sneak Attack, Martial Arts...) are shown for reference. */
function classOf(c) {
  const k = String((c && c.klass) || '').toLowerCase();
  return ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'].find(n => k.includes(n)) || '';
}
// [{ key, name, uses (null = no limit), pool (spend any amount), rest: 'short'|'long'|null, note }]
function featuresOf(c) {
  if (!c) return [];
  const L = Math.max(1, Math.min(20, parseInt(c.level) || 1));
  const cha = abilityMod(c.cha), wis = abilityMod(c.wis), prof = Math.ceil(L / 4) + 1;
  const f = [];
  const add = (key, name, uses, rest, note, pool) => f.push({ key, name, uses, rest, note, pool: !!pool });
  switch (classOf(c)) {
    case 'barbarian':
      add('rage', 'Rage', L >= 20 ? null : L >= 17 ? 6 : L >= 12 ? 5 : L >= 6 ? 4 : L >= 3 ? 3 : 2, 'long',
        `+${L >= 16 ? 4 : L >= 9 ? 3 : 2} melee damage, resistance to bludgeoning, piercing and slashing, advantage on Strength checks; 1 minute`);
      break;
    case 'bard': {
      const die = L >= 15 ? 'd12' : L >= 10 ? 'd10' : L >= 5 ? 'd8' : 'd6';
      add('inspiration', 'Bardic Inspiration', Math.max(1, cha), L >= 5 ? 'short' : 'long', `give an ally a ${die} to add to one roll`);
      break;
    }
    case 'cleric':
      if (L >= 2) add('channel', 'Channel Divinity', L >= 18 ? 3 : L >= 6 ? 2 : 1, 'short', `Turn Undead: undead within 30 ft make a WIS save (DC ${8 + prof + wis}) or flee for 1 minute`);
      break;
    case 'druid':
      if (L >= 2) add('wildshape', 'Wild Shape', 2, 'short', `become a beast of CR ${L >= 8 ? 1 : L >= 4 ? '1/2' : '1/4'} or lower${L < 8 ? (L < 4 ? ' (no flying or swimming speed)' : ' (no flying speed)') : ''}`);
      break;
    case 'fighter':
      add('secondwind', 'Second Wind', 1, 'short', `bonus action: heal 1d10 + ${L}`);
      if (L >= 2) add('surge', 'Action Surge', L >= 17 ? 2 : 1, 'short', 'one extra action on your turn');
      break;
    case 'monk':
      add('martial', 'Martial Arts', null, null, `unarmed strikes deal 1d${L >= 17 ? 10 : L >= 11 ? 8 : L >= 5 ? 6 : 4}; bonus-action unarmed strike`);
      if (L >= 2) add('ki', 'Ki points', L, 'short', 'Flurry of Blows, Patient Defense, Step of the Wind (1 each)', true);
      break;
    case 'paladin':
      add('sense', 'Divine Sense', 1 + Math.max(0, cha), 'long', 'sense celestials, fiends and undead within 60 ft');
      add('layonhands', 'Lay on Hands', 5 * L, 'long', 'touch: restore HP from this pool', true);
      if (L >= 2) add('smite', 'Divine Smite', null, null, 'on a melee hit, spend a spell slot: +2d8 radiant (+1d8 per slot level above 1st, max 5d8)');
      break;
    case 'ranger':
      add('favored', 'Favored Enemy', null, null, 'advantage to track and recall lore about your favored enemies');
      break;
    case 'rogue':
      add('sneak', 'Sneak Attack', null, null, `once a turn: +${Math.ceil(L / 2)}d6 damage with a finesse or ranged weapon when you have advantage or an ally is next to the target`);
      break;
    case 'sorcerer':
      if (L >= 2) add('sorcery', 'Sorcery points', L, 'long', 'Flexible Casting: turn points into spell slots and back', true);
      break;
    case 'warlock':
      break;
    case 'wizard':
      add('arcane', 'Arcane Recovery', 1, 'long', `during a short rest, regain spent slots up to ${Math.ceil(L / 2)} levels in total (none above 5th)`);
      break;
  }
  return f;
}
const featureLeft = (c, ft) => ft.uses === null ? null : Math.max(0, ft.uses - (parseInt((c.featureUsed || {})[ft.key]) || 0));
function findFeature(c, name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z ]/g, '').trim();
  const list = featuresOf(c);
  return list.find(f => f.name.toLowerCase() === n) || list.find(f => n && (f.name.toLowerCase().includes(n) || n.includes(f.name.toLowerCase().replace(/ points$/, ''))));
}
// The card: tracked features with what's left. Your own fill the message box when tapped.
function featureCardHTML(c) {
  const list = featuresOf(c);
  if (!list.length) return '';
  const mine = c === ROSTER[MY_CHAR_ID];
  return `<div class="spell-card">
    <div class="spell-head">Class features</div>
    <div class="spell-names">${list.map(ft => {
      const left = featureLeft(c, ft);
      const count = left === null ? '' : ft.pool || ft.uses > 6 ? ` ${left}/${ft.uses}` : ' ' + pipRow(left, ft.uses);
      const tip = escapeAttr(ft.note + (ft.rest ? ` (refills on a ${ft.rest} rest)` : ''));
      return mine ? `<button class="spell-chip" title="${tip}" onclick="featureChip('${escapeAttr(ft.name)}')">${escapeHtml(ft.name)}${count}</button>`
        : `<span class="spell-chip" title="${tip}">${escapeHtml(ft.name)}${count}</span>`;
    }).join('')}</div></div>`;
}
function featureChip(name) {
  const box = el('composerInput');
  if (!box) return;
  box.value = `I use ${name} `; composerDraft = box.value; box.focus();
}
window.featureChip = featureChip;
// Your Sheet: every feature with its rule text.
function featureSheetHTML(c) {
  const list = featuresOf(c);
  if (!list.length) return '';
  return `<div class="panel spell-panel"><h3>Class features</h3>
    ${list.map(ft => { const left = featureLeft(c, ft); return `<p><b>${escapeHtml(ft.name)}</b>${left === null ? '' : ` &middot; ${left}/${ft.uses} left`}${ft.rest ? ` &middot; refills on a ${ft.rest} rest` : ''}<br><span class="helptext">${escapeHtml(ft.note)}</span></p>`; }).join('')}
    <p class="helptext">Tell the GM when you use one (or tap it on your card); the game counts the uses.</p></div>`;
}
function featurePromptText(c) {
  const list = featuresOf(c);
  if (!list.length) return '';
  return `, class features (kept by the game): ${list.map(ft => { const left = featureLeft(c, ft); return `${ft.name}${left === null ? '' : ` ${left}/${ft.uses} left${ft.rest ? ` (${ft.rest} rest)` : ''}`}`; }).join('; ')}`;
}
// Rests: a long rest refills everything; a short rest refills the short-rest features. Returns names refilled.
function refillFeatures(kind) {
  const names = [];
  for (const c of Object.values(ROSTER)) {
    const used = c.featureUsed || {};
    if (!Object.keys(used).length) continue;
    for (const ft of featuresOf(c)) {
      if (used[ft.key] && (kind === 'long' || ft.rest === 'short')) { delete used[ft.key]; names.push(`${c.name}'s ${ft.name}`); }
    }
    c.featureUsed = used;
  }
  return names;
}
// [[feature: Mira | Second Wind]], [[feature: Aldric | Lay on Hands | 10 | Mira]], [[feature: Aldric | Divine Smite | 2 | Goblin A]]
function resolveFeature(x) {
  const c = findTarget(x.who);
  if (!c) return sysEntry(`${x.who}: the game couldn't find that character.`);
  const ft = findFeature(c, x.feature);
  if (!ft) return sysEntry(`${c.name} has no class feature called ${x.feature}, so nothing happens.`);
  const amt = parseInt(String(x.amount || '').replace(/[^0-9]/g, '')) || 0;
  if (ft.key === 'smite') return resolveSmite(c, amt, x.target);
  if (ft.uses === null) return sysEntry(`✦ ${c.name} uses ${ft.name}: ${ft.note}.`);
  const left = featureLeft(c, ft);
  let n = ft.pool ? amt : 1;
  let healTarget = null;
  if (ft.key === 'layonhands') {
    healTarget = findTarget(x.target || '') || (x.target ? null : c);
    if (!healTarget) { const a = findFoe(x.target); if (a && a.ally) healTarget = a; }
    if (!healTarget) return sysEntry(`${c.name}'s Lay on Hands: the game couldn't tell who to heal.`);
    if (!n) n = Math.max(1, Math.min(left, (parseInt(healTarget.maxhp) || 0) - (parseInt(healTarget.hp) || 0)));
  }
  if (ft.pool && !n) return sysEntry(`${c.name} uses ${ft.name}, but how many wasn't said, so none are spent.`);
  if (left < n) return sysEntry(`✦ ${c.name} has ${left ? 'only ' + left : 'no'} ${ft.name}${left ? '' : ' left'}${ft.pool ? ` (needs ${n})` : ''}, so it doesn't happen.`);
  let extra = '';
  if (ft.key === 'arcane') {
    const m = roomMeta();
    if (!(Number.isFinite(m.shortRestAt) && gmCount() - m.shortRestAt <= 1)) return sysEntry(`✦ ${c.name} can only use Arcane Recovery during a short rest.`);
    const cs = casterOf(c);
    if (!cs) return sysEntry(`✦ ${c.name} has no spell slots to recover.`);
    let budget = Math.ceil((parseInt(c.level) || 1) / 2);
    const got = [];
    c.slotsUsed = { ...(c.slotsUsed || {}) };
    for (let l = Math.min(5, cs.maxLevel); l >= 1; l--) {
      while (budget >= l && (parseInt(c.slotsUsed[l]) || 0) > 0) { c.slotsUsed[l]--; budget -= l; got.push(ordinal(l)); }
    }
    if (!got.length) return sysEntry(`✦ ${c.name} has no spent spell slots to recover.`);
    extra = ` — regains ${got.join(', ')}-level slot${got.length > 1 ? 's' : ''}`;
  }
  c.featureUsed = { ...(c.featureUsed || {}) };
  c.featureUsed[ft.key] = (parseInt(c.featureUsed[ft.key]) || 0) + n;
  const after = featureLeft(c, ft);
  if (ft.key === 'secondwind') {
    const r = rollSpec(parseDice(`1d10+${parseInt(c.level) || 1}`), 1);
    const { before, after: hp, max } = changeHP(c, r.total);
    extra = ` — heals ${r.total} (${r.text}): HP ${before} → ${hp}/${max}`;
  }
  if (ft.key === 'layonhands') {
    const { before, after: hp, max } = changeHP(healTarget, n);
    extra = ` — ${healTarget.name} heals ${n}: HP ${before} → ${hp}/${max}`;
  }
  const saveMeta = !!(healTarget && healTarget.ally);
  return sysEntry(`✦ ${c.name} uses ${ft.name}${ft.pool ? ` (${n})` : ''}${extra}. ${after}/${ft.uses} left${ft.rest ? ` (refills on a ${ft.rest} rest)` : ''}.`, { saveAll: true, saveMeta });
}
function resolveSmite(c, level, target) {
  const cs = casterOf(c);
  if (!cs) return sysEntry(`✦ ${c.name} has no spell slots for Divine Smite.`);
  const slots = slotsLeft(c, cs);
  const slot = level ? slots[level - 1] : slots.find(s => s.left > 0);
  if (!slot || slot.left < 1) return sysEntry(`✦ ${c.name} has no ${level ? ordinal(level) + '-level ' : ''}spell slot left for Divine Smite, so it doesn't happen.`);
  c.slotsUsed = { ...(c.slotsUsed || {}) };
  c.slotsUsed[slot.level] = (parseInt(c.slotsUsed[slot.level]) || 0) + 1;
  const r = rollSpec(parseDice(`${Math.min(5, 1 + slot.level)}d8`), 1);
  let text = `✦ ${c.name}'s Divine Smite (${ordinal(slot.level)}-level slot): ${r.total} radiant damage (${r.text})`;
  const foe = target ? findFoe(target) : null;
  let saveMeta = false;
  if (foe && !foe.ally) {
    const before = foe.hp;
    foe.hp = Math.max(0, foe.hp - r.total);
    text += ` — ${foe.name}: HP ${before} → ${foe.hp}/${foe.maxhp}${foe.hp === 0 ? ' (down!)' : ''}`;
    if (foe.hp === 0) text += ' ' + foeFell(foe).text;
    saveMeta = true;
  }
  return sysEntry(text + '.', { saveAll: true, saveMeta });
}

/* ---------------- Spellcasting (SRD 5.1) ----------------
   Slots, how many spells a caster has, and their spell list come from the class and level; spells come from
   the class's SRD list (srd-spells.js). The game spends slots with the GM's [[cast]] and refuses a spell
   that isn't chosen or has no slot left. A long rest restores slots (a short rest restores warlock pact
   slots). Spells can be changed only after a long rest, when a new session begins, or by a new hero. */
const CASTERS = { // class: [list letter, ability, slot progression, how spells are chosen]
  bard: ['b', 'cha', 'full', 'known'], cleric: ['c', 'wis', 'full', 'prepared'], druid: ['d', 'wis', 'full', 'prepared'],
  paladin: ['p', 'cha', 'half', 'prepared'], ranger: ['r', 'wis', 'half', 'known'], sorcerer: ['s', 'cha', 'full', 'known'],
  warlock: ['k', 'cha', 'pact', 'known'], wizard: ['w', 'int', 'full', 'prepared'],
};
const FULL_SLOTS = [[2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
const SPELLS_KNOWN = {
  bard: [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 15, 16, 18, 19, 19, 20, 22, 22, 22],
  sorcerer: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13, 13, 14, 14, 15, 15, 15, 15],
  warlock: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15],
  ranger: [0, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11],
};
const CANTRIPS_KNOWN = { bard: [2, 3, 4], cleric: [3, 4, 5], druid: [2, 3, 4], sorcerer: [4, 5, 6], warlock: [2, 3, 4], wizard: [3, 4, 5] };
const ordinal = n => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th';

function casterOf(c) {
  if (!c) return null;
  const cls = Object.keys(CASTERS).find(n => new RegExp('\\b' + n + '\\b', 'i').test(String(c.klass || '')));
  if (!cls) return null;
  const [letter, ab, kind, mode] = CASTERS[cls];
  const lvl = Math.max(1, Math.min(20, parseInt(c.level) || 1));
  const mod = abilityMod(c[ab]);
  const prof = Math.ceil(lvl / 4) + 1;
  let slots = [], pact = null;
  if (kind === 'full') slots = FULL_SLOTS[lvl - 1];
  else if (kind === 'half') slots = lvl >= 2 ? FULL_SLOTS[Math.ceil(lvl / 2) - 1] : [];
  else pact = { n: lvl === 1 ? 1 : lvl <= 10 ? 2 : lvl <= 16 ? 3 : 4, level: Math.min(5, Math.ceil(lvl / 2)) };
  const maxLevel = pact ? pact.level : slots.length;
  const cantrips = CANTRIPS_KNOWN[cls] ? CANTRIPS_KNOWN[cls][lvl >= 10 ? 2 : lvl >= 4 ? 1 : 0] : 0;
  const spells = mode === 'known' ? SPELLS_KNOWN[cls][lvl - 1] : maxLevel ? Math.max(1, mod + (kind === 'half' ? Math.floor(lvl / 2) : lvl)) : 0;
  return { cls, letter, ability: ab.toUpperCase(), mod, prof, dc: 8 + prof + mod, attack: prof + mod, slots, pact, maxLevel, cantrips, spells, mode };
}
function spellInfo(name) {
  const t = window.SRD_SPELLS || {};
  const want = String(name || '').trim().toLowerCase();
  const k = Object.keys(t).find(n => n.toLowerCase() === want);
  return k ? { name: k, level: t[k][0], classes: t[k][1] } : null;
}
function mySpells(c) { return (Array.isArray(c.spells) ? c.spells : []).map(spellInfo).filter(Boolean).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)); }
function slotsLeft(c, cs) {
  if (cs.pact) return [{ level: cs.pact.level, total: cs.pact.n, left: Math.max(0, cs.pact.n - (parseInt(c.pactUsed) || 0)), pact: true }];
  const used = c.slotsUsed || {};
  return cs.slots.map((t, i) => ({ level: i + 1, total: t, left: Math.max(0, t - (parseInt(used[i + 1]) || 0)) }));
}
function spellWindowOpen(c) {
  if (!META || !c) return false;
  if (!Array.isArray(c.spells) || !c.spells.length) return true; // a new hero chooses straight away
  const n = gmCount();
  return (Number.isFinite(META.lastLongRest) && META.lastLongRest === n) || (Number.isFinite(META.spellWindow) && META.spellWindow === n);
}
const pipRow = (left, total) => Array.from({ length: total }, (_, i) => `<span class="ds-pip ${i < left ? 'ok' : ''}"></span>`).join('');
function slotLineHTML(c, cs) {
  const s = slotsLeft(c, cs);
  return s.length ? `<div class="slot-line">${s.map(x => `<span class="slot-group">${x.pact ? 'Pact ' : ''}${ordinal(x.level)} ${pipRow(x.left, x.total)}</span>`).join('')}</div>` : '';
}

// The character card (story tab): DC, slots and the chosen spells. Your own spells fill the message box.
function spellCardHTML(c) {
  const cs = casterOf(c);
  if (!cs) return '';
  if (!cs.maxLevel && !cs.cantrips) return `<div class="spell-card helptext">Spellcasting starts at level 2.</div>`;
  const mine = c === ROSTER[MY_CHAR_ID];
  const list = mySpells(c);
  return `<div class="spell-card">
    <div class="spell-head">Spells &middot; save DC ${cs.dc} &middot; ${fmtMod(cs.attack)} to hit</div>
    ${slotLineHTML(c, cs)}
    <div class="spell-names">${list.length ? list.map(s => mine
      ? `<button class="spell-chip" title="${s.level ? ordinal(s.level) + ' level' : 'Cantrip'}" onclick="castChip('${escapeAttr(s.name)}')">${escapeHtml(s.name)}</button>`
      : `<span class="spell-chip" title="${s.level ? ordinal(s.level) + ' level' : 'Cantrip'}">${escapeHtml(s.name)}</span>`).join('')
      : `<span class="helptext">${mine ? 'Choose your spells on the Your Sheet tab.' : 'No spells chosen yet.'}</span>`}</div>
  </div>`;
}
function castChip(name) {
  const box = el('composerInput');
  if (!box) return;
  box.value = `I cast ${name} `; composerDraft = box.value; box.focus();
}

// Your Sheet: the full list, and choosing spells while the window is open.
let SPELL_DRAFT = null;
function spellSheetHTML(c) {
  const cs = casterOf(c);
  if (!cs) return '';
  const mine = c === ROSTER[MY_CHAR_ID];
  const head = `<h3>Spellcasting</h3>
    <p class="helptext">${cs.ability} &middot; spell save DC ${cs.dc} &middot; spell attack ${fmtMod(cs.attack)}${cs.cantrips ? ` &middot; ${cs.cantrips} cantrips` : ''}${cs.spells ? ` &middot; ${cs.spells} ${cs.mode === 'known' ? 'spells known' : 'spells prepared'}` : ''}${cs.pact ? ` &middot; pact slots come back on a short rest` : ''}</p>
    ${slotLineHTML(c, cs)}`;
  if (!cs.maxLevel && !cs.cantrips) return `<div class="panel spell-panel">${head}<p class="helptext">${escapeHtml(c.klass)}s start casting spells at level 2.</p></div>`;
  const open = mine && spellWindowOpen(c);
  if (!open) {
    const list = mySpells(c);
    return `<div class="panel spell-panel">${head}
      ${list.length ? [...new Set(list.map(s => s.level))].map(l => `<p><b>${l ? ordinal(l) + ' level' : 'Cantrips'}:</b> ${list.filter(s => s.level === l).map(s => escapeHtml(s.name)).join(', ')}</p>`).join('') : '<p class="helptext">No spells chosen yet.</p>'}
      ${mine ? '<p class="helptext">You can change your spells after a long rest or when a new session begins.</p>' : ''}</div>`;
  }
  if (!SPELL_DRAFT || SPELL_DRAFT.id !== MY_CHAR_ID) SPELL_DRAFT = { id: MY_CHAR_ID, set: new Set(mySpells(c).map(s => s.name)) };
  const t = window.SRD_SPELLS || {};
  const levels = [];
  if (cs.cantrips) levels.push(0);
  for (let l = 1; l <= cs.maxLevel; l++) levels.push(l);
  const groups = levels.map(l => {
    const names = Object.keys(t).filter(n => t[n][0] === l && t[n][1].includes(cs.letter)).sort();
    return `<details ${l <= 1 ? 'open' : ''}><summary>${l ? ordinal(l) + ' level' : 'Cantrips'} (${names.length})</summary><div class="spell-options">${names.map(n =>
      `<label class="spell-option"><input type="checkbox" ${SPELL_DRAFT.set.has(n) ? 'checked' : ''} onchange="toggleSpellDraft('${escapeAttr(n)}', this.checked)"> ${escapeHtml(n)}</label>`).join('')}</div></details>`;
  }).join('');
  return `<div class="panel spell-panel">${head}
    <p class="hero-note">Choose your spells now: you can change them only after a long rest or when a new session begins.</p>
    <p class="helptext" id="spellCount">${spellCountText(cs)}</p>
    ${groups}
    <div id="spellErr" class="error-text"></div>
    <button class="btn solid" onclick="saveSpells()">Save my spells</button></div>`;
}
function spellCountText(cs) {
  const picked = [...SPELL_DRAFT.set].map(spellInfo).filter(Boolean);
  const nc = picked.filter(s => s.level === 0).length, ns = picked.length - nc;
  const over = (n, max) => n > max ? `<span class="error-text">${n}/${max} (too many)</span>` : `${n}/${max}`;
  return `${cs.cantrips ? `Cantrips ${over(nc, cs.cantrips)} &middot; ` : ''}Spells ${over(ns, cs.spells)}`;
}
function toggleSpellDraft(name, on) {
  if (!SPELL_DRAFT) return;
  if (on) SPELL_DRAFT.set.add(name); else SPELL_DRAFT.set.delete(name);
  const cs = casterOf(ROSTER[MY_CHAR_ID]);
  const box = el('spellCount'); if (box && cs) box.innerHTML = spellCountText(cs);
}
async function saveSpells() {
  const c = ROSTER[MY_CHAR_ID]; const cs = casterOf(c);
  if (!c || !cs || !SPELL_DRAFT || !spellWindowOpen(c)) return;
  const picked = [...SPELL_DRAFT.set].map(spellInfo).filter(s => s && s.classes.includes(cs.letter) && s.level <= cs.maxLevel);
  const nc = picked.filter(s => s.level === 0).length, ns = picked.length - nc;
  const err = el('spellErr');
  if (nc > cs.cantrips || ns > cs.spells) { if (err) err.innerText = `Too many: you can have ${cs.cantrips ? cs.cantrips + ' cantrips and ' : ''}${cs.spells} spells.`; return; }
  if (!picked.length) { if (err) err.innerText = 'Pick at least one spell.'; return; }
  c.spells = picked.map(s => s.name);
  SPELL_DRAFT = null;
  await dbUpsertCharacter(MY_CHAR_ID, ROOM, c);
  const entry = { id: uid(6), author: 'The Ledger', type: 'system', text: `📖 ${c.name}'s spells: ${mySpells(c).map(s => s.name).join(', ')}.` };
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
}
window.castChip = castChip; window.toggleSpellDraft = toggleSpellDraft; window.saveSpells = saveSpells;

// For the GM's party list.
function spellPromptText(c) {
  const cs = casterOf(c);
  if (!cs || (!cs.maxLevel && !cs.cantrips)) return '';
  const slots = slotsLeft(c, cs).map(s => `${s.pact ? 'pact ' : ''}${ordinal(s.level)} ${s.left}/${s.total}`).join(', ');
  const list = mySpells(c).map(s => `${s.name} (${s.level ? ordinal(s.level) : 'cantrip'})`).join(', ');
  return `, spellcasting (${cs.ability}, save DC ${cs.dc}, ${fmtMod(cs.attack)} to hit; slots left: ${slots || 'none'}; spells: ${list || 'none chosen'})`;
}

// [[cast: Sera | Cure Wounds | 2]] — spends a slot (the spell's level, or the higher level given).
function resolveCast(x) {
  const c = findTarget(x.who);
  if (!c) return sysEntry(`✨ ${x.who}: the game couldn't find that caster.`);
  const cs = casterOf(c);
  const sp = spellInfo(x.spell);
  const name = sp ? sp.name : String(x.spell || '').trim().slice(0, 60);
  const chosen = (Array.isArray(c.spells) ? c.spells : []).some(n => String(n).toLowerCase() === name.toLowerCase());
  if (!cs || !sp || !chosen) return sysEntry(`✨ ${c.name} can't cast ${name}: it isn't one of their spells, so it isn't cast.`);
  if (sp.level === 0) return sysEntry(`✨ ${c.name} casts ${sp.name} (cantrip).`);
  const asked = parseInt(String(x.level || '').replace(/[^0-9]/g, '')) || 0;
  const slots = slotsLeft(c, cs);
  let slot;
  if (cs.pact) slot = sp.level <= cs.pact.level ? slots[0] : null;
  else slot = slots[Math.max(sp.level, asked) - 1];
  if (!slot) return sysEntry(`✨ ${c.name} can't cast ${sp.name} at that level yet, so it isn't cast.`);
  if (slot.left < 1) return sysEntry(`✨ ${c.name} has no ${ordinal(slot.level)}-level spell slots left, so ${sp.name} isn't cast.`);
  if (cs.pact) c.pactUsed = (parseInt(c.pactUsed) || 0) + 1;
  else { c.slotsUsed = { ...(c.slotsUsed || {}) }; c.slotsUsed[slot.level] = (parseInt(c.slotsUsed[slot.level]) || 0) + 1; }
  return sysEntry(`✨ ${c.name} casts ${sp.name} with a ${ordinal(slot.level)}-level slot (${slot.left - 1}/${slot.total} left).`, { saveAll: true });
}

/* ---------------- Death saves ----------------
   A hero at 0 HP is dying (c.dying = { s, f }) until three successes (stable), three failures (dead), a
   natural 20 (back up with 1 HP), healing, or [[stable]]. The dying player rolls with the button (or
   "/roll d20 death save"); the game counts it. One death save per GM turn. */
function dyingText(c) {
  if (c.dead) return 'dead';
  if (c.stable) return 'unconscious, stable';
  const d = c.dying || { s: 0, f: 0 };
  return `death saves ${d.s} success${d.s === 1 ? '' : 'es'} / ${d.f} failure${d.f === 1 ? '' : 's'}`;
}
const isDying = c => !!c && (parseInt(c.hp) || 0) <= 0 && !c.dead && !c.stable;
function deathSaveDue(c) { return isDying(c) && (c.dying || {}).at !== gmCount(); }
function deathSaveHTML(c) {
  if (!c || (parseInt(c.hp) || 0) > 0) return '';
  if (c.dead) return `<p class="error-text" style="margin:8px 0 0;">${escapeHtml(c.name)} has died.</p>`;
  if (c.stable) return `<p class="helptext" style="margin:8px 0 0;">Unconscious but stable at 0 HP. Any healing wakes ${escapeHtml(c.name)}.</p>`;
  const d = c.dying || { s: 0, f: 0 };
  const pips = (n, cls) => [0, 1, 2].map(i => `<span class="ds-pip ${i < n ? cls : ''}"></span>`).join('');
  const mine = c === ROSTER[MY_CHAR_ID];
  return `<div class="death-saves">
    <div><b>Dying</b> &middot; successes ${pips(d.s, 'ok')} failures ${pips(d.f, 'bad')}</div>
    ${mine ? (deathSaveDue(c)
      ? `<button class="btn rust wide" onclick="rollDeathSave()">Roll death save</button>`
      : `<p class="helptext">Death save rolled. Roll the next one on your next turn, after the GM's reply.</p>`) : ''}
  </div>`;
}
async function rollDeathSave() {
  const c = ROSTER[MY_CHAR_ID];
  if (!deathSaveDue(c)) return;
  const n = Math.floor(Math.random() * 20) + 1;
  const d = c.dying || { s: 0, f: 0 };
  let outcome;
  if (n === 20) { c.hp = 1; delete c.dying; outcome = 'natural 20: back on their feet with 1 HP!'; }
  else {
    if (n === 1) d.f += 2; else if (n >= 10) d.s += 1; else d.f += 1;
    d.s = Math.min(3, d.s); d.f = Math.min(3, d.f); d.at = gmCount(); c.dying = d;
    if (d.f >= 3) { c.dead = true; delete c.dying; outcome = 'three failures: ' + c.name + ' has died.'; }
    else if (d.s >= 3) { c.stable = true; delete c.dying; outcome = 'three successes: stable, unconscious at 0 HP.'; }
    else outcome = `${n === 1 ? 'natural 1: two failures' : n >= 10 ? 'success' : 'failure'} (${dyingText(c)})`;
  }
  const entry = { id: uid(6), author: c.name, type: 'roll', text: `rolls d20(${n}) = ${n} (death save) — ${outcome}` };
  heldLogIds.add(entry.id);
  const shown = showDiceRoll({ sides: 20, dice: [{ v: n, dropped: false }], mod: 0, total: n, flagged: false, title: 'Death save',
    onReveal: () => { heldLogIds.delete(entry.id); if (VIEW === 'game') render(); } });
  if (!shown) heldLogIds.delete(entry.id);
  await dbUpsertCharacter(MY_CHAR_ID, ROOM, c);
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
}
window.rollDeathSave = rollDeathSave;
// [[stable: Mira]] — someone stabilised them (Medicine check, healer's kit, spare the dying).
function resolveStable(t) {
  const c = findTarget(t.target);
  if (!c) return sysEntry(`${t.target}: the game couldn't find that character to stabilise.`);
  if (!isDying(c)) return sysEntry(`${c.name} isn't dying, so there's nothing to stabilise.`);
  c.stable = true; delete c.dying;
  return sysEntry(`✚ ${c.name} is stable: unconscious at 0 HP, no more death saves.`, { saveAll: true });
}

/* ---------------- Roll picker + unlisted-modifier flag ---------------- */
const UNLISTED_FLAG = '⚠ unlisted modifier';

// Every d20 modifier this character actually has on their sheet.
function rollOptions(c) {
  if (!c) return [];
  const abilities = [['STR', 'Strength', c.str], ['DEX', 'Dexterity', c.dex], ['CON', 'Constitution', c.con],
                     ['INT', 'Intelligence', c.int], ['WIS', 'Wisdom', c.wis], ['CHA', 'Charisma', c.cha]];
  const opts = abilities.map(([abbr, name, score]) => ({ key: 'a:' + abbr, group: 'Ability checks', abbr, name, mod: abilityMod(score) }));
  (c.skills || []).forEach((s, i) => {
    if (s && s.name) opts.push({ key: 's:' + i, group: 'Skills', name: String(s.name), mod: Number(s.mod) || 0 });
  });
  // Weapon attacks: ability modifier + proficiency bonus (2 at levels 1-4, +1 every 4 levels).
  const prof = 2 + Math.floor(((parseInt(c.level) || 1) - 1) / 4);
  opts.push({ key: 'atk:STR', group: 'Attacks', name: 'Attack (STR)', mod: abilityMod(c.str) + prof });
  opts.push({ key: 'atk:DEX', group: 'Attacks', name: 'Attack (DEX)', mod: abilityMod(c.dex) + prof });
  // One attack and one damage entry per weapon the story gave them; bows and crossbows spend ammunition.
  const seen = new Set();
  for (const it of earnedItems(c)) {
    const w = weaponOf(it);
    if (!w || seen.has(w.key)) continue;
    seen.add(w.key);
    const ab = w.ab === 'fin' ? (abilityMod(c.dex) >= abilityMod(c.str) ? 'dex' : 'str') : w.ab;
    const nm = capFirst(w.key);
    opts.push({ key: 'w:' + w.key, group: 'Weapons', name: `${nm} attack`, mod: abilityMod(c[ab]) + prof });
    opts.push({ key: 'wd:' + w.key, group: 'Weapons', name: `${nm} damage`, mod: abilityMod(c[ab]), dice: w.dice });
  }
  const lvl = parseInt(c.level) || 1, cls = classOf(c);
  if (cls === 'rogue') opts.push({ key: 'f:sneak', group: 'Class features', name: 'Sneak Attack damage', mod: 0, dice: `${Math.ceil(lvl / 2)}d6` });
  if (cls === 'bard') opts.push({ key: 'f:insp', group: 'Class features', name: 'Bardic Inspiration die', mod: 0, dice: `1d${lvl >= 15 ? 12 : lvl >= 10 ? 10 : lvl >= 5 ? 8 : 6}` });
  if (cls === 'monk') {
    const best = Math.max(abilityMod(c.dex), abilityMod(c.str));
    opts.push({ key: 'f:unarmed', group: 'Class features', name: 'Unarmed strike attack', mod: best + prof });
    opts.push({ key: 'f:unarmedd', group: 'Class features', name: 'Unarmed strike damage', mod: best, dice: `1d${lvl >= 17 ? 10 : lvl >= 11 ? 8 : lvl >= 5 ? 6 : 4}` });
  }
  opts.push({ key: 'i', group: 'Other', name: 'Initiative', mod: initiativeBonus(c) });
  return opts;
}
function rollPickerHTML() {
  const opts = rollOptions(ROSTER[MY_CHAR_ID]);
  if (!opts.length) return '';
  const groups = [...new Set(opts.map(o => o.group))];
  return `<select class="roll-picker" id="rollPicker" onchange="pickRoll(this.value)" title="Fill in a roll using your character sheet">
    <option value="">🎲 Roll from sheet…</option>
    ${groups.map(g => `<optgroup label="${escapeAttr(g)}">${opts.filter(o => o.group === g).map(o =>
      `<option value="${escapeAttr(o.key)}">${escapeHtml(o.name)} (${o.dice ? o.dice + (o.mod ? fmtMod(o.mod) : '') : fmtMod(o.mod)})</option>`).join('')}</optgroup>`).join('')}
  </select>`;
}
function pickRoll(key) {
  const opt = rollOptions(ROSTER[MY_CHAR_ID]).find(o => o.key === key);
  const picker = el('rollPicker');
  if (picker) picker.value = '';
  if (!opt) return;
  composerDraft = opt.dice ? `/roll ${opt.dice}${opt.mod ? fmtMod(opt.mod) : ''} ${opt.name}` : `/roll ${fmtMod(opt.mod)} ${opt.name}`;
  const input = el('composerInput');
  if (input) { input.value = composerDraft; input.focus(); }
}
// A d20 roll is flagged when its bonus is higher than the sheet allows. If the roll names
// a skill/ability, compare against that one; otherwise the bonus must match something on the sheet.
function isUnlistedModifier(c, mod, label) {
  if (!c) return false;
  const opts = rollOptions(c);
  const key = (label || '').trim().toLowerCase();
  const named = key && opts.find(o => o.name.toLowerCase() === key || (o.abbr && o.abbr.toLowerCase() === key));
  if (named) return mod > named.mod;
  return mod > 0 && !opts.some(o => o.mod === mod);
}
/* ---------------- Dice-roll popup ---------------- */
function diceAnimOn() {
  try { return localStorage.getItem('ledger:diceAnim') !== 'off'; } catch (e) { return true; }
}
function setDiceAnim(on) {
  try { localStorage.setItem('ledger:diceAnim', on ? 'on' : 'off'); } catch (e) {}
  if (!on) closeDiceRoll();
}

let diceTimers = [];
let diceReveal = null;            // callback that un-hides the held log entry
const heldLogIds = new Set();     // roll entries hidden from the log until their dice settle
function revealHeldRoll() {
  const f = diceReveal; diceReveal = null;
  if (f) f();
}
function closeDiceRoll() {
  diceTimers.forEach(t => { clearTimeout(t); clearInterval(t); });
  diceTimers = [];
  const o = el('diceOverlay');
  if (o) o.remove();
  revealHeldRoll();               // never leave a roll hidden if the popup is dismissed early
}

// Static markup only (no user text), so innerHTML is safe here.
function dieShapeSVG(sides) {
  const style = 'class="die-shape"';
  let shape;
  if (sides === 4) shape = `<polygon ${style} points="50,6 94,90 6,90"/>`;
  else if (sides === 6) shape = `<rect ${style} x="8" y="8" width="84" height="84" rx="16"/>`;
  else if (sides === 8) shape = `<polygon ${style} points="50,4 94,50 50,96 6,50"/><polygon class="die-inner" points="50,4 50,96 6,50"/>`;
  else if (sides === 12) shape = `<polygon ${style} points="50,4 95,38 78,92 22,92 5,38"/>`;
  else if (sides === 20) shape = `<polygon ${style} points="50,4 93,27 93,73 50,96 7,73 7,27"/><polygon class="die-inner" points="50,4 93,73 7,73"/>`;
  else shape = `<polygon ${style} points="50,4 93,27 93,73 50,96 7,73 7,27"/>`;
  return `<svg viewBox="0 0 100 100" aria-hidden="true">${shape}</svg>`;
}

// dice: [{ v, dropped }] — dropped dice (the loser of advantage/disadvantage) are dimmed.
// Returns true if a popup was shown. onReveal runs once the dice settle (or the popup is closed).
function showDiceRoll({ sides, dice, mod, total, flagged, title, onReveal }) {
  if (!diceAnimOn() || !dice.length) return false;
  closeDiceRoll();
  diceReveal = onReveal || null;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rollMs = reduce ? 0 : 1000;
  const MAX_SHOWN = 12;
  const shown = dice.slice(0, MAX_SHOWN);

  const overlay = document.createElement('div');
  overlay.id = 'diceOverlay';
  overlay.className = 'dice-overlay';
  overlay.setAttribute('role', 'status');
  overlay.title = 'Click to dismiss';
  overlay.onclick = closeDiceRoll;

  const card = document.createElement('div');
  card.className = 'dice-card';
  const heading = document.createElement('div');
  heading.className = 'dice-title';
  heading.textContent = title;           // may contain a player-typed label — textContent keeps it inert
  const row = document.createElement('div');
  row.className = 'dice-row';

  const nums = [], dieEls = [];
  shown.forEach(() => {
    const die = document.createElement('div');
    die.className = 'die s' + sides + (reduce ? '' : ' rolling');
    die.innerHTML = dieShapeSVG(sides);
    const num = document.createElement('span');
    num.className = 'die-num';
    num.textContent = reduce ? '' : String(1 + Math.floor(Math.random() * sides));
    die.appendChild(num);
    row.appendChild(die);
    nums.push(num); dieEls.push(die);
  });
  if (dice.length > MAX_SHOWN) {
    const more = document.createElement('div');
    more.className = 'dice-more';
    more.textContent = `+${dice.length - MAX_SHOWN} more`;
    row.appendChild(more);
  }

  const sum = document.createElement('div');
  sum.className = 'dice-sum';
  const expr = document.createElement('div');
  expr.className = 'dice-expr';
  const tot = document.createElement('div');
  tot.className = 'dice-total';
  sum.append(expr, tot);
  if (flagged) {
    const flag = document.createElement('div');
    flag.className = 'dice-flag';
    flag.textContent = UNLISTED_FLAG;
    sum.appendChild(flag);
  }

  card.append(heading, row, sum);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const settle = i => {
    const d = shown[i];
    nums[i].textContent = String(d.v);
    dieEls[i].classList.remove('rolling');
    dieEls[i].classList.add('settled');
    if (d.dropped) dieEls[i].classList.add('dropped');
    else if (sides === 20 && d.v === 20) dieEls[i].classList.add('crit');
    else if (sides === 20 && d.v === 1) dieEls[i].classList.add('fumble');
  };
  const finish = () => {
    const kept = dice.filter(d => !d.dropped).map(d => d.v);
    expr.textContent = (kept.length <= MAX_SHOWN ? kept.join(' + ') : `${kept.length} dice`) + (mod !== 0 ? ` ${fmtMod(mod)}` : '');
    tot.textContent = String(total);
    sum.classList.add('show');
    overlay.setAttribute('aria-label', `Rolled ${total}`);
    revealHeldRoll();
    diceTimers.push(setTimeout(closeDiceRoll, flagged ? 2800 : 2200));
  };

  if (reduce) { shown.forEach((_, i) => settle(i)); finish(); return true; }

  diceTimers.push(setInterval(() => {
    nums.forEach((n, i) => { if (dieEls[i].classList.contains('rolling')) n.textContent = String(1 + Math.floor(Math.random() * sides)); });
  }, 70));
  shown.forEach((_, i) => diceTimers.push(setTimeout(() => settle(i), rollMs + i * 120)));
  diceTimers.push(setTimeout(finish, rollMs + (shown.length - 1) * 120 + 300));
  return true;
}

/* ---------------- Markdown for GM messages ---------------- */
// Safe subset: headings, blockquotes, lists, hr, **bold**, *italic*, `code`.
// Input is HTML-escaped FIRST, so only the fixed tags below can ever appear.
// ctx (optional) = { entryId, active }: when active, `/roll ...` code becomes a click-to-roll button.
function mdInline(s, ctx) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^*\w])\*(?!\s)([^*\n]*[^*\s])\*(?![*\w])/g, '$1<em>$2</em>')
       .replace(/(^|[\s(])_(?!\s)([^_\n]*[^_\s])_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const code = codes[+i];
    if (ctx && ctx.active && /^\/roll(\s|$)/i.test(code) && code.length <= 70) {
      const key = ctx.entryId + '|roll|' + code;
      const attr = code.replace(/"/g, '&quot;');
      return isChipUsed(key)
        ? `<span class="roll-chip used" title="Already rolled">🎲 ${code} ✓</span>`
        : `<button type="button" class="roll-chip" title="Click to roll this" data-key="${key.replace(/"/g, '&quot;')}" data-cmd="${attr}" onclick="runChip(this)">🎲 ${code}</button>`;
    }
    return `<code>${code}</code>`;
  });
}

// "Used" chips/options are remembered per room so reloading the page can't be used to roll twice.
const EMOJI_START = /^(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*)\s*(.*)$/u;
function usedKey() { return 'ledger:used:' + ROOM; }
function usedSet() { try { return new Set(JSON.parse(localStorage.getItem(usedKey()) || '[]')); } catch (e) { return new Set(); } }
function isChipUsed(key) { return usedSet().has(key); }
function markChipUsed(key) {
  const s = usedSet(); s.add(key);
  try { localStorage.setItem(usedKey(), JSON.stringify([...s].slice(-200))); } catch (e) {}
}
// The action an option stands for: its bold title if it has one, else the text before a dash.
function optionAction(rest) {
  const bold = rest.match(/\*\*(.+?)\*\*/);
  let t = bold ? bold[1] : rest.split(/\s[—–-]\s/)[0];
  return t.replace(/[*`_]/g, '').trim().slice(0, 160);
}
function optionItemHTML(item, ctx) {
  const m = ctx && ctx.active ? item.match(EMOJI_START) : null;
  if (!m) return `<li>${mdInline(item, ctx)}</li>`;
  const action = optionAction(m[2]);
  if (!action) return `<li>${mdInline(item, ctx)}</li>`;
  const key = ctx.entryId + '|opt';
  const used = isChipUsed(key);
  const attr = action.replace(/"/g, '&quot;');
  const icon = used
    ? `<span class="opt-ico used">${m[1]}</span>`
    : `<button type="button" class="opt-ico" title="Choose this action" data-key="${key}" data-act="${attr}" onclick="pickOption(this)">${m[1]}</button>`;
  return `<li class="md-opt">${icon} ${mdInline(m[2], ctx)}</li>`;
}
function renderMarkdown(text, ctx) {
  const lines = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('\n');
  const out = [];
  let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join('<br>'), ctx)}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => optionItemHTML(i, ctx)).join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${mdInline(quote.join('<br>'), ctx)}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushAll(); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) { flushAll(); out.push(`<h4 class="md-h">${mdInline(m[2])}</h4>`); continue; }
    if ((m = line.match(/^\s*&gt;\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = line.match(/^\s*([-*•])\s+(.*)$/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(m[2]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { flushPara(); flushQuote(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    flushList(); flushQuote(); para.push(line.trim());
  }
  flushAll();
  return out.join('');
}

function entryHTML(e) {
  if (e.type === 'note') return noteEntryHTML(e);
  const cls = e.type === 'gm' ? 'gm' : e.type === 'roll' ? 'roll' : e.type === 'system' ? 'system' : 'action';
  const dot = e.type === 'gm' ? '<span class="glow-dot"></span>' : '';
  const flagged = e.type === 'roll' && (e.text || '').includes(UNLISTED_FLAG);
  const voided = e.type === 'roll' && rerollIds().has(e.id);
  // Only the newest GM message offers clickable options and rolls, and only to someone with a character.
  let lastGm = null;
  for (let i = LOG.length - 1; i >= 0; i--) { if (LOG[i].type === 'gm') { lastGm = LOG[i]; break; } }
  const ctx = { entryId: e.id, active: !!lastGm && lastGm.id === e.id && !!ROSTER[MY_CHAR_ID] };
  const body = e.type === 'gm' ? `<div class="md">${renderMarkdown(e.text, ctx)}</div>`
    : escapeHtml(flagged ? e.text.replace(UNLISTED_FLAG, '').trim() : e.text);
  const flag = flagged ? ` <span class="roll-flag" title="This bonus isn't on that character's sheet">${UNLISTED_FLAG}</span>` : '';
  return `<div class="entry ${cls}${voided ? ' void' : ''}" data-id="${escapeAttr(e.id)}"><div class="who">${dot}${escapeHtml(e.author)}</div><div class="text">${voided ? '<s class="void-text">' + body + '</s>' : body}${flag}${voided ? ' <span class="roll-void" title="Only your first roll of each kind counts">rolled in error — ignored</span>' : ''}</div></div>`;
}
// Where the story log should sit after a redraw:
// - a new GM reply arrived: show it from its first line (long replies would otherwise start off-screen);
// - other new lines (actions, rolls, game notes): scroll to the bottom;
// - nothing new (a redraw from a map move, a portrait, etc.): stay where the reader is.
let LOG_VIEW = { room: null, lastId: null, gmId: null, scroll: null };
function placeLogScroll() {
  const box = el('logBox');
  if (!box) return;
  const shown = LOG.filter(e => !heldLogIds.has(e.id));
  const lastId = shown.length ? shown[shown.length - 1].id : '';
  let newestGm = null;
  for (let i = shown.length - 1; i >= 0; i--) if (shown[i].type === 'gm') { newestGm = shown[i]; break; }
  const sameRoom = LOG_VIEW.room === ROOM;
  if (sameRoom && lastId === LOG_VIEW.lastId && LOG_VIEW.scroll !== null) {
    box.scrollTop = LOG_VIEW.scroll;
  } else if (newestGm && (!sameRoom || newestGm.id !== LOG_VIEW.gmId)) {
    const node = box.querySelector(`[data-id="${CSS.escape(newestGm.id)}"]`);
    box.scrollTop = node ? box.scrollTop + node.getBoundingClientRect().top - box.getBoundingClientRect().top - 8 : box.scrollHeight;
  } else {
    box.scrollTop = box.scrollHeight;
  }
  LOG_VIEW = { room: ROOM, lastId, gmId: newestGm ? newestGm.id : null, scroll: box.scrollTop };
  box.onscroll = () => { LOG_VIEW.scroll = box.scrollTop; };
}
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }

function renderRosterMini() {
  const box = el('rosterMini'); if (!box) return;
  box.innerHTML = Object.entries(ROSTER).map(([id, c]) => {
    const pct = Math.max(0, Math.min(100, Math.round((c.hp / c.maxhp) * 100)));
    return `<div class="roster-card ${id === MY_CHAR_ID ? 'mine' : ''}">
      ${portraitHeader(c, `<div class="rname"><b>${escapeHtml(c.name)}</b><span class="rclass">Lv${c.level} ${escapeHtml(c.race)} ${escapeHtml(c.klass)}</span></div>`)}
      <div class="hpbar"><div class="hpbar-fill ${pct < 30 ? 'low' : ''}" style="width:${pct}%"></div></div>
      <div class="hprow"><span>HP ${c.hp}/${c.maxhp}</span><span>AC ${c.ac}</span></div>
      ${deathSaveHTML(c)}
      ${spellCardHTML(c)}
      ${featureCardHTML(c)}
      ${abilityGridHTML(c)}
    </div>`;
  }).join('');
}

// Called with no argument from the message box, or with the text to send from a clicked option/roll chip.
async function submitAction(override) {
  const fromChip = typeof override === 'string';
  const input = el('composerInput');
  const text = (fromChip ? override : (input ? input.value : '')).trim();
  if (!text) return;
  if (!fromChip) { input.value = ''; composerDraft = ''; }
  const me = ROSTER[MY_CHAR_ID];
  const authorName = me ? me.name : 'Player';
  if (/^\/roll\b.*\bdeath\b/i.test(text) && isDying(me)) return deathSaveDue(me) ? rollDeathSave() : null;

  // Matches "/roll +5", "/roll 1d20+4", "/roll 2d6+3 adv", "/roll d20", "/roll 1d4", and an
  // optional label after the dice, e.g. "/roll +7 Stealth" or "/roll +7 adv Stealth".
  const rollMatch = text.match(/^\/roll(?=\s|$)\s*(?:(\d*)d(\d+))?\s*([+-]\d+)?\s*(.*)$/i);
  let ammoNote = '';
  if (rollMatch && me && !rollMatch[2] && /\battack\b/i.test(rollMatch[4] || '')) {
    const w = weaponOf(rollMatch[4]);
    if (w && w.ammo) {
      const spent = spendAmmo(me, w.ammo);
      if (!spent.ok) { alert(`${me.name} has ${spent.text}, so the ${capFirst(w.key).toLowerCase()} can't be fired.`); return; }
      ammoNote = ` — ${spent.text}`;
      await dbUpsertCharacter(MY_CHAR_ID, ROOM, me);
    }
  }
  let entry, diceArgs = null;
  if (rollMatch) {
    // Capped so something like "/roll 999999999d6" can't freeze the tab.
    const sides = rollMatch[2] ? Math.min(Math.max(parseInt(rollMatch[2]), 2), 1000) : 20;
    const count = rollMatch[2] ? Math.min(rollMatch[1] ? parseInt(rollMatch[1]) : 1, 100) : 1;
    const mod = rollMatch[3] ? parseInt(rollMatch[3]) : 0;
    const rest = rollMatch[4] || '';
    const modeMatch = rest.match(/\b(adv|dis)\b/i);
    const mode = modeMatch ? modeMatch[1].toLowerCase() : '';
    const label = rest.replace(/\b(adv|dis)\b/ig, '').replace(/\s+/g, ' ').trim().slice(0, 40);

    let rolls, roll, detail, dice;
    if (count === 1 && sides === 20 && (mode === 'adv' || mode === 'dis')) {
      const r1 = Math.floor(Math.random() * 20) + 1;
      const r2 = Math.floor(Math.random() * 20) + 1;
      roll = mode === 'adv' ? Math.max(r1, r2) : Math.min(r1, r2);
      detail = `d20(${r1},${r2} ${mode})`;
      const keepFirst = mode === 'adv' ? r1 >= r2 : r1 <= r2;
      dice = [{ v: r1, dropped: !keepFirst }, { v: r2, dropped: keepFirst }];
    } else {
      rolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
      roll = rolls.reduce((a, b) => a + b, 0);
      detail = (count === 1 && sides === 20) ? `d20(${rolls[0]})` : `${count}d${sides}(${rolls.join('+')})`;
      dice = rolls.map(v => ({ v, dropped: false }));
    }
    const total = roll + mod;
    const flagged = count === 1 && sides === 20 && isUnlistedModifier(me, mod, label);
    diceArgs = {
      sides, dice, mod, total, flagged,
      title: (label || (count === 1 && sides === 20 ? 'd20' : `${count}d${sides}`)) +
             (mode && count === 1 && sides === 20 ? ` · ${mode === 'adv' ? 'advantage' : 'disadvantage'}` : ''),
    };
    entry = { id: uid(6), author: authorName, type: 'roll',
      text: `rolls ${detail}${mod !== 0 ? ' ' + fmtMod(mod) : ''} = ${total}${label ? ' (' + label + ')' : ''}${flagged ? ' ' + UNLISTED_FLAG : ''}${ammoNote}` };
  } else {
    entry = { id: uid(6), author: authorName, type: 'action', text };
  }
  if (diceArgs) {
    // Start the popup right away and keep the result out of the log until the dice settle.
    heldLogIds.add(entry.id);
    const shown = showDiceRoll({
      ...diceArgs,
      onReveal: () => { heldLogIds.delete(entry.id); if (VIEW === 'game') render(); },
    });
    if (!shown) heldLogIds.delete(entry.id);
  }
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
}

function runChip(btn) {
  const key = btn.dataset.key;
  if (!key || isChipUsed(key)) return;
  markChipUsed(key);
  submitAction(btn.dataset.cmd);
}
function pickOption(btn) {
  const key = btn.dataset.key;
  if (!key || isChipUsed(key)) return;
  markChipUsed(key);
  submitAction(btn.dataset.act);
}

/* ---- when something breaks, players get an in-world excuse, never technical text ----
   (The real reason is in the browser console and the Netlify function log.) */
const GM_TROUBLE = [
  "The Game Master knocked over their tankard and is mopping ale out of the dice tray. Give them a few minutes, then ask again.",
  "The Game Master has nodded off behind the screen, snoring gently. Let them nap a few minutes, then try again.",
  "A goblin snatched the Game Master's notes and bolted. The chase is on. Try again in a few minutes.",
  "The Game Master's quill has run dry and they've gone hunting for more ink. Try again in a few minutes.",
  "The Game Master stepped out to settle a bar tab with the tavern keeper. It's a long tab. Try again in a few minutes.",
  "The Game Master is consulting a very old, very dusty rulebook. Try again in a few minutes.",
];
function friendlyTrouble(e) {
  if (e && e.name === 'TypeError') return "The road to the Game Master is washed out. Check your connection, then try again.";
  if (e && e.reason === 'room') return "The Game Master can't find this table in the ledger. Reopen the story with its code and try again.";
  return GM_TROUBLE[Math.floor(Math.random() * GM_TROUBLE.length)];
}

// kind 'story' = a Game Master story turn: the server adds its GM playbook and looks up stat blocks
// for any monsters named in `lore` (the recent log text).
async function fetchGM(prompt, signal, kind, lore) {
  const resp = await fetch(api('/api/gm'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, roomCode: ROOM, kind, lore, playerId: playerId() }),
    signal,
  });
  let data = {};
  try { data = await resp.json(); } catch (e) { /* a non-JSON error page; handled below */ }
  if (data.wallet) setWallet(data.wallet);
  if (data.outOfInk) {
    openShop(data.error);
    const err = new Error(data.error + ' Tap the ink badge at the top of the page to get more.');
    err.outOfInk = true;
    throw err;
  }
  if (!resp.ok || data.error) {
    const err = new Error(data.error || `Request failed (${resp.status})`);
    err.reason = data.reason || 'gm_down';
    throw err;
  }
  return data.text || '';
}

async function callGM(prompt, fallbackEntry) {
  GM_PENDING = true;
  GM_ABORT = new AbortController();
  if (VIEW === 'game') render();
  let entry;
  try {
    const text = await fetchGM(prompt, GM_ABORT.signal, 'story', LOG.slice(-8).map(e => e.text).join('\n'));
    entry = { id: uid(6), author: 'Game Master', type: 'gm', text: text || '(The GM pauses, gathering thoughts... try again in a moment.)' };
  } catch (e) {
    if (e.name === 'AbortError') {
      entry = { id: uid(6), author: 'The Ledger', type: 'system', text: 'Cancelled — ' + fallbackEntry };
    } else {
      console.error(e);
      entry = { id: uid(6), author: 'The Ledger', type: 'system', text: e.outOfInk ? e.message : friendlyTrouble(e) };
    }
  } finally {
    GM_PENDING = false;
    GM_ABORT = null;
  }
  const { clean, attacks, heals, gives, uses, damages, notes, foesAdded, hits, mapOps, defeats, successes, rests, stables, casts, features } = entry.type === 'gm' ? extractFoeAttacks(entry.text)
    : { clean: entry.text, attacks: [], heals: [], gives: [], uses: [], damages: [], notes: [], foesAdded: [], hits: [], mapOps: [], defeats: [], successes: [], rests: [], stables: [], casts: [], features: [] };
  // A message that was nothing but directives has no story text of its own to log.
  if (clean || !(attacks.length || heals.length || gives.length || uses.length || damages.length || notes.length || foesAdded.length || hits.length || mapOps.length || defeats.length || successes.length || rests.length || stables.length || casts.length || features.length)) {
    entry.text = clean || entry.text;
    await dbInsertLog(ROOM, entry);
    LOG.push({ ...entry, ts: Date.now() });
  }
  // Damage, healing and items change the sheet itself: save every character that changed.
  // XP is awarded before a rest, so a long rest in the same message can unlock a level-up.
  const results = [resolveMapOps(mapOps), ...casts.map(resolveCast), ...foesAdded.map(resolveFoe), ...attacks.map(resolveFoeAttack), ...hits.map(resolveHit), ...damages.map(resolveDamage), ...heals.map(resolveHeal), ...usesThenGives(uses, gives),
    ...defeats.map(resolveDefeat), ...successes.map(resolveSuccess), ...notes.map(resolveNote), ...rests.map(k => k === 'long' ? resolveLongRest() : resolveShortRest()), ...stables.map(resolveStable), ...features.map(resolveFeature)];
  for (const r of results.filter(Boolean)) {
    const { hpChar, saveAll, saveMeta, ...result } = r;
    await dbInsertLog(ROOM, result);
    LOG.push({ ...result, ts: Date.now() });
    if (saveAll) { for (const id of Object.keys(ROSTER)) await dbUpsertCharacter(id, ROOM, ROSTER[id]); }
    else if (hpChar && ROSTER[hpChar]) await dbUpsertCharacter(hpChar, ROOM, ROSTER[hpChar]);
    if (saveMeta && META) await dbUpdateRoomMeta(ROOM, META);
  }
  if (VIEW === 'game') render();
}

function cancelGM() {
  if (GM_ABORT) GM_ABORT.abort();
}

/* ---------------- Scene backgrounds ----------------
   One background per room, shown under the battle map (and on the /display page). It lives in the room's
   scene_url / scene_status columns (not meta, which the app rewrites wholesale on every map move).
   - Paint this scene (AI): needs the server switch (site-config.sceneImages), the room's opt-in
     (META.sceneImages, set by the host in How to Play), and the host; limited per room; costs ink once
     billing is on. Runs in scene-background.js, progress arrives through scene_status.
   - Upload your own background: host only, free, unlimited, works even with painting switched off.
   Every picture is content-checked on the server before it's stored. */
let SITE = { sceneImages: false, sceneMax: 3, sceneInk: 0 };
let SCENE = null; // { url, status, at, count } from the room row
const SCENE_URL_PREFIX = (cfg.SUPABASE_URL || '').replace(/\/$/, '') + '/storage/v1/object/public/scenes/';
function sceneFromRow(r) { return r ? { url: r.scene_url || '', status: r.scene_status || '', at: r.scene_updated_at || '', count: r.scene_count || 0 } : null; }
function safeSceneUrl(u) { return typeof u === 'string' && cfg.SUPABASE_URL && u.startsWith(SCENE_URL_PREFIX) && !/[\s"'<>()]/.test(u) ? u : ''; }
function isRoomHost() { return !!META && (!META.host || isMyHostId(META.host)); }
const SCENE_UPLOAD = { busy: false, error: '' };
let scenePaintRequested = 0;
function scenePending() {
  if (!SCENE) return false;
  const fresh = SCENE.at && Date.now() - Date.parse(SCENE.at) < 4 * 60 * 1000;
  return (SCENE.status === 'pending' && fresh) || (scenePaintRequested && Date.now() - scenePaintRequested < 20000 && SCENE.status !== 'ready' && !String(SCENE.status).startsWith('error:'));
}
function sceneControlsHTML() {
  const host = isRoomHost();
  const url = safeSceneUrl(SCENE && SCENE.url);
  const status = SCENE ? SCENE.status : '';
  const parts = [];
  if (scenePending()) parts.push(`<p class="thinking">The painter is at work on the scene<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></p>`);
  else if (String(status).startsWith('error:')) parts.push(`<p class="error-text">${escapeHtml(status.slice(6))}</p>`);
  if (host) {
    const btns = [];
    if (SITE.sceneImages && META.sceneImages === true) {
      const used = (SCENE && SCENE.count) || 0;
      const left = Math.max(0, SITE.sceneMax - used);
      btns.push(`<button class="btn" ${scenePending() || !left ? 'disabled' : ''} onclick="paintScene()" title="${left} of ${SITE.sceneMax} painted scenes left for this table">&#x1F3A8; Paint this scene${SITE.sceneInk ? ` <span class="ink-cost">(${SITE.sceneInk} ink)</span>` : ''}</button>`);
    }
    btns.push(SCENE_UPLOAD.busy
      ? `<span class="thinking">Uploading your background<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span>`
      : `<button class="btn" onclick="pickSceneUpload()">Upload your own background</button><input type="file" id="sceneFile" accept="image/*" hidden onchange="onSceneFile(this)">`);
    parts.push(`<div class="portrait-actions">${btns.join('')}</div>`);
    if (SCENE_UPLOAD.error) parts.push(`<p class="error-text">${escapeHtml(SCENE_UPLOAD.error)}</p>`);
    if (SITE.sceneImages && META.sceneImages !== true) parts.push(`<p class="helptext">To let the AI paint scenes here, switch it on in <b>How to Play</b>.</p>`);
    else if (SITE.sceneImages) parts.push(`<p class="helptext">${Math.max(0, SITE.sceneMax - ((SCENE && SCENE.count) || 0))} of ${SITE.sceneMax} painted scenes left for this table. Your own uploads are free and unlimited.</p>`);
  } else if (!url) {
    parts.push(`<p class="helptext">The table's host can set a scene background.</p>`);
  }
  return `<div class="scene-controls"><h3 style="font-size:1rem;margin:0 0 8px;">Scene</h3>${parts.join('')}</div>`;
}
function rerenderMap() { if (VIEW === 'game' && ACTIVE_TAB === 'map') renderMapTab(); }
async function paintScene() {
  if (!ROOM || scenePending()) return;
  scenePaintRequested = Date.now();
  if (SCENE) SCENE.status = '';
  rerenderMap();
  const body = JSON.stringify({ roomCode: ROOM, playerId: playerId(), platform: IS_APP ? 'android' : 'web' });
  try {
    // A background function answers 202 at once; progress arrives through the room's scene_status.
    await fetch(api('/.netlify/functions/scene-background'), IS_APP
      ? { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    // Backup for realtime: re-read the room a few times while painting.
    for (let i = 0; i < 24 && ROOM; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const r = await dbGetRoom(ROOM);
      if (r) { SCENE = sceneFromRow(r); rerenderMap(); }
      if (SCENE && (SCENE.status === 'ready' || String(SCENE.status).startsWith('error:')) && Date.now() - scenePaintRequested > 6000) break;
    }
  } catch (e) {
    console.error(e);
  } finally {
    scenePaintRequested = 0;
    rerenderMap();
  }
}
function pickSceneUpload() { SCENE_UPLOAD.error = ''; const f = el('sceneFile'); if (f) f.click(); }
// Crops to a centred 16:9 frame, at most 1280x720, in the browser (also drops hidden photo data).
async function sceneBlob(file) {
  const img = await loadImageFile(file);
  const w = img.width, h = img.height;
  if (!w || !h) throw new Error('unreadable');
  let sw = w, sh = Math.round(w * 9 / 16);
  if (sh > h) { sh = h; sw = Math.round(h * 16 / 9); }
  const ow = Math.min(1280, sw), oh = Math.round(ow * 9 / 16);
  const canvas = document.createElement('canvas');
  canvas.width = ow; canvas.height = oh;
  canvas.getContext('2d').drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh, 0, 0, ow, oh);
  if (img.close) img.close();
  let blob = await canvasBlob(canvas, 'image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', 0.82);
  if (!blob) throw new Error('unreadable');
  return blob;
}
async function onSceneFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !ROOM || SCENE_UPLOAD.busy) return;
  if (!/^image\//.test(file.type)) { SCENE_UPLOAD.error = 'Choose a picture file (JPG, PNG or WebP).'; return rerenderMap(); }
  const room = ROOM;
  SCENE_UPLOAD.busy = true; SCENE_UPLOAD.error = ''; rerenderMap();
  try {
    const blob = await sceneBlob(file);
    const image = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(new Error('read failed')); fr.readAsDataURL(blob); });
    const resp = await fetch(api('/api/scene-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: room, playerId: playerId(), platform: IS_APP ? 'android' : 'web', image }),
    });
    let data = {};
    try { data = await resp.json(); } catch (e) { /* non-JSON error page */ }
    if (data.reason === 'rejected' || data.reason === 'not_host') { SCENE_UPLOAD.error = data.error; return; }
    if (!resp.ok || !data.url) throw new Error(data.reason || `HTTP ${resp.status}`);
    SCENE = { ...(SCENE || {}), url: data.url, status: 'ready', at: new Date().toISOString() };
  } catch (e) {
    console.error(e);
    SCENE_UPLOAD.error = e && e.name === 'TypeError'
      ? 'Your background got lost on the road. Check your connection and try again.'
      : 'The scene painter dropped your canvas on the way in. Try again.';
  } finally {
    SCENE_UPLOAD.busy = false;
    if (ROOM === room) rerenderMap();
  }
}
// How to Play tab: the host switches AI scene painting on or off for this table.
async function setSceneImages(on) {
  if (!ROOM || !isRoomHost()) return;
  const room = await dbGetRoom(ROOM);
  if (!room) return;
  META = room.meta || {};
  META.sceneImages = !!on;
  if (!META.host) META.host = myHostId(); // older rooms: whoever switches it on becomes the host
  await dbUpdateRoomMeta(ROOM, META);
  if (VIEW === 'game' && ACTIVE_TAB === 'help') renderHelpTab();
}
window.paintScene = paintScene;
window.pickSceneUpload = pickSceneUpload;
window.onSceneFile = onSceneFile;
window.setSceneImages = setSceneImages;

/* ---------------- Field Notes: the party's journal ----------------
   What the party has learned along the way, for reference at the table: quests, people, places, clues,
   encounters and loot. Notes are log entries of type 'note' (text "Category|session|note"), so they're
   shared live with everyone and stored with the story. The GM adds them with [[note: People | ...]];
   players can add their own from the Field Notes tab. The GM gets the whole journal every turn, so it
   remembers things from long before the last 30 lines of the story. */
const NOTE_CATEGORIES = ['Quests', 'People', 'Places', 'Clues', 'Encounters', 'Loot'];
const NOTE_ICONS = { Quests: '&#x1F4DC;', People: '&#x1F464;', Places: '&#x1F5FA;', Clues: '&#x1F50D;', Encounters: '&#x2694;', Loot: '&#x1F48E;' };
const NOTE_DIRECTIVE = /\[\[\s*note:([^\]]*)\]\]/gi;
function noteCategory(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (/quest|task|goal|mission|job/.test(s)) return 'Quests';
  if (/people|person|npc|character|who|ally|enemy|faction/.test(s)) return 'People';
  if (/place|location|map|where|town|area|site/.test(s)) return 'Places';
  if (/encounter|fight|battle|combat|foe|monster/.test(s)) return 'Encounters';
  if (/loot|item|treasure|gold|reward/.test(s)) return 'Loot';
  return 'Clues';
}
function noteText(category, text) { return `${noteCategory(category)}|${(META && META.session) || 1}|${String(text || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim().slice(0, 300)}`; }
function parseNote(e) {
  const [cat, session, ...rest] = String(e.text || '').split('|');
  return { id: e.id, category: NOTE_CATEGORIES.includes(cat) ? cat : 'Clues', session: parseInt(session) || 1, text: rest.join('|'), author: e.author, ts: e.ts };
}
function allNotes() { return LOG.filter(e => e.type === 'note').map(parseNote).filter(n => n.text); }
// For the GM prompt: the whole journal, newest last, capped.
function notesPromptText() {
  const notes = allNotes();
  if (!notes.length) return 'Field notes (the party\'s journal): none yet.';
  let lines = notes.map(n => `${n.category}: ${n.text}${n.author && n.author !== 'Game Master' ? ` (noted by ${n.author})` : ''}`);
  while (lines.join('\n').length > 4000 && lines.length > 10) lines.shift(); // keep the newest
  return `Field notes (the party's journal so far; stay consistent with it):\n${lines.join('\n')}`;
}
// [[note: People | Old Maren is the village herbalist]]
function resolveNote(n) {
  const text = String(n.text || '').trim();
  if (!text) return null;
  return { id: uid(6), author: 'Game Master', type: 'note', text: noteText(n.category, text) };
}
// One note line inside the story log.
function noteEntryHTML(e) {
  const n = parseNote(e);
  return `<div class="entry note" data-id="${escapeAttr(e.id)}"><div class="text">${NOTE_ICONS[n.category] || ''} <i>Added to Field Notes (${escapeHtml(n.category)}):</i> ${escapeHtml(n.text)}</div></div>`;
}

let NOTES_FILTER = '';
let NOTE_DRAFT = { category: 'Clues', text: '' };
function renderNotesTab() {
  const notes = allNotes();
  const q = NOTES_FILTER.trim().toLowerCase();
  const shown = q ? notes.filter(n => (n.text + ' ' + n.category + ' ' + n.author).toLowerCase().includes(q)) : notes;
  const sections = NOTE_CATEGORIES.map(cat => {
    const list = shown.filter(n => n.category === cat);
    if (!list.length) return '';
    return `<div class="notes-section"><h3>${NOTE_ICONS[cat]} ${cat} <span class="notes-count">${list.length}</span></h3>
      <ul class="notes-list">${list.slice().reverse().map(n => `<li>${escapeHtml(n.text)}<span class="notes-meta">Session ${n.session}${n.author && n.author !== 'Game Master' ? ' &middot; noted by ' + escapeHtml(n.author) : ''}</span></li>`).join('')}</ul></div>`;
  }).join('');
  el('tabBody').innerHTML = `
    <div class="panel" style="max-width:760px;">
      <h2>Field Notes</h2>
      <p class="helptext">Everything your ${MODE === 'solo' ? 'hero has' : 'party has'} learned along the way: quests, people, places, clues, encounters and loot. The Game Master adds notes as the story unfolds${MODE === 'group' ? ', and everyone at the table can add their own' : ', and you can add your own'}.</p>
      <input type="text" id="notesSearch" class="notes-search" placeholder="Search your notes..." value="${escapeAttr(NOTES_FILTER)}" oninput="setNotesFilter(this.value)">
      ${sections || `<p class="helptext" style="margin-top:16px;">${q ? 'No notes match that search.' : 'No notes yet. They fill in as the story goes.'}</p>`}
      <div class="notes-add">
        <h3>Add a note</h3>
        <div class="notes-add-row">
          <select id="noteCategory" onchange="NOTE_DRAFT_SET('category', this.value)">${NOTE_CATEGORIES.map(c => `<option ${NOTE_DRAFT.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
          <input type="text" id="noteText" maxlength="300" placeholder="e.g. The miller swears the wolves came from the old mine" value="${escapeAttr(NOTE_DRAFT.text)}" oninput="NOTE_DRAFT_SET('text', this.value)" onkeydown="if(event.key==='Enter') addPlayerNote()">
          <button class="btn" onclick="addPlayerNote()">Add</button>
        </div>
      </div>
    </div>`;
}
function setNotesFilter(v) {
  NOTES_FILTER = v;
  const box = el('notesSearch');
  const pos = box ? box.selectionStart : null;
  renderNotesTab();
  const again = el('notesSearch');
  if (again) { again.focus(); if (pos !== null) again.setSelectionRange(pos, pos); }
}
function NOTE_DRAFT_SET(k, v) { NOTE_DRAFT[k] = v; }
async function addPlayerNote() {
  const text = String(NOTE_DRAFT.text || '').trim();
  if (!text || !ROOM) return;
  const me = ROSTER[MY_CHAR_ID];
  const entry = { id: uid(6), author: me ? me.name : 'A player', type: 'note', text: noteText(NOTE_DRAFT.category, text) };
  NOTE_DRAFT.text = '';
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  renderNotesTab();
}
window.setNotesFilter = setNotesFilter;
window.NOTE_DRAFT_SET = NOTE_DRAFT_SET;
window.addPlayerNote = addPlayerNote;

/* ---------------- Accounts, account tables, guest tables (see supabase/accounts.sql) ----------------
   Signing in is optional. It uses Supabase Auth in the browser: an emailed link (website) or the code in
   the same email (typed in; works in the Android app too). The account remembers this player's ink key,
   so ink, minis and hosted tables come back on any device. Signed-in players make account tables: only
   members can see them, friends join with the join code (as guests, via an anonymous session, unless the
   host turns that off), and the host can rotate the code. Everyone else plays guest tables as before. */
const AUTH = { session: null, user: null, ready: false };
const LINKED_KEY = 'ledger:linkedUser'; // which account this device's ink key was last linked to
const ACCT = { step: 'email', email: '', busy: false, msg: '', ok: false, merge: null, linking: false, notice: '' };
let TABLES = null;      // My tables (null = not loaded)
let ROOM_INFO = null;   // { kind, join_code, allow_guests, role, archived, character_id } for the room we're in
const signedIn = () => !!(AUTH.user && !AUTH.user.anonymous);
function setAuthFrom(s) {
  AUTH.session = s || null;
  const u = s && s.user;
  AUTH.user = u ? { id: u.id, email: u.email || '', anonymous: !!u.is_anonymous } : null;
}
function linkedUser() { try { return localStorage.getItem(LINKED_KEY) || ''; } catch (e) { return ''; } }
function markLinked(id) { try { id ? localStorage.setItem(LINKED_KEY, id) : localStorage.removeItem(LINKED_KEY); } catch (e) {} }
async function initAuth() {
  if (!supabase || !supabase.auth) { AUTH.ready = true; return; }
  try { const { data } = await supabase.auth.getSession(); setAuthFrom(data && data.session); } catch (e) {}
  AUTH.ready = true;
  supabase.auth.onAuthStateChange((event, session) => {
    setAuthFrom(session);
    if (signedIn() && linkedUser() !== AUTH.user.id) afterSignIn(); // a new sign-in (link, code, or another tab)
  });
  if (signedIn() && linkedUser() !== AUTH.user.id) await afterSignIn();
  if (signedIn()) loadTables();
  if (VIEW === 'landing' || VIEW === 'account') render();
}
async function accountCall(action) {
  let token = AUTH.session && AUTH.session.access_token;
  try { const { data } = await supabase.auth.getSession(); token = (data && data.session && data.session.access_token) || token; } catch (e) {}
  const resp = await fetch(api('/api/account'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, accessToken: token, playerId: playerId() }),
  });
  let data = {};
  try { data = await resp.json(); } catch (e) {}
  if (!resp.ok || data.error) throw new Error(data.error || 'Accounts are unavailable right now. Try again in a minute.');
  return data;
}
// Points this device at another ink key (the account's), here and in Google Play purchases.
async function switchInkKey(key) {
  if (!PLAYER_ID_RE.test(key) || key === playerId()) return;
  try { localStorage.setItem(PLAYER_KEY, key); } catch (e) { memoryPlayerId = key; }
  if (IS_APP && purchasesReady) {
    try { const P = await purchasesReady; await P.logIn({ appUserID: key }); } catch (e) { purchasesReady = null; }
  }
  await refreshMyHash();
  refreshWallet(IS_APP ? 'redeem' : 'balance').catch(() => {});
}
async function afterSignIn() {
  if (ACCT.linking || !signedIn()) return;
  ACCT.linking = true;
  try {
    const r = await accountCall('link');
    if (r.status === 'needs_merge') {
      ACCT.merge = { device: r.device || {}, inkKey: r.inkKey, oldKey: playerId() };
      VIEW = 'account'; render();
      return;
    }
    await switchInkKey(r.inkKey);
    markLinked(AUTH.user.id);
    ACCT.ok = true;
    ACCT.msg = r.status === 'new' ? 'Signed in. Your ink, minis and tables now stay with your account.' : 'Signed in. Your ink, minis and tables are here.';
    TABLES = null; loadTables();
    if (VIEW === 'account' || VIEW === 'landing') render();
  } catch (e) {
    ACCT.ok = false; ACCT.msg = niceError(e);
    if (VIEW === 'account' || VIEW === 'landing') render();
  } finally { ACCT.linking = false; }
}
async function mergeYes() {
  if (ACCT.busy) return;
  ACCT.busy = true; render();
  try {
    const r = await accountCall('merge');
    await switchInkKey(r.inkKey);
    markLinked(AUTH.user.id);
    const m = r.moved || {};
    ACCT.merge = null; ACCT.ok = true;
    ACCT.msg = `Moved into your account: ${m.ink || 0} ink, ${m.minis || 0} mini${m.minis === 1 ? '' : 's'} and ${m.tables || 0} hosted table${m.tables === 1 ? '' : 's'}.`;
    TABLES = null; loadTables();
  } catch (e) { ACCT.ok = false; ACCT.msg = niceError(e); }
  finally { ACCT.busy = false; render(); }
}
async function mergeNo() {
  const m = ACCT.merge;
  if (!m) return;
  if (!confirm(`Leave them on this device's old ink key? You'll stop seeing them here. To get them back later, enter this key in the Ink Pot:\n\n${m.oldKey}`)) return;
  await switchInkKey(m.inkKey);
  markLinked(AUTH.user.id);
  ACCT.merge = null; ACCT.ok = true; ACCT.msg = 'Signed in. Your old ink key was left as it was.';
  TABLES = null; loadTables(); render();
}

function openAccount() { closeShop(); VIEW = 'account'; ACCT.msg = ''; if (!signedIn()) ACCT.step = ACCT.step === 'code' ? 'code' : 'email'; render(); }
async function accountSend() {
  const email = ((el('acctEmail') || {}).value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { ACCT.ok = false; ACCT.msg = 'Enter a valid email address.'; return render(); }
  ACCT.busy = true; ACCT.msg = ''; render();
  try {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: IS_APP ? undefined : location.origin + '/' } });
    if (error) throw new Error(/rate|seconds/i.test(error.message || '') ? 'A sign-in email was sent a moment ago. Wait a minute, then try again.' : "We couldn't send the email just now. Try again in a minute.");
    ACCT.email = email; ACCT.step = 'code'; ACCT.ok = true;
    ACCT.msg = IS_APP ? 'Check your email and type the code here.' : 'Check your email: tap the link, or type the code here.';
  } catch (e) { ACCT.ok = false; ACCT.msg = niceError(e); }
  finally { ACCT.busy = false; render(); }
}
async function accountVerify() {
  const token = ((el('acctCode') || {}).value || '').replace(/\s+/g, '');
  if (!/^\d{6,10}$/.test(token)) { ACCT.ok = false; ACCT.msg = 'Enter the code from the email (numbers only).'; return render(); }
  ACCT.busy = true; ACCT.msg = ''; render();
  try {
    const { data, error } = await supabase.auth.verifyOtp({ email: ACCT.email, token, type: 'email' });
    if (error || !data || !data.session) throw new Error("That code didn't work. It may have expired: ask for a new one.");
    setAuthFrom(data.session);
    ACCT.step = 'email';
    await afterSignIn();
  } catch (e) { ACCT.ok = false; ACCT.msg = niceError(e); }
  finally { ACCT.busy = false; render(); }
}
// Signing out leaves nothing behind: this device starts over as a new guest (a shared phone keeps nothing).
async function accountSignOut() {
  if (!confirm('Sign out on this device? Your ink, minis and tables stay safe in your account; this device starts fresh.')) return;
  if (ROOM) leaveTable();
  try { await supabase.auth.signOut(); } catch (e) {}
  try {
    const keep = new Set(['ledger:diceAnim', 'ledger:tester']);
    Object.keys(localStorage).filter(k => k.startsWith('ledger:') && !keep.has(k)).forEach(k => localStorage.removeItem(k));
  } catch (e) {}
  memoryPlayerId = '';
  setAuthFrom(null); TABLES = null; ACCT.merge = null; ACCT.step = 'email';
  const fresh = playerId();
  if (IS_APP && purchasesReady) { try { const P = await purchasesReady; await P.logIn({ appUserID: fresh }); } catch (e) { purchasesReady = null; } }
  await refreshMyHash();
  refreshWallet('balance').catch(() => {});
  ACCT.ok = true; ACCT.msg = 'Signed out.';
  VIEW = 'landing'; render();
}
async function accountDelete() {
  if (!confirm('Delete your account? Your email is removed and this device keeps its ink key and the ink on it. Tables you own stay playable by their other members. This cannot be undone.')) return;
  ACCT.busy = true; render();
  try {
    await accountCall('delete');
    try { await supabase.auth.signOut(); } catch (e) {}
    setAuthFrom(null); markLinked(''); TABLES = null;
    ACCT.ok = true; ACCT.msg = 'Your account was deleted.';
  } catch (e) { ACCT.ok = false; ACCT.msg = niceError(e); }
  finally { ACCT.busy = false; render(); }
}

function renderAccount() {
  const msg = ACCT.msg ? `<p class="${ACCT.ok ? 'hero-note' : 'error-text'}">${escapeHtml(ACCT.msg)}</p>` : '';
  let body;
  if (ACCT.merge) {
    const d = ACCT.merge.device;
    body = `<h2>Move this device's things into your account?</h2>
      <p class="helptext">This device has things on its own ink key that aren't in your account yet:</p>
      <ul class="helptext"><li>${d.ink || 0} bought ink</li><li>${d.minis || 0} hero mini${d.minis === 1 ? '' : 's'}</li><li>${d.tables || 0} table${d.tables === 1 ? '' : 's'} you host</li></ul>
      <p class="helptext">Moving them is a one-time step. Free monthly ink isn't moved.</p>
      <button class="btn solid wide" ${ACCT.busy ? 'disabled' : ''} onclick="mergeYes()">Move them into my account</button>
      <button class="btn wide" style="margin-top:8px;" ${ACCT.busy ? 'disabled' : ''} onclick="mergeNo()">Leave them on this device's old key</button>`;
  } else if (signedIn()) {
    body = `<h2>Your account</h2>
      <p>Signed in as <b>${escapeHtml(AUTH.user.email || 'your email')}</b>.</p>
      <p class="helptext">Your ink, hero minis and tables are kept with your account. Sign in with the same email on any device, or after clearing this browser or reinstalling the app, and they come back.</p>
      <p class="helptext">New tables you create are private: only players you invite with the table's code can see them. Find them under <b>My tables</b> on the home page.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
        <button class="btn" onclick="accountSignOut()">Sign out</button>
        <button class="btn rust" ${ACCT.busy ? 'disabled' : ''} onclick="accountDelete()">Delete account</button>
      </div>`;
  } else if (ACCT.step === 'code') {
    body = `<h2>Check your email</h2>
      <p class="helptext">We sent a sign-in email to <b>${escapeHtml(ACCT.email)}</b>.${IS_APP ? '' : ' Tap its link, or'} type the code from it here:</p>
      <div class="notes-add-row"><input type="text" id="acctCode" inputmode="numeric" autocomplete="one-time-code" placeholder="Code from the email" maxlength="12"><button class="btn solid" ${ACCT.busy ? 'disabled' : ''} onclick="accountVerify()">Sign in</button></div>
      <p style="margin-top:10px;"><button class="link-btn" onclick="ACCT_back()">Use a different email</button> &middot; <button class="link-btn" ${ACCT.busy ? 'disabled' : ''} onclick="accountResend()">Send it again</button></p>`;
  } else {
    body = `<h2>Sign in</h2>
      <p class="helptext">Optional. Signing in keeps your ink, hero minis and tables safe if you clear this browser, reinstall the app or switch devices, and lets you make private tables. No password: we email you a sign-in link and code.</p>
      <div class="notes-add-row"><input type="email" id="acctEmail" autocomplete="email" placeholder="you@example.com" value="${escapeAttr(ACCT.email)}"><button class="btn solid" ${ACCT.busy ? 'disabled' : ''} onclick="accountSend()">Email me a sign-in code</button></div>
      <p class="helptext" style="margin-top:12px;">You can keep playing without an account. Guest tables are open to anyone with the code, and can be removed when space is needed.</p>`;
  }
  el('app').innerHTML = `
    <div class="top-nav"><button class="link-btn" onclick="goToLanding()">&larr; The Ledger</button></div>
    <div class="panel" style="max-width:560px;margin:0 auto;">
      <div class="eyebrow">Account</div>
      ${msg}
      ${body}
    </div>`;
}
function ACCT_back() { ACCT.step = 'email'; ACCT.msg = ''; render(); }
async function accountResend() { ACCT.step = 'email'; render(); const box = el('acctEmail'); if (box) { box.value = ACCT.email; await accountSend(); } }

// ---- My tables (landing page) ----
async function loadTables() {
  if (!signedIn()) { TABLES = null; return; }
  try {
    const { data, error } = await supabase.rpc('my_tables');
    TABLES = error ? [] : (data || []);
  } catch (e) { TABLES = []; }
  if (VIEW === 'landing') render();
}
function accountChipHTML() {
  if (!AUTH.ready) return '';
  return signedIn()
    ? `<p style="text-align:center;margin:10px 0 0;" class="helptext">Signed in as ${escapeHtml(AUTH.user.email)} &middot; <button class="link-btn" onclick="openAccount()">Account</button> &middot; <button class="link-btn" onclick="openMyMinis()">My minis</button></p>`
    : `<p style="text-align:center;margin:10px 0 0;"><button class="link-btn" onclick="openAccount()">Sign in</button> &middot; <button class="link-btn" onclick="openMyMinis()">My minis</button></p>
       <p class="helptext" style="text-align:center;margin:6px 0 0;">Guest tables are open to anyone with the code, and can be removed when space is needed. Sign in to make a private table and keep your ink.</p>`;
}
function myTablesHTML() {
  if (!signedIn()) return '';
  const notice = ACCT.notice ? `<p class="hero-note">${escapeHtml(ACCT.notice)}</p>` : '';
  if (TABLES === null) return `<div class="panel my-tables">${notice}<h3>My tables</h3><p class="thinking">Opening your tables...</p></div>`;
  if (!TABLES.length) return `<div class="panel my-tables">${notice}<h3>My tables</h3><p class="helptext">No tables yet. Start a story above and it's saved here.</p></div>`;
  const rows = TABLES.map(t => `<div class="mini-row"><div class="mini-row-head">
      <div><b>${escapeHtml(t.name)}</b> <span class="helptext">${t.mode === 'solo' ? 'Solo' : 'Group'}${t.character ? ' &middot; ' + escapeHtml(t.character) : ''}${t.role === 'guest' ? ' &middot; guest' : ''}</span>
        <div class="notes-meta">${t.archived ? 'Archived &middot; ' : ''}last played ${timeAgo(t.last_played)}</div></div>
      <div style="display:flex;gap:6px;">
        <button class="btn solid" onclick="resumeTable('${escapeAttr(t.room)}')">Resume</button>
        ${t.owner ? `<button class="btn" onclick="archiveTable('${escapeAttr(t.room)}', ${t.archived ? 'false' : 'true'})">${t.archived ? 'Restore' : 'Archive'}</button>` : ''}
      </div></div></div>`).join('');
  return `<div class="panel my-tables">${notice}<h3>My tables</h3>
    <p class="helptext">Private: only members can see them. You can keep ${5} active; starting another archives the one you played least recently.</p>${rows}</div>`;
}
async function resumeTable(room) {
  const t = (TABLES || []).find(x => x.room === room);
  if (t && t.archived) { await archiveTable(room, false, true); }
  if (t && t.character_id && !recallCharacter(room)) rememberCharacter(room, t.character_id);
  const err = await enterRoom(room);
  if (err) { ACCT.ok = false; ACCT.notice = err; render(); }
}
async function archiveTable(room, archive, quiet) {
  const { data, error } = await supabase.rpc('archive_room', { p_room: room, p_archive: archive });
  if (error || !data || !data.ok) { ACCT.notice = "That table couldn't be changed. Try again."; }
  else if (!archive && data.archived && data.archived.length) ACCT.notice = 'To make room, the table you played least recently was archived.';
  else if (!quiet) ACCT.notice = '';
  TABLES = null; await loadTables();
}

// ---- joining by code: guest rooms, and account tables' join codes ----
const JOIN_ERRORS = {
  private: 'This table is private: its host only lets signed-in players join. Sign in, then enter the code again.',
  sign_in: 'This is a private table. Sign in to join it.',
};
async function joinByCode(code) {
  if (!supabase || !supabase.rpc) return { error: '' };
  const prev = recallCharacter(code);
  const call = () => supabase.rpc('join_room', { p_code: code, p_character: (prev && prev.characterId) || null });
  let { data: r, error } = await call();
  if (!error && r && r.code === 'sign_in' && supabase.auth && supabase.auth.signInAnonymously) {
    // A friend without an account joins as a guest: an anonymous session the table's rules can recognise.
    const a = await supabase.auth.signInAnonymously();
    if (!a.error) { setAuthFrom(a.data && a.data.session); ({ data: r, error } = await call()); }
  }
  if (error || !r) return { error: '' };
  if (!r.ok) return { error: JOIN_ERRORS[r.code] || '' };
  if (prev && r.room !== code) rememberCharacter(r.room, prev.characterId);
  return { room: r.room };
}
async function dbRoomInfo(code) {
  if (!supabase || !supabase.rpc) return { kind: 'guest' };
  try { const { data } = await supabase.rpc('room_info', { p_room: code }); return data || { kind: 'guest' }; } catch (e) { return { kind: 'guest' }; }
}
const inviteCode = () => (ROOM_INFO && ROOM_INFO.kind === 'account' && ROOM_INFO.join_code) || ROOM;

// ---- in a game: save a guest table to the account, and the account table's settings ----
function tableButtonHTML() {
  if (!ROOM_INFO) return '';
  if (ROOM_INFO.kind === 'guest') return signedIn() && isRoomHost() ? `<button class="btn" onclick="upgradeTable()" title="Make this a private table on your account">Save to my account</button>` : '';
  return `<button class="btn" onclick="openTableSettings()">Table</button>`;
}
async function upgradeTable() {
  if (!confirm('Save this table to your account? It becomes private: only players with its code can join, and it shows in My tables. Players already here keep their heroes.')) return;
  const { data, error } = await supabase.rpc('upgrade_room', { p_room: ROOM, p_character: MY_CHAR_ID });
  if (error || !data || !data.ok) {
    const why = data && data.code === 'not_host' ? "Only the table's host can save it to an account." : "That didn't work. Try again.";
    return alert(why);
  }
  ROOM_INFO = await dbRoomInfo(ROOM);
  TABLES = null;
  const note = data.archived && data.archived.length ? ' To make room, the table you played least recently was archived.' : '';
  alert('Saved. This table is now private on your account. The code still works for your players.' + note);
  render();
}
function openTableSettings() {
  let o = el('shopOverlay');
  if (!o) { o = document.createElement('div'); o.id = 'shopOverlay'; o.className = 'dice-overlay shop-overlay'; o.onclick = e => { if (e.target === o) closeShop(); }; document.body.appendChild(o); }
  const i = ROOM_INFO || {};
  const host = i.role === 'host';
  o.innerHTML = `<div class="dice-card shop-card" role="dialog" aria-label="Table settings">
    <div class="dice-title">This table</div>
    <p class="helptext">A private table: only its members can see the story. Friends join with this code.</p>
    <div class="shop-balance"><span class="room-code">${escapeHtml(i.join_code || '')}</span></div>
    ${host ? `
      <p class="helptext">New code: the old code and old invite links stop working. Everyone already at the table stays.</p>
      <button class="btn wide" onclick="rotateTableCode()">Make a new code</button>
      <label class="helptext" style="display:flex;gap:8px;align-items:center;margin-top:12px;"><input type="checkbox" ${i.allow_guests ? 'checked' : ''} onchange="setTableGuests(this.checked)"> Let friends without an account join as guests</label>`
      : `<p class="helptext">You're ${i.role === 'guest' ? 'a guest' : 'a player'} at this table.</p>`}
    <button class="btn wide" style="margin-top:14px;" onclick="closeShop()">Close</button>
  </div>`;
}
async function rotateTableCode() {
  if (!confirm('Make a new code? The old code and links stop working.')) return;
  const { data } = await supabase.rpc('rotate_room_code', { p_room: ROOM });
  if (data && data.ok) { ROOM_INFO.join_code = data.join_code; openTableSettings(); render(); }
}
async function setTableGuests(on) {
  const { data } = await supabase.rpc('set_room_guests', { p_room: ROOM, p_allow: !!on });
  if (data && data.ok) ROOM_INFO.allow_guests = !!on;
  openTableSettings();
}
function accountNudgeHTML() {
  return signedIn() ? '' : `<p class="helptext">Clearing this browser or reinstalling the app loses your ink key. <button class="link-btn" onclick="openAccount()">Sign in to keep your ink and minis</button></p>`;
}

window.openAccount = openAccount; window.accountSend = accountSend; window.accountVerify = accountVerify;
window.accountSignOut = accountSignOut; window.accountDelete = accountDelete; window.ACCT_back = ACCT_back; window.accountResend = accountResend;
window.mergeYes = mergeYes; window.mergeNo = mergeNo; window.resumeTable = resumeTable; window.archiveTable = archiveTable;
window.upgradeTable = upgradeTable; window.openTableSettings = openTableSettings; window.rotateTableCode = rotateTableCode; window.setTableGuests = setTableGuests;

/* ---------------- Hero minis: forge, My minis, backups, moves, recovery ----------------
   All of it goes through /api/minis (netlify/functions/minis.js); nothing here is trusted by the server. */
async function minisCall(action, extra) {
  const resp = await fetch(api('/api/minis'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, playerId: playerId(), platform: IS_APP ? 'android' : 'web', ...(extra || {}) }),
  });
  let data = {};
  try { data = await resp.json(); } catch (e) { /* non-JSON error page */ }
  if (!resp.ok || data.error) {
    const err = new Error(data.error || "The mini records are out of reach right now. Try again in a moment.");
    err.reason = data.reason; err.problems = data.problems;
    throw err;
  }
  return data;
}
const niceError = e => (e && e.name === 'TypeError') ? 'The road to the mini records is washed out. Check your connection and try again.' : (e && e.message) || 'That didn\'t work. Try again.';

// ---- forging a hero onto a blank mini (Your Sheet, or tapping the blank mini) ----
const FORGE = { busy: false, msg: '', ok: false };
function forgePanelHTML(c, tagId) {
  if (!c || c.heroTag) return '';
  return `<div class="mini-panel">
    <p class="helptext"><b>Have a blank mini from a kit?</b> Enter the claim code from its card to forge ${escapeHtml(c.name)} onto it. The first hero on a blank mini is free. From then on, a tap of the mini brings ${escapeHtml(c.name)} back, and progress saves to it.</p>
    <div class="notes-add-row">
      <input type="text" id="forgeCode" placeholder="Claim code, e.g. LDGR-7K2M-9QXP-4TRC" autocomplete="off" spellcheck="false" style="text-transform:uppercase;">
      <button class="btn" ${FORGE.busy ? 'disabled' : ''} onclick="forgeHero(${tagId ? `'${escapeAttr(tagId)}'` : ''})">Forge into a mini</button>
    </div>
    ${FORGE.msg ? `<p class="${FORGE.ok ? 'hero-note' : 'error-text'}">${escapeHtml(FORGE.msg)}</p>` : ''}
  </div>`;
}
async function forgeHero(tagId) {
  const box = el('forgeCode');
  const code = box ? box.value.trim() : '';
  if (!code || FORGE.busy || !ROOM || !MY_CHAR_ID) return;
  FORGE.busy = true; FORGE.msg = ''; render();
  try {
    const r = await minisCall('forge', { claimCode: code, roomCode: ROOM, characterId: MY_CHAR_ID, tagId: tagId || undefined });
    const c = ROSTER[MY_CHAR_ID];
    if (c) c.heroTag = r.tag_id;
    FORGE.ok = true; FORGE.msg = `Forged! ${c ? c.name : 'Your hero'} now lives on that mini (kit ${r.batch}, #${r.serial}). Tap it any time to bring them back.`;
  } catch (e) {
    FORGE.ok = false; FORGE.msg = niceError(e);
  } finally {
    FORGE.busy = false;
    if (VIEW === 'tag') { VIEW = 'game'; ACTIVE_TAB = 'sheet'; }
    render();
  }
}
window.forgeHero = forgeHero;

// Tapped a blank mini: forge the hero this device is playing at its current table.
function tagBlankHTML() {
  const code = TAG_ROOM && TAG_ROOM.code;
  const mine = code ? recallCharacter(code) : null;
  return `<h2>A blank mini</h2>
    <p class="helptext">This mini doesn't have a hero yet. Forge one of yours onto it with the claim code from the card in your kit. The first hero is free.</p>
    ${code && mine
      ? `<button class="btn solid wide" onclick="tagGoForge('${escapeAttr(code)}')">Forge my hero from ${escapeHtml(TAG_ROOM.name)}</button>`
      : `<p class="helptext">Join a table and make (or bring) your hero first, then tap this mini again.</p>`}
    <p class="helptext">Have a backup file instead? Open <a href="#" onclick="openMyMinis();return false;">My minis</a> and use <b>Import a backup</b> with this mini's claim code.</p>`;
}
async function tagGoForge(code) {
  const err = await enterRoom(code);
  if (err) { VIEW = 'tag'; TAG_MSG = err; return render(); }
  FORGE.msg = ''; FORGE.ok = false;
  FORGE_TAG = TAG ? TAG.id : null;
  VIEW = 'game'; ACTIVE_TAB = 'sheet'; render();
}
let FORGE_TAG = null; // the blank mini that was just tapped, so the forge checks the code belongs to it
window.tagGoForge = tagGoForge;

// ---- My minis ----
const MINIS = { list: null, open: null, snaps: {}, msg: '', ok: false, busy: false, backupText: '' };
function openMyMinis() { VIEW = 'minis'; MINIS.msg = ''; MINIS.list = null; render(); loadMyMinis(); }
async function loadMyMinis() {
  try { MINIS.list = (await minisCall('list')).minis || []; }
  catch (e) { MINIS.list = []; MINIS.ok = false; MINIS.msg = niceError(e); }
  if (VIEW === 'minis') render();
}
const timeAgo = t => { if (!t) return 'never'; const d = (Date.now() - Date.parse(t)) / 86400000; return d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`; };
function renderMinis() {
  const list = MINIS.list;
  const rows = list === null ? '<p class="thinking">Opening your collection...</p>'
    : !list.length ? '<p class="helptext">No minis yet. Forge a hero onto a blank mini from <b>Your Sheet</b>, or save progress to a mini you play.</p>'
    : list.map(m => {
      const open = MINIS.open === m.id;
      const snaps = MINIS.snaps[m.id];
      return `<div class="mini-row">
        <div class="mini-row-head">
          <div><b>${escapeHtml(m.name)}</b> <span class="helptext">Lv${m.level} ${escapeHtml([m.race, m.klass].filter(Boolean).join(' '))}</span>
            <div class="notes-meta">${m.status === 'moved' ? 'Moved to a new mini' : m.status === 'active' ? 'Active' : escapeHtml(m.status)} &middot; last played ${timeAgo(m.last_played)}</div></div>
          ${m.status === 'active' ? `<button class="btn" onclick="toggleMini('${escapeAttr(m.id)}')">${open ? 'Close' : 'Manage'}</button>` : ''}
        </div>
        ${open ? `<div class="mini-row-body">
          <h3>Backups</h3>
          ${snaps === undefined ? '<p class="thinking">Loading...</p>' : !snaps.length ? '<p class="helptext">No saved versions yet.</p>'
            : `<ul class="notes-list">${snaps.map(s => `<li>Level ${s.level}, ${s.maxhp} max HP, ${s.items} items <span class="notes-meta">${new Date(s.saved_at).toLocaleString()}</span> <button class="link-btn" ${MINIS.busy ? 'disabled' : ''} onclick="restoreMini('${escapeAttr(m.id)}', ${Number(s.id)})">Restore this</button></li>`).join('')}</ul>`}
          <button class="btn" onclick="downloadMini('${escapeAttr(m.id)}')">Download backup</button>
          <h3 style="margin-top:14px;">Move to a new mini</h3>
          <p class="helptext">Lost or broken mini? Enter a new blank mini's claim code. ${escapeHtml(m.name)} moves to it, and the old mini will only say it has moved.</p>
          <div class="notes-add-row"><input type="text" id="moveCode" placeholder="New mini's claim code" autocomplete="off" style="text-transform:uppercase;"><button class="btn" ${MINIS.busy ? 'disabled' : ''} onclick="moveMini('${escapeAttr(m.id)}')">Move</button></div>
        </div>` : ''}
      </div>`;
    }).join('');
  el('app').innerHTML = `
    <div class="top-nav"><button class="link-btn" onclick="goToLanding()">&larr; The Ledger</button></div>
    <div class="panel" style="max-width:720px;margin:0 auto;">
      <div class="eyebrow">Your Collection</div>
      <h2>My minis</h2>
      <p class="helptext">Heroes on minis that belong to your ink key: <code class="ink-key">${escapeHtml(playerId())}</code>. Keep it private. If you lose it, a mini's original claim code can recover it below.</p>
      ${accountNudgeHTML()}
      ${MINIS.msg ? `<p class="${MINIS.ok ? 'hero-note' : 'error-text'}">${escapeHtml(MINIS.msg)}</p>` : ''}
      ${MINIS.backupText ? `<div class="field"><label>Your backup (copy and keep it somewhere safe)</label><textarea readonly style="min-height:120px;" onclick="this.select()">${escapeHtml(MINIS.backupText)}</textarea></div>` : ''}
      ${rows}
      <div class="notes-add">
        <h3>Import a backup</h3>
        <p class="helptext">Restores a hero from a backup file. An unchanged backup brings back its mini exactly; to put it on a <b>new blank mini</b>, add that mini's claim code. Files that were edited can only make a new level 1 hero.</p>
        <input type="file" id="importFile" accept=".json,application/json" onchange="readImportFile(this)">
        <textarea id="importText" placeholder="...or paste the backup text here" style="min-height:70px;margin-top:8px;"></textarea>
        <div class="notes-add-row" style="margin-top:8px;"><input type="text" id="importCode" placeholder="Blank mini's claim code (optional)" autocomplete="off" style="text-transform:uppercase;"><button class="btn" ${MINIS.busy ? 'disabled' : ''} onclick="importMini()">Import</button></div>
      </div>
      <div class="notes-add">
        <h3>Recover a mini</h3>
        <p class="helptext">Lost your ink key (new phone, cleared browser)? Enter the mini's link or tap address and its <b>original claim code</b> to make it yours again here.</p>
        <div class="notes-add-row"><input type="text" id="recoverTag" placeholder="Mini link, e.g. thedndledger.com/t/h_..." autocomplete="off"><input type="text" id="recoverCode" placeholder="Original claim code" autocomplete="off" style="text-transform:uppercase;"><button class="btn" ${MINIS.busy ? 'disabled' : ''} onclick="recoverMini()">Recover</button></div>
      </div>
    </div>`;
}
async function minisAction(fn) {
  if (MINIS.busy) return;
  MINIS.busy = true; MINIS.msg = ''; render();
  try { await fn(); } catch (e) { MINIS.ok = false; MINIS.msg = niceError(e); }
  finally { MINIS.busy = false; if (VIEW === 'minis') render(); }
}
async function toggleMini(id) {
  MINIS.open = MINIS.open === id ? null : id;
  MINIS.backupText = '';
  render();
  if (MINIS.open === id) {
    try { MINIS.snaps[id] = (await minisCall('snapshots', { tagId: id })).snapshots || []; }
    catch (e) { MINIS.snaps[id] = []; MINIS.ok = false; MINIS.msg = niceError(e); }
    if (VIEW === 'minis') render();
  }
}
function restoreMini(id, snapshotId) {
  if (!confirm('Restore this saved version? Your current version is kept as a backup too.')) return;
  minisAction(async () => {
    await minisCall('restore', { tagId: id, snapshotId });
    MINIS.ok = true; MINIS.msg = 'Restored. The next tap of that mini brings this version back.';
    MINIS.snaps[id] = (await minisCall('snapshots', { tagId: id })).snapshots || [];
    await loadMyMinis();
  });
}
function downloadMini(id) {
  minisAction(async () => {
    const { file } = await minisCall('export', { tagId: id });
    const text = JSON.stringify(file, null, 2);
    if (IS_APP) { MINIS.backupText = text; MINIS.ok = true; MINIS.msg = 'Here is your backup. Copy it and keep it somewhere safe.'; return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `${(file.hero && file.hero.name || 'hero').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-backup.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    MINIS.ok = true; MINIS.msg = 'Backup downloaded.';
  });
}
function moveMini(id) {
  const code = (el('moveCode') || {}).value || '';
  if (!code.trim()) return;
  if (!confirm('Move this hero to the new mini? The old mini will stop working and only say it has moved.')) return;
  minisAction(async () => {
    const r = await minisCall('move', { tagId: id, claimCode: code.trim() });
    MINIS.ok = true; MINIS.msg = 'Moved. Tap the new mini to keep playing; the old one now says it has moved.';
    MINIS.open = null;
    await loadMyMinis();
    return r;
  });
}
function readImportFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => { const t = el('importText'); if (t) t.value = String(fr.result || ''); };
  fr.readAsText(f);
}
function importMini() {
  const text = ((el('importText') || {}).value || '').trim();
  const code = ((el('importCode') || {}).value || '').trim();
  if (!text) return;
  let file;
  try { file = JSON.parse(text); } catch (e) { MINIS.ok = false; MINIS.msg = "That isn't a Ledger hero backup."; return render(); }
  minisAction(async () => {
    await minisCall('import', { file, claimCode: code || undefined });
    MINIS.ok = true; MINIS.msg = code ? 'Imported onto the new mini. Tap it to play.' : 'Backup restored onto its mini.';
    await loadMyMinis();
  });
}
function recoverMini() {
  const raw = ((el('recoverTag') || {}).value || '').trim();
  const code = ((el('recoverCode') || {}).value || '').trim();
  const m = /(h_[a-z0-9]{10,40})/.exec(raw);
  if (!m || !code) { MINIS.ok = false; MINIS.msg = 'Enter the mini\'s link and its claim code.'; return render(); }
  minisAction(async () => {
    await minisCall('recover', { tagId: m[1], claimCode: code });
    MINIS.ok = true; MINIS.msg = 'Recovered. That mini belongs to this ink key now.';
    await loadMyMinis();
  });
}
window.openMyMinis = openMyMinis;
window.toggleMini = toggleMini;
window.restoreMini = restoreMini;
window.downloadMini = downloadMini;
window.moveMini = moveMini;
window.readImportFile = readImportFile;
window.importMini = importMini;
window.recoverMini = recoverMini;

/* ---------------- Battle map ----------------
   A square grid (1 square = 5 ft) kept in the room's meta.grid, so every player sees it live through the
   rooms realtime channel. The GM sets it up and moves foes with directives:
     [[map: 12x10]]                     start (or reset) a battle map, up to 20x20
     [[place: Goblin A | F3]]           put or move a token (a hero's exact name moves that hero)
     [[wall: D2-D5, H7]]                walls / heavy cover squares (single squares or straight runs)
     [[remove: Goblin A]]               take a token off (fled, gone); [[defeat]] also removes it
     [[end-battle]]                     clear the map
   Players move their own hero by tapping it, then a highlighted square; the game limits the move to their
   speed for the turn (until the GM's next message) and won't let them walk through walls or foes.
   The GM gets every token's square and the distance between heroes and foes in its prompt. */
const MAP_MAX = 20;
const MAP_DIRECTIVE = /\[\[\s*(map|place|wall|remove|end-battle)\s*(?::([^\]]*))?\]\]/gi;
const colName = x => String.fromCharCode(65 + x);
const sq = (x, y) => `${colName(x)}${y + 1}`;
function parseSquare(s) {
  const m = /^\s*([A-Ta-t])\s*(\d{1,2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  return { x: m[1].toUpperCase().charCodeAt(0) - 65, y: parseInt(m[2]) - 1 };
}
const feetBetween = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 5;
function heroSpeed(c) {
  const n = parseInt(c && c.speed);
  if (n >= 5 && n <= 120) return n;
  return /dwarf|halfling|gnome/i.test((c && c.race) || '') ? 25 : 30;
}
function mapState() { return META && META.grid && META.grid.w ? META.grid : null; }
function tokenKey(name) { return String(name || '').trim().toLowerCase(); }
function inBounds(g, p) { return p && p.x >= 0 && p.y >= 0 && p.x < g.w && p.y < g.h; }
function wallSet(g) { return new Set(g.walls || []); }
function tokenAt(g, x, y) { return (g.tokens || []).find(t => t.x === x && t.y === y); }

// Applies a GM message's map directives to META.grid. Returns a short log line, or null.
function resolveMapOps(ops) {
  if (!ops.length || !META) return null;
  const notes = [];
  let ammoBack = false;
  for (const op of ops) {
    const g = META.grid && META.grid.w ? META.grid : null;
    if (op.kind === 'end-battle') {
      if (META.foes) META.foes = {};
      if (g) { META.grid = null; notes.push('the battle map is cleared'); }
      const back = recoverAmmo(); if (back.length) { notes.push(...back); ammoBack = true; }
      continue;
    }
    if (op.kind === 'map') {
      const m = /(\d{1,2})\s*[x×]\s*(\d{1,2})/i.exec(op.body);
      const w = Math.min(MAP_MAX, Math.max(4, m ? parseInt(m[1]) : 12));
      const h = Math.min(MAP_MAX, Math.max(4, m ? parseInt(m[2]) : 10));
      META.grid = { w, h, tokens: [], walls: [], moved: {} };
      notes.push(`battle map ${w}×${h} (1 square = 5 ft)`);
      continue;
    }
    if (op.kind === 'remove') {
      // Out of the fight for good (fled, surrendered, left): off the map AND off the Foes/Allies list. No XP.
      const name = op.body.split('|')[0].trim();
      if (!name) continue;
      let off = false;
      if (g) { const before = (g.tokens || []).length; g.tokens = (g.tokens || []).filter(t => tokenKey(t.name) !== tokenKey(name)); off = g.tokens.length < before; }
      const table = foeTable(), k = name.toLowerCase();
      const rec = table[k] || Object.values(table).find(f => f.name.toLowerCase() === k);
      if (rec) dropFoe(rec);
      if (off || rec) notes.push(`${rec ? rec.name : name} leaves the fight`);
      continue;
    }
    if (!g) continue;
    if (op.kind === 'place') {
      const [who, at, role] = op.body.split('|').map(s => s.trim());
      const p = parseSquare(at);
      if (!who) continue;
      if (!inBounds(g, p) || wallSet(g).has(sq(p.x, p.y))) { notes.push(`couldn't place ${who} at ${at || '?'}`); continue; }
      const hero = findTarget(who);
      const heroId = hero ? charIdOf(hero) : null;
      const name = heroId ? hero.name : who.slice(0, 30);
      const other = tokenAt(g, p.x, p.y);
      if (other && tokenKey(other.name) !== tokenKey(name)) { notes.push(`couldn't move ${name} to ${sq(p.x, p.y)}: ${other.name} is there`); continue; }
      g.tokens = (g.tokens || []).filter(t => tokenKey(t.name) !== tokenKey(name));
      const kind = heroId ? 'hero' : (/ally|friend/i.test(role || '') ? 'ally' : 'foe');
      g.tokens.push({ name, kind, charId: heroId || undefined, x: p.x, y: p.y });
      if (kind === 'ally' && !findFoe(name)) addFoe(name, '', true);
      notes.push(`${name} at ${sq(p.x, p.y)}`);
      continue;
    }
    if (op.kind === 'wall') {
      const walls = wallSet(g);
      for (const part of op.body.split(',')) {
        const [a, b] = part.split('-').map(parseSquare);
        if (!inBounds(g, a)) continue;
        const end = inBounds(g, b) && (b.x === a.x || b.y === a.y) ? b : a;
        for (let x = Math.min(a.x, end.x); x <= Math.max(a.x, end.x); x++)
          for (let y = Math.min(a.y, end.y); y <= Math.max(a.y, end.y); y++)
            if (!tokenAt(g, x, y) && walls.size < 120) walls.add(sq(x, y));
      }
      g.walls = [...walls];
      continue;
    }
  }
  return { id: uid(6), author: 'The Ledger', type: 'system', text: `🗺 ${notes.length ? notes.join(' · ') : 'battle map updated'}.`, saveMeta: true, saveAll: ammoBack };
}
function removeTokenNamed(name) {
  const g = mapState();
  if (!g) return false;
  const before = g.tokens.length;
  g.tokens = g.tokens.filter(t => tokenKey(t.name) !== tokenKey(name));
  return g.tokens.length < before;
}

// For the GM: every token's square plus hero-to-foe distances.
function mapPromptText() {
  const g = mapState();
  if (!g) return 'Battle map: none right now. If a fight starts, set one up (see the battle map rules).';
  const toks = g.tokens || [];
  const heroes = toks.filter(t => t.kind === 'hero');
  const foes = toks.filter(t => t.kind === 'foe');
  const lines = toks.map(t => `${t.name} (${t.kind}) at ${sq(t.x, t.y)}`);
  const dist = heroes.flatMap(h => foes.map(f => `${h.name} ↔ ${f.name}: ${feetBetween(h, f)} ft`));
  const unplaced = Object.values(ROSTER).filter(c => !heroes.some(h => tokenKey(h.name) === tokenKey(c.name))).map(c => c.name);
  return `Battle map (${g.w}×${g.h} squares, columns A-${colName(g.w - 1)}, rows 1-${g.h}, 1 square = 5 ft, distances count diagonals as 5 ft):
${lines.join('\n') || 'No tokens yet.'}
${g.walls && g.walls.length ? 'Walls / heavy cover: ' + g.walls.join(', ') : 'No walls.'}
${dist.length ? 'Distances: ' + dist.join('; ') : ''}${unplaced.length ? '\nNot on the map yet (place them): ' + unplaced.join(', ') : ''}`;
}

// ---- the Map tab ----
let MAP_SELECTED = false; // the player has tapped their own token and is choosing a square
let MAP_INFO = '';        // last tapped square's description
let MAP_BUSY = false;
function myToken(g) { return (g.tokens || []).find(t => t.charId === MY_CHAR_ID) || (g.tokens || []).find(t => t.kind === 'hero' && ROSTER[MY_CHAR_ID] && tokenKey(t.name) === tokenKey(ROSTER[MY_CHAR_ID].name)); }
function movedThisTurn(g) {
  const m = (g.moved || {})[MY_CHAR_ID];
  return m && m.gm === gmCount() ? m.ft : 0;
}
// Squares my hero can reach this turn: walk around walls and foes (5 ft per step, diagonals too).
function reachable(g) {
  const me = myToken(g);
  if (!me) return new Map();
  const steps = Math.floor((heroSpeed(ROSTER[MY_CHAR_ID]) - movedThisTurn(g)) / 5);
  const walls = wallSet(g);
  const foes = new Set((g.tokens || []).filter(t => t.kind === 'foe').map(t => `${t.x},${t.y}`));
  const out = new Map();
  const seen = new Map([[`${me.x},${me.y}`, 0]]);
  let frontier = [me];
  for (let s = 1; s <= steps; s++) {
    const next = [];
    for (const p of frontier) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const q = { x: p.x + dx, y: p.y + dy };
        const k = `${q.x},${q.y}`;
        if ((!dx && !dy) || !inBounds(g, q) || seen.has(k) || walls.has(sq(q.x, q.y)) || foes.has(k)) continue;
        seen.set(k, s);
        next.push(q);
        if (!tokenAt(g, q.x, q.y)) out.set(k, s * 5); // can pass allies, but not stop on them
      }
    }
    frontier = next;
  }
  return out;
}
// Opens /display?room=CODE: a read-only, live, full-screen view of the map and HP for a TV or second monitor.
function displayLinkHTML() {
  const href = `${IS_APP ? API_BASE : ''}/display?room=${encodeURIComponent(ROOM || '')}`;
  return `<a class="btn" href="${escapeAttr(href)}" target="_blank" rel="noopener" title="Open this on a TV, laptop or second monitor; it updates live">&#x1F4FA; Table display</a>`;
}
function renderMapTab() {
  const body = el('tabBody');
  const g = mapState();
  if (!g) {
    body.innerHTML = `<div class="panel" style="max-width:640px;"><h2>Battle map</h2><p class="helptext">No battle map right now. When a fight starts, the GM lays one out here: a grid of 5-foot squares with every hero and foe on it. In the meantime the GM gives each foe's distance in its <b>Foes</b> line.</p>
      <p class="helptext">Playing around a table? Open the <b>table display</b> on a TV or laptop: it shows the map and everyone's HP, full screen, and updates live.</p>${displayLinkHTML()}
      ${safeSceneUrl(SCENE && SCENE.url) ? `<div class="scene-banner" style="background-image:url('${escapeAttr(safeSceneUrl(SCENE.url))}')"></div>` : ''}
      ${sceneControlsHTML()}</div>`;
    return;
  }
  const me = myToken(g);
  const reach = MAP_SELECTED && me ? reachable(g) : new Map();
  const walls = wallSet(g);
  const left = me ? heroSpeed(ROSTER[MY_CHAR_ID]) - movedThisTurn(g) : 0;
  let cells = '<div class="map-corner"></div>';
  for (let x = 0; x < g.w; x++) cells += `<div class="map-label">${colName(x)}</div>`;
  for (let y = 0; y < g.h; y++) {
    cells += `<div class="map-label">${y + 1}</div>`;
    for (let x = 0; x < g.w; x++) {
      const t = tokenAt(g, x, y);
      const k = `${x},${y}`;
      const cls = ['map-cell'];
      if (walls.has(sq(x, y))) cls.push('map-wall');
      if (reach.has(k)) cls.push('map-reach');
      if (t) cls.push(t.kind === 'hero' ? 'map-hero' : t.kind === 'ally' ? 'map-ally' : 'map-foe');
      if (t && me && t === me) cls.push('map-me');
      const label = t ? escapeHtml(t.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()) : '';
      cells += `<button class="${cls.join(' ')}" onclick="mapTap(${x},${y})" title="${t ? escapeAttr(t.name) + ' — ' : ''}${sq(x, y)}">${label}</button>`;
    }
  }
  const legend = (g.tokens || []).map(t => `<span class="map-key ${t.kind === 'hero' ? 'map-hero' : t.kind === 'ally' ? 'map-ally' : 'map-foe'}">${escapeHtml(t.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase())}</span> ${escapeHtml(t.name)} <span class="helptext">${sq(t.x, t.y)}${me && t !== me ? ' · ' + feetBetween(me, t) + ' ft' : ''}${t.kind !== 'hero' && findFoe(t.name) ? ' · ' + findFoe(t.name).hp + '/' + findFoe(t.name).maxhp + ' HP' : ''}</span>`).join('<br>');
  const prevScroll = el('mapScroll') ? el('mapScroll').scrollLeft : null; // keep the view still across redraws
  body.innerHTML = `
    <div class="map-wrap">
      <div class="map-scroll${safeSceneUrl(SCENE && SCENE.url) ? ' has-scene' : ''}" id="mapScroll" style="${safeSceneUrl(SCENE && SCENE.url) ? `background-image:url('${escapeAttr(safeSceneUrl(SCENE.url))}')` : ''}"><div class="map-grid" style="grid-template-columns:22px repeat(${g.w}, minmax(26px, 1fr));">${cells}</div></div>
      <div class="map-side">
        <p class="helptext">${me ? (MAP_SELECTED ? `Tap a highlighted square to move (${left} ft left this turn), or tap your hero again to cancel.` : `Tap your hero to move. ${left} ft of movement left this turn.`) : 'The GM will place your hero on the map.'} 1 square = 5 ft.</p>
        ${MAP_INFO ? `<p class="hero-note">${escapeHtml(MAP_INFO)}</p>` : ''}
        <div class="map-legend">${legend || '<span class="helptext">No tokens yet.</span>'}</div>
        <div style="margin-top:14px;">${displayLinkHTML()}</div>
        ${sceneControlsHTML()}
      </div>
    </div>`;
  const box = el('mapScroll');
  const mine = box && box.querySelector('.map-me');
  if (box && prevScroll !== null) box.scrollLeft = prevScroll;
  else if (box && mine) box.scrollLeft = Math.max(0, mine.offsetLeft - box.clientWidth / 2); // first open: centre on your hero
}
async function mapTap(x, y) {
  const g = mapState();
  if (!g || MAP_BUSY) return;
  const me = myToken(g);
  const t = tokenAt(g, x, y);
  if (me && t === me) { MAP_SELECTED = !MAP_SELECTED; MAP_INFO = ''; return renderMapTab(); }
  if (MAP_SELECTED && me) {
    const reach = reachable(g);
    const cost = reach.get(`${x},${y}`);
    if (cost === undefined) { MAP_INFO = `${sq(x, y)} is out of reach this turn.`; return renderMapTab(); }
    MAP_BUSY = true;
    try {
      // Re-read the room so another player's move isn't overwritten.
      const room = await dbGetRoom(ROOM);
      const fresh = room && room.meta && room.meta.grid;
      if (!fresh || !fresh.w) { MAP_INFO = 'The battle map has ended.'; return; }
      META = room.meta;
      const mine = myToken(fresh);
      if (!mine || tokenAt(fresh, x, y) || wallSet(fresh).has(sq(x, y))) { MAP_INFO = 'That square just changed. Try again.'; return; }
      const from = sq(mine.x, mine.y);
      mine.x = x; mine.y = y;
      fresh.moved = fresh.moved || {};
      fresh.moved[MY_CHAR_ID] = { gm: gmCount(), ft: movedThisTurn(fresh) + cost };
      await dbUpdateRoomMeta(ROOM, META);
      const entry = { id: uid(6), author: 'The Ledger', type: 'system', text: `🗺 ${mine.name} moves ${from} → ${sq(x, y)} (${cost} ft).` };
      await dbInsertLog(ROOM, entry);
      LOG.push({ ...entry, ts: Date.now() });
      MAP_SELECTED = false;
      MAP_INFO = '';
    } finally {
      MAP_BUSY = false;
      if (VIEW === 'game' && ACTIVE_TAB === 'map') renderMapTab();
    }
    return;
  }
  MAP_INFO = t ? `${t.name} at ${sq(x, y)}${me ? ` — ${feetBetween(me, t)} ft from you` : ''}.` : `${sq(x, y)}${wallSet(g).has(sq(x, y)) ? ' (wall)' : ''}${me ? ` — ${feetBetween(me, { x, y })} ft from you` : ''}.`;
  renderMapTab();
}
window.mapTap = mapTap;

/* ---------------- Foe attacks ---------------- */
// The GM can't roll dice, so it writes a directive line for each monster attack and the game rolls it:
//   [[foe-attack: Goblin B | scimitar | +4 | 1d6+2 | Telilin]]
// Only the browser that asked the GM resolves them; everyone else just sees the results in the log.
const FOE_DIRECTIVE = /\[\[\s*foe-attack:([^\]]*)\]\]/gi;
const HEAL_DIRECTIVE = /\[\[\s*heal:([^\]]*)\]\]/gi;
const GIVE_DIRECTIVE = /\[\[\s*give:([^\]]*)\]\]/gi;
const USE_DIRECTIVE = /\[\[\s*use:([^\]]*)\]\]/gi;
const FOE_ADD_DIRECTIVE = /\[\[\s*foe:([^\]]*)\]\]/gi;
const HIT_DIRECTIVE = /\[\[\s*hit:([^\]]*)\]\]/gi;
const DAMAGE_DIRECTIVE = /\[\[\s*damage:([^\]]*)\]\]/gi;
const DEFEAT_DIRECTIVE = /\[\[\s*defeat:([^\]]*)\]\]/gi;
const SUCCESS_DIRECTIVE = /\[\[\s*success:([^\]]*)\]\]/gi;
const FEATURE_DIRECTIVE = /\[\[\s*feature:([^\]]*)\]\]/gi;
const CAST_DIRECTIVE = /\[\[\s*cast:([^\]]*)\]\]/gi;
const STABLE_DIRECTIVE = /\[\[\s*stable:([^\]]*)\]\]/gi;
const REST_DIRECTIVE = /\[\[\s*(short|long)[- ]rest\s*(?::[^\]]*)?\]\]/gi;
function extractFoeAttacks(text) {
  const attacks = [];
  const heals = [];
  const gives = [];
  const uses = [];
  const damages = [];
  const notes = [];
  const foesAdded = [];
  const hits = [];
  const mapOps = [];
  const defeats = [];
  const successes = [];
  const rests = [];
  const stables = [];
  const casts = [];
  const features = [];
  const clean = String(text).replace(FOE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 5 && attacks.length < 4) attacks.push({ who: p[0].slice(0, 40), atk: p[1].slice(0, 40), bonus: p[2], dmg: p[3], target: p[4], ac: p[5] });
    return '';
  }).replace(HEAL_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 2 && heals.length < 4) heals.push({ target: p[0], amount: p[1], src: (p[2] || 'Healing').slice(0, 40) });
    return '';
  }).replace(GIVE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 2 && p[1] && gives.length < 4) gives.push({ target: p[0], item: p[1].slice(0, 80), qty: p[2] || '' });
    return '';
  }).replace(USE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 2 && p[1] && uses.length < 4) uses.push({ target: p[0], item: p[1].slice(0, 80), qty: p[2] || '' });
    return '';
  }).replace(NOTE_DIRECTIVE, (_, body) => {
    const i = body.indexOf('|');
    if (notes.length < 3) notes.push(i >= 0 ? { category: body.slice(0, i), text: body.slice(i + 1) } : { category: 'Clues', text: body });
    return '';
  }).replace(FOE_ADD_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p[0] && foesAdded.length < 12) foesAdded.push({ target: p[0], hp: p[1] || '', ally: /ally|friend/i.test(p[2] || '') });
    return '';
  }).replace(HIT_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p[0] && hits.length < 6) hits.push({ target: p[0], hero: p[1] || '' });
    return '';
  }).replace(MAP_DIRECTIVE, (_, kind, body) => {
    if (mapOps.length < 40) mapOps.push({ kind: kind.toLowerCase(), body: String(body || '').trim() });
    return '';
  }).replace(DAMAGE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 2 && damages.length < 4) damages.push({ target: p[0], amount: p[1], src: (p[2] || 'Damage').slice(0, 40), half: p.slice(3).some(x => /half/i.test(x)) });
    return '';
  }).replace(DEFEAT_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p[0] && defeats.length < 6) defeats.push({ target: p[0].slice(0, 60), cr: p[1] || '' });
    return '';
  }).replace(SUCCESS_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p[0] && successes.length < 4) successes.push({ target: p[0], skill: (p[1] || '').slice(0, 40), dc: p[2] || '' });
    return '';
  }).replace(FEATURE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(x => x.trim());
    if (p[0] && p[1] && features.length < 4) features.push({ who: p[0], feature: p[1], amount: p[2] || '', target: p[3] || '' });
    return '';
  }).replace(CAST_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(x => x.trim());
    if (p[0] && p[1] && casts.length < 4) casts.push({ who: p[0], spell: p[1], level: p[2] || '' });
    return '';
  }).replace(STABLE_DIRECTIVE, (_, body) => {
    const name = body.split('|')[0].trim();
    if (name && stables.length < 4) stables.push({ target: name });
    return '';
  }).replace(REST_DIRECTIVE, (_, kind) => {
    if (!rests.length) rests.push(kind.toLowerCase());
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { clean, attacks, heals, gives, uses, damages, notes, foesAdded, hits, mapOps, defeats, successes, rests, stables, casts, features };
}
function findTarget(name) {
  const chars = Object.values(ROSTER);
  const n = String(name || '').trim().toLowerCase();
  return chars.find(c => c.name.toLowerCase() === n)
    || chars.find(c => n && (c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase())))
    || (!n && chars.length === 1 ? chars[0] : null);
}
const dieRoll = sides => Math.floor(Math.random() * sides) + 1;
// "1d8+2" or a flat "5" -> a spec, else null. Dice counts and sides are capped.
function parseDice(expr) {
  const s = String(expr).replace(/\s/g, '');
  if (/^\d{1,3}$/.test(s)) return { flat: parseInt(s) };
  const m = s.match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { count: Math.min(Math.max(parseInt(m[1] || '1'), 1), 20), sides: Math.min(Math.max(parseInt(m[2]), 2), 20), mod: m[3] ? parseInt(m[3]) : 0 };
}
function rollSpec(d, mult) {
  if (d.flat !== undefined) return { total: d.flat, text: String(d.flat) };
  const rolls = Array.from({ length: d.count * (mult || 1) }, () => dieRoll(d.sides));
  return { total: Math.max(0, rolls.reduce((x, y) => x + y, 0) + d.mod), text: `${rolls.length}d${d.sides}(${rolls.join('+')})${d.mod ? fmtMod(d.mod) : ''}` };
}
function charIdOf(c) { return Object.keys(ROSTER).find(k => ROSTER[k] === c); }
// Moves a character's HP (never below 0 or above max) and reports before/after.
function changeHP(c, delta, crit) {
  const before = parseInt(c.hp) || 0;
  const max = parseInt(c.maxhp) || Math.max(before, 1);
  if (c.dead && delta > 0) return { before, after: before, max }; // the dead aren't healed by a potion
  c.hp = Math.max(0, Math.min(max, before + delta));
  if (!c.ally) {
    if (c.hp > 0) { delete c.dying; delete c.stable; }
    else if (before > 0) { c.dying = { s: 0, f: 0 }; delete c.stable; }
    else if (delta < 0 && !c.dead) {
      // Hurt while already at 0 HP: a failed death save (two on a critical hit), and no longer stable.
      const d = c.dying || { s: 0, f: 0 };
      d.f = Math.min(3, d.f + (crit ? 2 : 1));
      c.dying = d; delete c.stable;
      if (d.f >= 3) { c.dead = true; delete c.dying; }
    }
  }
  return { before, after: c.hp, max };
}
// The result's hpChar names the character whose HP changed, so the caller can save it.
function resolveFoeAttack(a) {
  // A named character is a party member being attacked; otherwise an AC in the directive makes it an ally attacking an enemy.
  const enemyAc = parseInt(String(a.ac || '').replace(/[^0-9]/g, ''));
  const found = findTarget(a.target);
  const target = found || (a.target && enemyAc >= 5 && enemyAc <= 30 ? { name: String(a.target).slice(0, 40), ac: enemyAc, enemy: true } : null);
  const bonus = Math.max(-10, Math.min(30, parseInt(String(a.bonus).replace(/\s/g, '')) || 0));
  const dice = parseDice(a.dmg);
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text });
  if (!target) return fail(`${a.who} attacks, but the game couldn't tell who it was aimed at.`);
  if (!dice) return fail(`${a.who} attacks ${target.name}, but its damage dice (${a.dmg}) couldn't be read.`);
  const natural = dieRoll(20);
  const total = natural + bonus;
  const crit = natural === 20;
  const hit = crit || (natural !== 1 && total >= (parseInt(target.ac) || 10));
  let text = `${a.atk ? a.atk + ' → ' : ''}${target.name}: d20(${natural}) ${fmtMod(bonus)} = ${total} vs AC ${target.ac} — ${crit ? 'CRITICAL HIT' : hit ? 'HIT' : 'miss'}`;
  let hpChar;
  let foeTouched = false;
  if (hit) {
    const dmg = rollSpec(dice, crit ? 2 : 1);
    text += `: ${dmg.total} damage (${dmg.text})`;
    if (target.enemy) {
      const foe = findFoe(target.name) || addFoe(target.name);
      if (foe) {
        const before = foe.hp;
        foe.hp = Math.max(0, foe.hp - dmg.total);
        text += ` — ${foe.name}: HP ${before} → ${foe.hp}/${foe.maxhp}${foe.hp === 0 ? ' (down!)' : ''}`;
        foeTouched = true;
        if (foe.hp === 0) text += ' ' + foeFell(foe).text;
      } else {
        text += ` — ${target.name}'s HP is the GM's to track`;
      }
    } else {
      const { before, after, max } = changeHP(target, -dmg.total, crit);
      hpChar = charIdOf(target);
      text += ` — ${target.name}: HP ${before} → ${after}/${max}${after === 0 ? (target.dead ? ' — three failed death saves: ' + target.name + ' is dead.' : before === 0 ? ` (a failed death save: ${dyingText(target)})` : ' (down! dying)') : ''}`;
    }
  }
  return { id: uid(6), author: a.who, type: 'roll', text, hpChar, saveMeta: foeTouched, saveAll: foeTouched };
}
// Targets for damage and healing: one name, a list ("Brannoc, Sera half", "Brannoc and Sera"), or everyone
// ("party", "all", "everyone"). A trailing "half" / "(half)" on a name means that character made their save.
const PARTY_WORDS = /^(the\s+)?(party|all|everyone|everybody|all of them|the group|group)$/i;
function parseTargets(spec) {
  const out = [];
  const seen = new Set();
  const missing = [];
  for (let raw of String(spec || '').split(/\s*(?:,|;|&|\band\b)\s*/i)) {
    raw = raw.trim();
    if (!raw) continue;
    const half = /\s*\(?\bhalf\b\)?$/i.test(raw);
    const name = raw.replace(/\s*\(?\bhalf\b\)?$/i, '').trim();
    let list = PARTY_WORDS.test(name) ? Object.values(ROSTER) : [findTarget(name)];
    if (!list[0]) { const a = findFoe(name); if (a && a.ally) list = [a]; }
    if (!list[0]) { missing.push(name); continue; }
    for (const c of list) { if (!seen.has(c)) { seen.add(c); out.push({ c, half }); } }
  }
  return { targets: out, missing };
}
// [[damage: Telilin | 2d6 | spike trap]], [[damage: Brannoc, Sera half | 8d6 | fireball]], [[damage: party | 2d6 | cave-in]]
// Damage that isn't a monster's attack roll (traps, falls, poison, area spells). Rolled ONCE, applied to each
// target; a target marked "half", or "| half" for everyone, takes half (rounded down), as for a made save.
function resolveDamage(d) {
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text });
  const { targets, missing } = parseTargets(d.target);
  const dice = parseDice(d.amount);
  if (!targets.length) return fail(`${d.src}: the game couldn't tell who was hurt.`);
  if (!dice) return fail(`${d.src} hurts ${targets.map(t => t.c.name).join(', ')}, but the amount (${d.amount}) couldn't be read.`);
  const r = rollSpec(dice, 1);
  const parts = targets.map(({ c, half }) => {
    const halved = half || d.half;
    const dmg = halved ? Math.floor(r.total / 2) : r.total;
    const { before, after, max } = changeHP(c, -dmg);
    const state = after > 0 ? '' : c.ally ? (before > 0 ? ' (down!)' : '') : c.dead ? ` — ${c.name} is dead` : before === 0 ? ` (a failed death save: ${dyingText(c)})` : ' (down! dying)';
    return `${c.name} ${dmg}${halved ? ' (halved by the save)' : ''} — HP ${before} → ${after}/${max}${state}`;
  });
  const allyHit = targets.some(({ c }) => c.ally);
  const rolled = dice.flat === undefined ? ` (${r.text} = ${r.total})` : '';
  const text = targets.length === 1
    ? `🩸 ${d.src} → ${parts[0].replace(/^(.+?) (\d+)/, `$1: $2 damage${dice.flat === undefined ? ' (' + r.text + ')' : ''}`)}`
    : `🩸 ${d.src}${rolled || ` (${r.total})`}: ${parts.join('; ')}`;
  return { id: uid(6), author: 'The Ledger', type: 'system', text: text + (missing.length ? ` (couldn't find: ${missing.join(', ')})` : ''), saveAll: true, saveMeta: allyHit };
}
// [[heal: Telilin | 2d4+2 | potion of healing]], [[heal: Brannoc, Sera | 1d4+3 | mass healing word]], [[heal: party | 10 | prayer]]
// Rolled once (or a flat number) and applied to each target, up to their maximum.
function resolveHeal(h) {
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text });
  const { targets, missing } = parseTargets(h.target);
  const dice = parseDice(h.amount);
  if (!targets.length) return fail(`${h.src}: the game couldn't tell who was healed.`);
  const names = targets.map(t => t.c.name).join(', ');
  // Stabilising only ends death saves; it never restores HP, so a heal line worded that way is ignored.
  if (/stabili[sz]|healer|medicine|spare the dying/i.test(h.src)) return fail(`${h.src} → ${names}: stabilising restores no HP.`);
  if (!dice) return fail(`${h.src} heals ${names}, but the amount (${h.amount}) couldn't be read.`);
  const r = rollSpec(dice, 1);
  const parts = targets.map(({ c }) => {
    const { before, after, max } = changeHP(c, r.total);
    return `${c.name} HP ${before} → ${after}/${max}`;
  });
  const rolled = dice.flat === undefined ? ' (' + r.text + ')' : '';
  const text = targets.length === 1
    ? `${h.src} → ${targets[0].c.name}: heals ${r.total}${rolled} — ${parts[0].replace(/^.+? HP/, 'HP')}`
    : `${h.src}: heals ${r.total}${rolled} each — ${parts.join('; ')}`;
  return { id: uid(6), author: 'The Ledger', type: 'system', text: text + (missing.length ? ` (couldn't find: ${missing.join(', ')})` : ''), saveAll: true, saveMeta: targets.some(({ c }) => c.ally) };
}

// ---- items: what the story gave vs. what a player typed in ----
// Items typed into the Sheet tab are listed in c.handItems as well as c.inventory. The GM is told they are
// not owned, they are marked "added by you" on the sheet, and they are never saved onto a hero's mini.
function handItems(c) { return Array.isArray(c.handItems) ? c.handItems.filter(i => (c.inventory || []).includes(i)) : []; }
// One flag per inventory slot: true for typed-in items (matched from the end, where they were added).
function handFlags(c) {
  const left = [...handItems(c)];
  const inv = c.inventory || [];
  const flags = inv.map(() => false);
  for (let i = inv.length - 1; i >= 0 && left.length; i--) {
    const k = left.indexOf(inv[i]);
    if (k >= 0) { flags[i] = true; left.splice(k, 1); }
  }
  return flags;
}
function earnedItems(c) { const f = handFlags(c); return (c.inventory || []).filter((_, i) => !f[i]); }
function dropHandItem(c, item) {
  if (!Array.isArray(c.handItems)) return;
  const k = c.handItems.lastIndexOf(item);
  if (k >= 0) c.handItems.splice(k, 1);
}
const QTY_RE = /\s*\((\d+)\)\s*$/;
const itemBase = s => String(s).replace(QTY_RE, '').trim().toLowerCase();

/* ---------------- Gear: counted consumables, weapons, ammunition ----------------
   Non-consumable gear (weapons, armour, shields, tools) always comes back after a fight and is never removed.
   Consumables are counted stacks, e.g. "Crossbow bolts (20)", "Gold pieces (5)". A weapon attack from the
   Roll from sheet menu spends one piece of its ammunition; when the fight ends ([[end-battle]], or the next
   rest) half of what was spent is recovered, rounded down (SRD). Other consumables go through [[use]]. */
const WEAPONS = { // SRD weapons: damage dice, ability ('fin' = STR or DEX), ammunition
  club: ['1d4', 'str'], dagger: ['1d4', 'fin'], greatclub: ['1d8', 'str'], handaxe: ['1d6', 'str'], javelin: ['1d6', 'str'],
  'light hammer': ['1d4', 'str'], mace: ['1d6', 'str'], quarterstaff: ['1d6', 'str'], sickle: ['1d4', 'str'], spear: ['1d6', 'str'],
  'light crossbow': ['1d8', 'dex', 'bolt'], dart: ['1d4', 'fin'], shortbow: ['1d6', 'dex', 'arrow'], sling: ['1d4', 'dex', 'bullet'],
  battleaxe: ['1d8', 'str'], flail: ['1d8', 'str'], glaive: ['1d10', 'str'], greataxe: ['1d12', 'str'], greatsword: ['2d6', 'str'],
  halberd: ['1d10', 'str'], lance: ['1d12', 'str'], longsword: ['1d8', 'str'], maul: ['2d6', 'str'], morningstar: ['1d8', 'str'],
  pike: ['1d10', 'str'], rapier: ['1d8', 'fin'], scimitar: ['1d6', 'fin'], shortsword: ['1d6', 'fin'], trident: ['1d6', 'str'],
  'war pick': ['1d8', 'str'], warhammer: ['1d8', 'str'], whip: ['1d4', 'fin'], blowgun: ['1d1', 'dex', 'needle'],
  'hand crossbow': ['1d6', 'dex', 'bolt'], 'heavy crossbow': ['1d10', 'dex', 'bolt'], longbow: ['1d8', 'dex', 'arrow'],
};
const WEAPON_KEYS = Object.keys(WEAPONS).sort((a, b) => b.length - a.length);
const AMMO = { bolt: 'Crossbow bolts', arrow: 'Arrows', bullet: 'Sling bullets', needle: 'Blowgun needles' };
const AMMO_WORD = /\b(?:crossbow\s+)?(?:sling\s+)?(?:blowgun\s+)?(bolts?|arrows?|bullets?|needles?)\b/i;
const ammoKind = w => /bolt/i.test(w) ? 'bolt' : /arrow/i.test(w) ? 'arrow' : /bullet/i.test(w) ? 'bullet' : 'needle';
const COIN_NAMES = { gold: 'Gold pieces', gp: 'Gold pieces', silver: 'Silver pieces', sp: 'Silver pieces', copper: 'Copper pieces', cp: 'Copper pieces',
  platinum: 'Platinum pieces', pp: 'Platinum pieces', electrum: 'Electrum pieces', ep: 'Electrum pieces' };
const isAmmoItem = s => AMMO_WORD.test(String(s)) && !/\bbow\b|crossbow\s*(?:,|with|and|$)|\bsling\s*(?:,|with|and|$)/i.test(String(s).replace(/\bcrossbow\s+bolts?\b/i, ''));
function weaponOf(item) {
  const s = String(item || '').toLowerCase();
  if (isAmmoItem(s)) return null;
  const k = WEAPON_KEYS.find(n => new RegExp('\\b' + n + '\\b').test(s));
  return k ? { key: k, dice: WEAPONS[k][0], ab: WEAPONS[k][1], ammo: WEAPONS[k][2] || null } : null;
}
const capFirst = s => s.charAt(0).toUpperCase() + s.slice(1);
// One written item -> one or more inventory lines with counts.
function normalizeItem(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  let m = /^(.*?)\s*(?:,|\bwith\b|\band\b|\+|&)\s*(?:an?\s+)?(?:(?:quiver|case|pouch|bundle)\s+(?:of\s+)?)?(\d+)\s+(?:crossbow\s+|sling\s+|blowgun\s+)?(bolts?|arrows?|bullets?|needles?)\b.*$/i.exec(s);
  if (m && m[1].trim()) return [m[1].trim(), `${AMMO[ammoKind(m[3])]} (${m[2]})`];
  m = /^(?:an?\s+)?(?:(?:quiver|case|pouch|bundle)\s+(?:of\s+)?)?(\d+)\s+(?:crossbow\s+|sling\s+|blowgun\s+)?(bolts?|arrows?|bullets?|needles?)\b/i.exec(s);
  if (m) return [`${AMMO[ammoKind(m[2])]} (${m[1]})`];
  m = /^(?:crossbow\s+|sling\s+|blowgun\s+)?(bolts?|arrows?|bullets?|needles?)\s*(?:[x×]\s*(\d+)|\((\d+)\))?$/i.exec(s);
  if (m) return [`${AMMO[ammoKind(m[1])]} (${m[2] || m[3] || 1})`];
  m = /^(\d+)\s*(gold|silver|copper|platinum|electrum|gp|sp|cp|pp|ep)\b/i.exec(s);
  if (m) return [`${COIN_NAMES[m[2].toLowerCase()]} (${m[1]})`];
  m = /^(gold|silver|copper|platinum|electrum)\s+(?:pieces?|coins?)\s*(?:[x×]\s*(\d+)|\((\d+)\))?$/i.exec(s);
  if (m) return [`${COIN_NAMES[m[1].toLowerCase()]} (${m[2] || m[3] || 1})`];
  m = /^(?:(?:road|trail|travel|iron)\s+)?rations?\s*\((\d+)\s*days?\)$/i.exec(s) || /^(\d+)\s*days?(?:'s)?\s+(?:of\s+)?(?:(?:road|trail|travel|iron)\s+)?rations?$/i.exec(s);
  if (m) return [`Rations (${m[1]})`]; // one ration feeds one person for a day
  m = /^(.*?)\s*[x×]\s*(\d+)$/i.exec(s);
  if (m && m[1].trim()) return [`${m[1].trim()} (${m[2]})`];
  return [s];
}
// The name a stack is matched by: coins and ammunition by kind, other things by their singular name.
function stackKey(s) {
  const b = itemBase(s);
  const coin = /^(?:\d+\s*)?(gold|silver|copper|platinum|electrum|gp|sp|cp|pp|ep)\b/.exec(b);
  if (coin) return COIN_NAMES[coin[1]].toLowerCase();
  if (isAmmoItem(b)) { const a = AMMO_WORD.exec(b); return AMMO[ammoKind(a[1])].toLowerCase(); }
  return b.replace(/(?:es|s)$/, '');
}
const stackCount = s => { const q = QTY_RE.exec(String(s)); return q ? parseInt(q[1]) : 1; };
const withCount = (base, n) => `${base} (${n})`;
function mergeStacks(list) {
  const out = [];
  for (const it of list) {
    const k = stackKey(it);
    const j = out.findIndex(o => stackKey(o) === k);
    if (j >= 0 && (QTY_RE.test(it) || QTY_RE.test(out[j]))) out[j] = withCount(String(out[j]).replace(QTY_RE, '').trim(), stackCount(out[j]) + stackCount(it));
    else out.push(it);
  }
  return out;
}
// Rewrites a character's earned items into counted stacks (typed-in items are left alone). True if changed.
function normalizeInventory(c) {
  if (!c || !Array.isArray(c.inventory)) return false;
  const flags = handFlags(c);
  const hand = c.inventory.filter((_, i) => flags[i]);
  const earned = mergeStacks(c.inventory.filter((it, i) => !flags[i] && String(it).trim()).flatMap(normalizeItem));
  const next = [...earned, ...hand];
  if (JSON.stringify(next) === JSON.stringify(c.inventory)) return false;
  c.inventory = next;
  return true;
}
function findStack(c, name) {
  const inv = c.inventory || [];
  const flags = handFlags(c);
  const want = stackKey(name), wantBase = itemBase(name);
  const order = [...inv.keys()].filter(i => !flags[i]); // only things the story gave them
  return order.find(i => stackKey(inv[i]) === want)
    ?? order.find(i => { const b = itemBase(inv[i]); return wantBase && (b.includes(wantBase) || wantBase.includes(b)); });
}
// Takes n off a stack. Returns { ok, left, base } or { ok: false, have }.
function takeFromStack(c, idx, n) {
  const inv = c.inventory;
  const have = stackCount(inv[idx]);
  const base = String(inv[idx]).replace(QTY_RE, '').trim();
  if (have < n) return { ok: false, have, base };
  const left = have - n;
  if (left > 0) inv[idx] = QTY_RE.test(inv[idx]) || left > 1 ? withCount(base, left) : base;
  else inv.splice(idx, 1);
  return { ok: true, left, base };
}
function spendAmmo(c, kind) {
  normalizeInventory(c);
  const name = AMMO[kind];
  const idx = findStack(c, name);
  if (idx === undefined) return { ok: false, text: `no ${name.toLowerCase()} left` };
  const r = takeFromStack(c, idx, 1);
  if (!r.ok) return { ok: false, text: `no ${name.toLowerCase()} left` };
  c.ammoSpent = { ...(c.ammoSpent || {}) };
  c.ammoSpent[kind] = (c.ammoSpent[kind] || 0) + 1;
  return { ok: true, text: `1 ${name.toLowerCase().replace(/s$/, '')} spent (${r.left} left)` };
}
// End of a fight: half the ammunition each hero spent is found again, rounded down. Returns log text.
function recoverAmmo() {
  const parts = [];
  for (const c of Object.values(ROSTER)) {
    const spent = c.ammoSpent || {};
    for (const kind of Object.keys(spent)) {
      const n = parseInt(spent[kind]) || 0, back = Math.floor(n / 2);
      if (back > 0) {
        const name = AMMO[kind] || kind;
        const idx = findStack(c, name);
        if (idx !== undefined) c.inventory[idx] = withCount(String(c.inventory[idx]).replace(QTY_RE, '').trim(), stackCount(c.inventory[idx]) + back);
        else (c.inventory = c.inventory || []).unshift(withCount(name, back));
      }
      if (n > 0) parts.push(`${c.name} recovers ${back} of ${n} ${(AMMO[kind] || kind).toLowerCase()} (the rest are broken or lost)`);
    }
    delete c.ammoSpent;
  }
  return parts;
}
// [[give: Brannoc | Potion of Healing]]: the story hands a character an item.
function resolveGive(g) {
  const target = findTarget(g.target);
  if (!target) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${g.item}: the game couldn't tell who received it.` };
  target.inventory = (target.inventory || []).filter(i => String(i).trim());
  normalizeInventory(target);
  const qty = parseInt(String(g.qty || '').replace(/[^0-9]/g, '')) || 0;
  const items = normalizeItem(qty > 1 && !QTY_RE.test(g.item) ? withCount(g.item, Math.min(999, qty)) : g.item);
  for (const it of items) {
    const idx = QTY_RE.test(it) ? findStack(target, it) : undefined;
    if (idx !== undefined && stackKey(target.inventory[idx]) === stackKey(it)) {
      target.inventory[idx] = withCount(String(target.inventory[idx]).replace(QTY_RE, '').trim(), stackCount(target.inventory[idx]) + stackCount(it));
    } else {
      if (target.inventory.length >= 40) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${target.name}'s pack is full, so ${g.item} wasn't added.` };
      target.inventory.push(it);
    }
  }
  return { id: uid(6), author: 'The Ledger', type: 'system', hpChar: charIdOf(target), text: `🎁 ${target.name} gains ${items.join(' and ')}.` };
}
// [[use: Brannoc | Potion of Healing]]: a consumable is used up. "Potion (3)" becomes "Potion (2)".
// Payments and other [[use]] lines run before [[give]]: a hero who couldn't pay gets nothing given that message.
function usesThenGives(uses, gives) {
  const results = uses.map(resolveUse);
  const blocked = new Set(results.filter(r => r.failed && r.who).map(r => r.who));
  return [...results.map(({ failed, who, ...r }) => r),
    ...gives.map(g => { const t = findTarget(g.target); return t && blocked.has(t) ? { id: uid(6), author: 'The Ledger', type: 'system', text: `${t.name} doesn't get ${g.item}: the payment didn't go through.` } : resolveGive(g); })];
}
function resolveUse(u) {
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text, failed: true, who: findTarget(u.target) });
  const target = findTarget(u.target);
  if (!target) return fail(`${u.item}: the game couldn't tell who used it.`);
  normalizeInventory(target);
  const n = Math.max(1, Math.min(999, parseInt(String(u.qty || '').replace(/[^0-9]/g, '')) || 1));
  const idx = findStack(target, u.item);
  if (idx === undefined) {
    // Typed-in items are not owned: they can't be used up either.
    return fail(`${target.name} has no ${u.item}, so it isn't used${/coin|piece|gold|silver|copper|gp|sp|cp/i.test(u.item) ? ' (they can\'t pay)' : ''}.`);
  }
  const r = takeFromStack(target, idx, n);
  if (!r.ok) return fail(`${target.name} has only ${r.have} ${r.base}, not ${n}, so ${/coin|piece|gold|silver|copper/i.test(r.base) ? 'they can\'t pay' : 'nothing is used'}.`);
  return { id: uid(6), author: 'The Ledger', type: 'system', hpChar: charIdOf(target),
    text: `${target.name} uses ${n > 1 ? n + ' ' : ''}${r.base}${r.left > 0 ? ` (${r.left} left)` : ' (none left)'}.` };
}

// Players can click Roll as often as they like, so the app (not the GM) decides which roll counts:
// between two GM messages, only a character's first roll of a given kind is real; repeats are "rolled in error".
// Only player characters are checked, so a monster's multiattack is never flagged.
const REROLL_TAG = '[ROLLED IN ERROR: void. Ignore this roll completely and never carry it over to a later attack or check]';
let rerollMemo = { sig: '', ids: new Set() };
function rerollIds() {
  const sig = LOG.length + ':' + (LOG.length ? LOG[LOG.length - 1].id : '') + ':' + Object.keys(ROSTER).length;
  if (rerollMemo.sig === sig) return rerollMemo.ids;
  const players = new Set(Object.values(ROSTER).map(c => String(c.name).toLowerCase()));
  const dupes = new Set();
  let seen = new Set();
  for (const e of LOG) {
    if (e.type === 'gm') { seen = new Set(); continue; }
    if (e.type !== 'roll' || !players.has(String(e.author).toLowerCase())) continue;
    const m = String(e.text).match(/\(([^()]*)\)\s*(?:⚠.*)?$/);
    const kind = (m ? m[1] : String(e.text).split('(')[0]).trim().toLowerCase();
    const key = e.author + '|' + kind;
    if (seen.has(key)) dupes.add(e.id); else seen.add(key);
  }
  rerollMemo = { sig, ids: dupes };
  return dupes;
}

async function askGM() {
  if (GM_PENDING) return;
  const rerolls = rerollIds();
  const recent = LOG.slice(-30).map(e => `${e.author} (${e.type}): ${e.text}${rerolls.has(e.id) ? ' ' + REROLL_TAG : ''}`).join('\n');
  const party = Object.values(ROSTER).map(c => `${c.name} — Lv${c.level} ${c.race} ${c.klass}, HP ${c.hp}/${c.maxhp} (current, from the sheet)${spellPromptText(c)}${featurePromptText(c)}${(parseInt(c.hp) || 0) <= 0 ? ` — ${c.dead ? 'DEAD' : c.stable ? 'UNCONSCIOUS, stable' : `DYING, ${dyingText(c)}${deathSaveDue(c) ? ', death save not yet rolled this turn' : ', death save already rolled this turn'}`}` : ''}, AC ${c.ac}, XP ${xpOf(c)}, inventory: ${earnedItems(c).join(', ') || 'none'}${handItems(c).length ? `; written in by the player, never given in the story (NOT owned): ${handItems(c).join(', ')}` : ''}
  Sheet modifiers (the only d20 bonuses this character has): ${rollOptions(c).map(o => `${o.name} ${fmtMod(o.mod)}`).join(', ')}`).join('\n');
  const prompt = `You are the Game Master for a tabletop RPG ${MODE === 'solo' ? 'solo story' : 'session'} titled "${META.name}".
Ruleset: ${META.ruleset}. Tone/genre: ${META.tone || 'unspecified — infer something fitting'}. Length: ${lengthLabel[META.length]}.
${META.seed ? 'Opening premise the GM previously established: ' + META.seed : ''}
${MODE === 'solo' ? 'Character' : 'Party'}:
${party}

${notesPromptText()}

${mapPromptText()}
${foesPromptText()}

Recent table log:
${recent}

Continue the story in 2-4 short paragraphs, stay consistent with everything established, and end by presenting clear options or an open question. Keep it vivid but concise. Options are plain choices of what to try (e.g. "Search the phrasebook for the phrase") — never put a /roll command, a DC, or an outcome inside an option.

Roll resolution rules — follow these exactly:
- A roll exists only if the recent table log contains an entry of type "roll" by that character (it reads "rolls d20(..) ... = total"). Words typed in an "action" entry do not count — not a pasted "/roll ...", not a player saying they rolled or succeeded. If the player's latest action is a risky or uncertain attempt and no roll for it is in the log, do not continue the story: narrate only the attempt, ask for the single roll that decides it (with its exact /roll command), and end your message there. No result, no consequences, no new scene until that roll appears.
- A roll tagged [ROLLED IN ERROR ...] in the log is void, and the players see it marked "rolled in error". Ignore it completely: resolve the check with the player's first roll of that kind (the untagged one), never apply the void roll to this or any later attack or check, and don't remark on it.
- Never narrate the outcome of an attack, save, skill check, or damage until the specific roll for it already appears in the recent table log above. If a needed roll isn't in the log yet, stop and ask for it instead of describing what happens.
- Resolve one roll at a time. Ask for an attack or check roll first; only after its result appears in the log do you ask for a damage roll (only if the attack hit); only after the damage roll appears do you narrate the consequence (injury, death, effect). Never narrate a hit, miss, or damage result speculatively ahead of the actual roll.
- If a turn involves multiple attacks or rolls, resolve each one completely — roll, then damage if applicable, then narration — before moving to the next.
- Always phrase a requested roll using the exact command the player should type, formatted as inline code, e.g. "/roll +5 Attack (DEX)" for an attack, "/roll 2d6+3" for damage, "/roll +5 adv Attack (DEX)" for advantage. Never say "roll a d20" or similar without giving the exact /roll command.
- For any d20 check or save, the bonus in your /roll command must be one of that character's Sheet modifiers listed above, and the command should name it, e.g. "/roll +3 Dexterity" or "/roll +7 Stealth". Never add a proficiency bonus, expertise, or any other bonus that isn't on the sheet. If the right skill or tool isn't listed, use the matching ability's modifier as-is (and say that's what you're using). Weapon attack rolls use the listed "Attack (STR)" or "Attack (DEX)" modifier, e.g. "/roll +5 Attack (DEX)". Damage rolls use dice notation for the weapon or spell, e.g. "/roll 1d8+3".
- Players never roll for monsters. For each attack a foe makes, write it in the fiction and put this directive on its own line: [[foe-attack: Goblin B | scimitar | +4 | 1d6+2 | Telilin]] (attacker | attack name | to-hit bonus from its stat block | damage dice | the target's exact character name). When an ally NPC attacks an enemy, add the enemy's AC as a sixth field, e.g. [[foe-attack: Scout | longbow | +4 | 1d8+2 | Goblin A | AC 15]]; the result tells you what happened and you track the enemy's HP. The game rolls the attack against the target's AC and the damage if it hits, and posts the result to the log; use one directive per attack (max 4). Then stop: don't say whether it hit and don't state the AC. Narrate the outcome next turn, once the result is in the log. The game subtracts the damage from the target's HP itself, so never ask players to take it off their HP. For damage that isn't a foe's attack (a trap, a fall, poison, fire, a failed save), put [[damage: <their name> | <dice or a number> | <source>]] on its own line and the game rolls it and takes it off their HP; when a successful save halves it, ask for the save first and add "| half" if they made it. Area effects roll once for everyone: list every character caught in it and mark those who made their save, e.g. [[damage: Brannoc, Sera half | 8d6 | fireball]], or use "party" for everyone at the table. Healing that reaches several characters works the same way: [[heal: Brannoc, Sera | 1d4+3 | mass healing word]]. Players can't change their own HP, so never ask them to. For any healing (a potion, a spell) put [[heal: Telilin | 2d4+2 | potion of healing]] on its own line (the character's exact name | dice or a flat number | source); the game rolls it and raises their HP up to their maximum. One per healing, max 4. A character at 0 HP is unconscious: never offer them options or actions, and never write choices for them; narrate what happens around them. Death saves belong to the game: when it's a DYING character's turn, ask that player to tap "Roll death save" (the game rolls it and counts it; its count is in the party list above, so never keep your own tally or roll it for them). Three successes leaves them stable, three failures means death, a natural 20 brings them back with 1 HP, and any healing wakes them. Damage to a character at 0 HP is a failed death save; the game counts that too. When someone stabilises a dying character, put [[stable: <their name>]] on its own line. Never use [[heal]] to stabilise a dying character: stabilising (a healer's kit, a Medicine check, spare the dying) restores no HP, it only ends their death saves, so ask the player for a Medicine check (DC 10, or a healer's kit with no roll) and narrate them stable at 0 HP. When a player's own character is doing the healing (their spell or potion), ask that player to /roll it; once that roll is in the log, put [[heal: <their name> | <that roll's total> | <source>]] with the total as a plain number, and the game adds it. Never state anyone's new HP total yourself (the game posts it), and never work HP out from older log lines: a character's current HP is only the "HP x/y (current, from the sheet)" in the party list above.
- Spells: each caster's spells and remaining slots are in the party list above, kept by the game. A character can only cast spells on their own list. When a character casts a spell (a cantrip too), put [[cast: <their name> | <spell> | <slot level, only if cast at a higher level>]] on its own line before you narrate its effect; the game spends the slot. If the game says the spell isn't cast (not one of their spells, or no slot left), it fails: say so and let them choose something else. Never restore slots yourself: [[long-rest]] does that (warlock pact slots also come back on [[short-rest]]). Players change their spells on the Your Sheet tab, only after a long rest or when a new session begins.
- Class features: each character's limited-use features (Rage, Second Wind, Action Surge, Ki points, Lay on Hands, Channel Divinity, Wild Shape, Bardic Inspiration, Sorcery points, Arcane Recovery...) and what's left are in the party list, kept by the game. When a character uses one, put [[feature: <their name> | <feature>]] on its own line before narrating it; for pools add the amount ([[feature: Aldric | Lay on Hands | 10 | Mira]] heals Mira 10; [[feature: Kai | Ki points | 1]]). Divine Smite spends a spell slot: [[feature: Aldric | Divine Smite | <slot level> | <foe>]] and the game rolls the radiant damage onto that foe. Second Wind's healing is rolled by the game. If the game says none are left, it doesn't happen. Never refill them yourself: rests do.
- Items: each character's inventory above is what they really carry. Items "written in by the player" were typed in by the player and never given in the story: they are NOT owned. If a player tries to use one, it isn't in their pack, and say so plainly. When the story gives a character an item (found, bought, looted, handed over), put [[give: <their name> | <item>]] on its own line and the game adds it. When a character uses up a consumable (drinks a potion, reads a scroll, spends a charge item), put [[use: <their name> | <item>]] on its own line and the game removes one. Max 4 of each per message. Only consumables are ever used up: weapons, armour, shields and other gear are always recovered after a fight, so never remove them. Consumables are counted, e.g. "Crossbow bolts (18)", "Gold pieces (5)"; when some are used up (a potion drunk, rope left tying prisoners, torches burned out, rations eaten on the road, coins spent) put [[use: <their name> | <item> | <how many>]], and [[give: <their name> | <item> | <how many>]] adds them. Ranged weapon attacks: ask the player to roll that weapon's attack from the Roll from sheet menu (e.g. /roll +4 Light crossbow attack); the game spends the ammunition and gives back half of it when the fight ends, so never [[use]] ammunition yourself, and a character with none left can't shoot. Items come only from the story (found, looted, given, earned or bought), never because a player asks for one. To buy something, first [[use]] the coins; if the game says they can't pay, they don't get it; otherwise [[give]] the item.
- Battle map: when a fight starts, lay out a map before the first attack: [[map: 12x10]] (columns A-L, rows 1-10; at most 20x20), then [[place: <name> | <square>]] for every hero and foe (add "| ally" for a friendly NPC, e.g. [[place: Woman | E5 | ally]]), and [[wall: D2-D5, H7]] for walls or heavy cover. On later turns move foes with [[place]], use [[remove: <name>]] when one flees, surrenders or is otherwise out of the fight for good (the game takes it off the map and the Foes list; it gives no XP, so use [[defeat]] instead if the party beat it), and [[end-battle]] when the fight is over. Players move their own heroes on the map, so never move a hero yourself unless the story forces it (a shove, a fall). Use the map's distances: a melee attack needs 5 ft (10 ft with reach); a ranged attack past normal range has disadvantage and can't go past long range; an area spell hits everyone within its radius of the square it's centred on. With no battle map, give each foe's distance in the Foes line, e.g. **Foes:** Goblin A 4/7 HP, 30 ft.
- Foe hit points belong to the game. When foes enter a fight, put [[foe: <name> | <hp>]] for each, with unique names (Goblin A, Goblin B); leave out the number for an SRD creature and the game uses its stat block. Never decide how much damage a hero deals: when a hero's attack hits, ask that player to /roll the damage, and once that roll is in the log put [[hit: <foe> | <hero>]]; the game takes exactly that roll off the foe. A hero's area spell works the same way: the player rolls the damage once, then [[hit: Goblin A, Goblin B half | <hero>]] (half for foes that made their save). [[damage]] is only for harm to heroes. The game posts each foe's HP and defeats it at 0 (no [[defeat]] needed then); copy its numbers into your Foes line. A friendly NPC who fights or can be hurt gets hit points the same way, marked as an ally: [[foe: Pell | 11 | ally]] (an SRD creature placed with "| ally" is tracked automatically). Foe attacks on an ally use [[foe-attack]] with the ally's AC as the sixth field; [[damage]] and [[heal]] work on allies by name. An ally at 0 HP is down, not defeated: never [[defeat]] an ally. Allies never land a blow in narration alone: when an ally NPC attacks (with a weapon, an improvised one, a shove or a spell), describe the attempt, put [[foe-attack: <ally> | <attack> | <to-hit> | <damage dice> | <enemy> | AC <enemy's AC>]] on its own line and stop; don't say it hit, and don't hurt, stun, daze or knock out the enemy until the result is in the log.
- Field notes: when the party learns something worth remembering (a quest or task, a person and what they want, a place, a clue or piece of lore, how an encounter went, notable loot), put [[note: <Quests|People|Places|Clues|Encounters|Loot> | <one short sentence>]] on its own line; the game adds it to the party's journal. At most 3 per message, and don't repeat anything already in the field notes above.
- XP, levels and rests are the game's job: never announce XP, levels or level-ups yourself. When the party kills or defeats a foe, put [[defeat: <creature>]] on its own line, one per creature (for a creature you invented, add its CR: [[defeat: Cave Wyrm | CR 2]]). When a character succeeds at a check you set a DC for, once their roll is in the log, put [[success: <their name> | <skill> | DC <n>]]. When the party actually rests in the story, put [[short-rest]] (about an hour) or [[long-rest]] (about 8 hours somewhere safe, at most once per in-game day) on its own line; the game restores HP and hit dice, so never use [[heal]] for a rest. A rest in danger gets interrupted instead.
- Do not roll dice yourself or invent results under any circumstance.`;

  await callGM(prompt, 'the GM was not asked to continue.');
}

async function generateOpening() {
  if (GM_PENDING) return;
  const party = Object.values(ROSTER).map(c => `${c.name} — Lv${c.level} ${c.race} ${c.klass}`).join('\n');
  const prompt = META.seedMode === 'custom' && META.seed
    ? `Open the ${MODE === 'solo' ? 'solo story' : 'campaign'} "${META.name}" (tone: ${META.tone || 'unspecified'}) using this premise: ${META.seed}\n\n${MODE === 'solo' ? 'Character' : 'Party'}:\n${party}\n\nWrite an evocative opening scene (3-5 paragraphs) that establishes the setting and hooks the ${MODE === 'solo' ? 'character' : 'party'} into action, ending with a clear prompt for what they do first.`
    : `Invent a fresh, original opening scene for a new tabletop ${MODE === 'solo' ? 'solo story' : 'campaign'} called "${META.name}". Genre/tone: ${META.tone || 'your choice — pick something fitting and interesting'}. Ruleset: ${META.ruleset}.\n\n${MODE === 'solo' ? 'Character' : 'Party'}:\n${party}\n\nWrite an evocative opening scene (3-5 paragraphs) establishing setting, stakes, and a hook, ending with a clear prompt for what they do first. Make it feel distinct, not generic fantasy-tavern-start unless the tone specifically calls for it.`;

  await callGM(prompt, 'no opening scene was generated. Use "Ask the GM to continue" when ready.');
}

/* ---------------- PARTY TAB (group mode) ---------------- */
function renderPartyTab() {
  el('tabBody').innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;">
      ${Object.entries(ROSTER).map(([id, c]) => {
        const pct = Math.max(0, Math.min(100, Math.round((c.hp / c.maxhp) * 100)));
        return `<div class="roster-card ${id === MY_CHAR_ID ? 'mine' : ''}">
          ${portraitHeader(c, `<div class="rname"><b>${escapeHtml(c.name)}</b><span class="rclass">${escapeHtml(c.player)}</span></div>
          <div class="rclass">Lv${c.level} ${escapeHtml(c.race)} ${escapeHtml(c.klass)}</div>`)}
          <div class="hpbar"><div class="hpbar-fill ${pct < 30 ? 'low' : ''}" style="width:${pct}%"></div></div>
          <div class="hprow"><span>HP ${c.hp}/${c.maxhp}</span><span>AC ${c.ac}</span></div>
          ${abilityGridHTML(c)}
          ${(c.inventory && c.inventory.length) ? `<div class="helptext" style="margin-top:8px;"><b style="color:var(--parchment-dim)">Carries:</b> ${c.inventory.map(escapeHtml).join(', ')}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ---------------- PORTRAITS ---------------- */
// Pictures come from our own Supabase Storage bucket only — anyone can write a portrait URL into
// the database, so anything else (tracking pixels, other sites) is ignored rather than loaded.
const PORTRAIT_URL_PREFIX = (cfg.SUPABASE_URL || '').replace(/\/$/, '') + '/storage/v1/object/public/portraits/';
function safePortraitUrl(u) {
  return typeof u === 'string' && cfg.SUPABASE_URL && u.startsWith(PORTRAIT_URL_PREFIX) && !/[\s"'<>]/.test(u) ? u : '';
}
function portraitImg(c, cls) {
  const u = safePortraitUrl(c && c.portrait);
  return u ? `<img class="${cls}" src="${escapeAttr(u)}" alt="Portrait of ${escapeAttr(c.name)}" loading="lazy">` : '';
}
function portraitHeader(c, innerHTML) {
  const img = portraitImg(c, 'portrait-sm');
  return img ? `<div class="rhead">${img}<div class="rhead-main">${innerHTML}</div></div>` : innerHTML;
}

const PORTRAIT_STALE_MS = 4 * 60 * 1000;
// 'none' | 'ready' | 'pending' | 'error'
function portraitState(c) {
  const localWaiting = portraitPendingSince && Date.now() - portraitPendingSince < PORTRAIT_STALE_MS;
  if (localWaiting && (c.portraitStatus === 'pending' || (c.portraitAt || '') === portraitBaseline)) return 'pending';
  portraitPendingSince = 0; // the database has moved past our request (or we stopped waiting)
  const status = c.portraitStatus || '';
  if (status === 'pending') {
    const at = c.portraitAt ? Date.parse(c.portraitAt) : 0;
    return at && Math.abs(Date.now() - at) < PORTRAIT_STALE_MS ? 'pending' : 'error';
  }
  if (status.startsWith('error:')) return 'error';
  return safePortraitUrl(c.portrait) ? 'ready' : 'none';
}
function portraitErrorText(c) {
  const status = c.portraitStatus || '';
  return status.startsWith('error:') ? status.slice(6) : 'That took too long. Try again.';
}
function portraitBoxHTML(c) {
  const state = portraitState(c);
  const img = portraitImg(c, 'portrait');
  const action = state === 'pending'
    ? `<div class="gm-pending"><span class="thinking">Painting your portrait<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span></div><p class="helptext">Usually under a minute — keep playing, it will appear here.</p>`
    : `<div class="portrait-actions">
        <button class="btn" onclick="generatePortrait()">${img ? 'Regenerate portrait' : 'Generate portrait'}${inkCostLabel('portrait')}</button>
        ${uploadPortraitButtonHTML()}
      </div>${state === 'error' ? `<div class="error-text" style="margin-top:8px;">${escapeHtml(portraitErrorText(c))}</div>` : ''}`;
  return `<div class="portrait-box">
    ${img || '<div class="portrait-empty">No portrait yet</div>'}
    <div class="portrait-side">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:8px;">
        <div><label for="charGender">Gender</label><input type="text" id="charGender" maxlength="30" value="${escapeAttr(genderDraft !== null ? genderDraft : (c.gender || ''))}" oninput="setPortraitDraft('gender', this.value)"></div>
        <div><label for="charAge">Age</label><input type="text" id="charAge" maxlength="20" value="${escapeAttr(ageDraft !== null ? ageDraft : (c.age || ''))}" oninput="setPortraitDraft('age', this.value)"></div>
      </div>
      <label for="charAppearance">Appearance</label>
      <textarea id="charAppearance" maxlength="500" placeholder="Describe how your character looks — hair, build, clothing, scars…" oninput="setAppearanceDraft(this.value)">${escapeAttr(appearanceDraft !== null ? appearanceDraft : (c.appearance || ''))}</textarea>
      ${action}
    </div>
  </div>`;
}
/* ---- uploading your own portrait ----
   The picture is cropped to a centred square and shrunk to 640px in the browser (which also drops
   hidden photo data such as GPS location), then stored next to the AI portraits in the public
   "portraits" bucket and linked on the character row, so it shows everywhere portraits do. */
const UPLOAD_SIDE = 640;
const PORTRAIT_UPLOAD = { busy: false, error: '' };
function uploadPortraitButtonHTML() {
  if (PORTRAIT_UPLOAD.busy) return `<span class="thinking">Uploading your picture<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span></span>`;
  return `<button class="btn" onclick="pickPortraitUpload()">Upload a picture</button>
    <input type="file" id="portraitFile" accept="image/*" hidden onchange="onPortraitFile(this)">
    ${PORTRAIT_UPLOAD.error ? `<div class="error-text" style="flex-basis:100%;">${escapeHtml(PORTRAIT_UPLOAD.error)}</div>` : ''}`;
}
function pickPortraitUpload() { PORTRAIT_UPLOAD.error = ''; const f = el('portraitFile'); if (f) f.click(); }
function rerenderSheet() { if (VIEW === 'game' && ACTIVE_TAB === 'sheet') renderSheetTab(); }

async function loadImageFile(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall back below */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That file couldn't be opened as a picture."));
      img.src = url;
    });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function canvasBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}
async function squarePortraitBlob(file) {
  const img = await loadImageFile(file);
  const w = img.width, h = img.height;
  if (!w || !h) throw new Error("That file couldn't be opened as a picture.");
  const side = Math.min(w, h);
  const out = Math.min(UPLOAD_SIDE, side);
  const canvas = document.createElement('canvas');
  canvas.width = out; canvas.height = out;
  canvas.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, out, out);
  if (img.close) img.close();
  // WebP where the browser can make it; otherwise JPEG (both are allowed by the bucket).
  let blob = await canvasBlob(canvas, 'image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', 0.85);
  if (!blob) throw new Error("Couldn't prepare that picture. Try a different one.");
  return blob;
}
async function onPortraitFile(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file || !ROOM || !MY_CHAR_ID || PORTRAIT_UPLOAD.busy) return;
  if (!/^image\//.test(file.type)) { PORTRAIT_UPLOAD.error = 'Choose a picture file (JPG, PNG or WebP).'; return rerenderSheet(); }
  if (file.size > 30 * 1024 * 1024) { PORTRAIT_UPLOAD.error = 'That picture is too large (over 30 MB).'; return rerenderSheet(); }
  const room = ROOM, charId = MY_CHAR_ID;
  PORTRAIT_UPLOAD.busy = true; PORTRAIT_UPLOAD.error = ''; rerenderSheet();
  try {
    const blob = await squarePortraitBlob(file);
    const image = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('read failed'));
      fr.readAsDataURL(blob);
    });
    // The server checks the picture (content rating) before it stores anything.
    const resp = await fetch(api('/api/portrait-upload'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: room, characterId: charId, platform: IS_APP ? 'android' : 'web', image }),
    });
    let data = {};
    try { data = await resp.json(); } catch (e) { /* non-JSON error page */ }
    if (data.reason === 'rejected') { PORTRAIT_UPLOAD.error = data.error || "That picture can't be used. Try a different one."; return; }
    if (!resp.ok || !data.url) throw new Error(data.reason || `HTTP ${resp.status}`);
    const url = data.url;
    const at = data.at || new Date().toISOString();
    const c = ROSTER[charId];
    if (c) { c.portrait = url; c.portraitStatus = 'ready'; c.portraitAt = at; }
    portraitPendingSince = 0;
  } catch (e) {
    console.error(e);
    PORTRAIT_UPLOAD.error = e && e.name === 'TypeError'
      ? "Your picture got lost on the road. Check your connection and try again."
      : "The court painter fumbled your picture on the way to the gallery. Try again.";
  } finally {
    PORTRAIT_UPLOAD.busy = false;
    if (ROOM === room) render();
  }
}
window.pickPortraitUpload = pickPortraitUpload;
window.onPortraitFile = onPortraitFile;

function setAppearanceDraft(v) { appearanceDraft = v; }
function setPortraitDraft(field, v) { if (field === 'gender') genderDraft = v; else ageDraft = v; }

function stopPortraitPoll() { if (portraitPoll) { clearInterval(portraitPoll); portraitPoll = null; } }
// Backup for the realtime update: re-check the roster every few seconds while waiting.
function startPortraitPoll() {
  stopPortraitPoll();
  portraitPoll = setInterval(async () => {
    if (!ROOM || !MY_CHAR_ID) return stopPortraitPoll();
    const before = ROSTER[MY_CHAR_ID] ? portraitState(ROSTER[MY_CHAR_ID]) + '|' + ROSTER[MY_CHAR_ID].portrait : '';
    ROSTER = rosterFromRows(await dbGetCharacters(ROOM));
    const c = ROSTER[MY_CHAR_ID];
    const after = c ? portraitState(c) + '|' + c.portrait : '';
    if (!c || portraitState(c) !== 'pending') stopPortraitPoll();
    if (before !== after && VIEW === 'game') render();
  }, 5000);
}

async function generatePortrait() {
  const c = ROSTER[MY_CHAR_ID];
  if (!c || portraitState(c) === 'pending') return;
  const box = el('charAppearance');
  if (box) { c.appearance = box.value.trim().slice(0, 500); appearanceDraft = null; }
  if (el('charGender')) { c.gender = el('charGender').value.trim().slice(0, 30); genderDraft = null; }
  if (el('charAge')) { c.age = el('charAge').value.trim().slice(0, 20); ageDraft = null; }
  await persistRoster();
  portraitPendingSince = Date.now();
  portraitBaseline = c.portraitAt || '';
  render();
  try {
    const body = JSON.stringify({ roomCode: ROOM, characterId: MY_CHAR_ID, playerId: playerId(), platform: IS_APP ? 'android' : 'web' });
    // The app is on a different origin than the server, and background functions can't answer a CORS
    // preflight, so it sends a "simple" request it can't read the reply to. Progress arrives on the row either way.
    const resp = await fetch(api('/.netlify/functions/portrait-background'), IS_APP
      ? { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!IS_APP && !resp.ok) throw new Error('HTTP ' + resp.status);
    startPortraitPoll();
    setTimeout(() => refreshWallet().catch(() => {}), 8000);
  } catch (e) {
    console.error(e);
    portraitPendingSince = 0;
    const mine = ROSTER[MY_CHAR_ID];
    if (mine) mine.portraitStatus = 'error:Could not reach the portrait service. Try again.';
    if (VIEW === 'game') render();
  }
}

/* ---------------- SHEET TAB ---------------- */
function renderSheetTab() {
  const c = ROSTER[MY_CHAR_ID];
  if (!c) { el('tabBody').innerHTML = `<p class="thinking">No character found for this device.</p>`; return; }
  el('tabBody').innerHTML = `
    <div class="panel" style="max-width:640px;">
      <h2>${escapeHtml(c.name)}</h2>
      <p class="rclass">${escapeHtml(c.player)} &middot; Lv${c.level} ${escapeHtml(c.race)} ${escapeHtml(c.klass)}</p>
      ${portraitBoxHTML(c)}
      <div class="sheet-grid">
        <div class="sheet-stat"><div class="label">HP</div><div class="val">${c.hp} / ${c.maxhp}</div>${deathSaveHTML(c)}</div>
        <div class="sheet-stat"><div class="label">AC</div><div class="val">${c.ac}</div></div>
        <div class="sheet-stat"><div class="label">Level</div><div class="val">${c.level}</div></div>
      </div>
      ${progressHTML(c)}
      ${levelUpHTML(c)}
      ${miniPanelHTML(c)}
      ${forgePanelHTML(c, FORGE_TAG)}
      ${abilityGridHTML(c)}
      ${spellSheetHTML(c)}
      ${featureSheetHTML(c)}
      <p class="helptext" style="margin:-4px 0 20px;">HP only changes through the game: damage from attacks, traps and falls; healing from potions, spells and rests.</p>

      <h3 style="font-size:1rem;">Skills</h3>
      ${(c.skills || []).map(s => `<div class="item-row"><span>${escapeHtml(s.name)}</span><span style="font-family:var(--font-display);font-weight:600;color:var(--glow)">${s.mod >= 0 ? '+' : ''}${escapeHtml(String(s.mod))}</span></div>`).join('') || '<p class="helptext">None recorded.</p>'}

      <h3 style="font-size:1rem;margin-top:20px;">Inventory</h3>
      ${(() => { const f = handFlags(c); return (c.inventory || []).map((it, i) => `<div class="item-row"><span>${escapeHtml(it)}${f[i] ? ' <span class="hand-item" title="You typed this in. The GM only counts items the story gave you.">(added by you)</span>' : ''}</span><button class="small-x" onclick="removeItem(${i})">&times;</button></div>`).join(''); })() || '<p class="helptext">Empty-handed.</p>'}
      <p class="helptext">Items the story gives you are added for you. Anything you type in here is marked <i>added by you</i>, and the GM won't count it.</p>
      <div class="skill-row" style="margin-top:10px;">
        <input type="text" id="newItem" placeholder="Add item..." value="${escapeAttr(newItemDraft)}" oninput="setNewItemDraft(this.value)">
        <button class="add-row" onclick="addItem()">Add</button>
      </div>

      <h3 style="font-size:1rem;margin-top:20px;">Notes</h3>
      <textarea id="charNotes" style="width:100%;min-height:80px;background:var(--bg-deep);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:10px;" oninput="setNotesDraft(this.value)">${escapeAttr(notesDraft !== null ? notesDraft : (c.notes || ''))}</textarea>
      <button class="btn" style="margin-top:10px;" onclick="saveNotes()">Save Notes</button>
    </div>
  `;
}
async function persistRoster() { await dbUpsertCharacter(MY_CHAR_ID, ROOM, ROSTER[MY_CHAR_ID]); }
function setComposerDraft(v) { composerDraft = v; }
function setNewItemDraft(v) { newItemDraft = v; }
function setNotesDraft(v) { notesDraft = v; }
async function addItem() {
  const v = el('newItem').value.trim(); if (!v) return;
  ROSTER[MY_CHAR_ID].inventory = ROSTER[MY_CHAR_ID].inventory || [];
  ROSTER[MY_CHAR_ID].inventory.push(v);
  const c = ROSTER[MY_CHAR_ID];
  c.handItems = [...(Array.isArray(c.handItems) ? c.handItems : []), v];
  newItemDraft = '';
  await persistRoster(); render();
}
async function removeItem(i) {
  const c = ROSTER[MY_CHAR_ID];
  if (handFlags(c)[i]) dropHandItem(c, c.inventory[i]);
  c.inventory.splice(i, 1);
  await persistRoster(); render();
}
async function saveNotes() {
  ROSTER[MY_CHAR_ID].notes = el('charNotes').value;
  notesDraft = null;
  await persistRoster();
  const b = event.target; const old = b.innerText; b.innerText = 'Saved'; setTimeout(() => b.innerText = old, 1000);
}

/* ---------------- HELP TAB ---------------- */
function renderHelpTab() {
  el('tabBody').innerHTML = `
    <div class="panel help-panel" style="max-width:680px;">
      <h2>How to Play</h2>
      <ul>
        ${MODE === 'group' ? `<li>Everyone in this room shares the same <b>Ledger</b> (story log) and <b>Party</b> roster — anyone can open the room code on their own device.</li>` : `<li>This is your own solo story — only your character and the GM are here.</li>`}
        <li>Type plain text and hit Send to describe what your character says or does. It's narrated ${MODE === 'group' ? 'to the whole table' : 'into the story'}.</li>
        <li>Playing solo? <b>Pause Story</b> saves your place under your <b>story code</b>. Later, choose <b>Join or Resume with Code</b> and enter it, on any device, to carry on where you left off.</li>
        <li>In the GM's newest message, click the emoji beside an option to choose it, and click a <b>🎲 /roll</b> button to make that roll. Each can be used once.</li>
        <li>The <b>Roll from sheet</b> menu next to the message box lists your ability checks, skills, weapon attacks, and initiative — pick one and it fills in the right modifier and label for you. If a d20 roll uses a bonus higher than your sheet allows, the log tags it <b>⚠ unlisted modifier</b> so the table can see it (legit situational bonuses like Bless will trigger it too — just a heads-up, nothing is blocked).</li>
        <li>In a fight, the game rolls monster attacks and damage for you and posts the result in the log (damage comes off your HP automatically, and so does damage from traps and falls; healing comes from potions, spells and rests, and HP can't be changed by hand). The GM keeps a <b>Foes</b> line with each monster's hit points at the end of its messages.</li>
        ${SITE.sceneImages ? `<li><b>Painted scenes:</b> the AI can paint the current scene as a background for the battle map and the table display (up to ${SITE.sceneMax} per table${SITE.sceneInk ? `, ${SITE.sceneInk} ink each` : ''}). ${isRoomHost()
          ? `<label style="cursor:pointer;display:block;margin-top:6px;"><input type="checkbox" ${META && META.sceneImages === true ? 'checked' : ''} onchange="setSceneImages(this.checked)"> Let the AI paint scenes at this table</label>`
          : `It's ${META && META.sceneImages === true ? 'on' : 'off'} at this table; the host decides.`}</li>` : ''}
        <li><b>Field Notes:</b> your ${MODE === 'solo' ? '' : "party's "}journal. The GM writes down quests, people, places, clues, encounters and loot as the story goes, and you can add your own notes and search them any time.</li>
        <li><b>Battle map:</b> when a fight starts the GM lays out a grid on the <b>Battle Map</b> tab (1 square = 5 ft) with every hero and foe. Tap your hero, then a highlighted square, to move; you can move up to your speed each turn (30 ft for most, 25 ft for dwarves, halflings and gnomes). Tap anything to see how far away it is.</li>
        <li><b>XP and levels:</b> you earn XP for defeating foes (shared by the table) and for checks you pass against a DC with a real roll. Once you have enough XP, <b>Level Up</b> unlocks on Your Sheet after a <b>long rest</b>. A <b>short rest</b> lets you spend hit dice there to heal.</li>
        <li><label style="cursor:pointer;"><input type="checkbox" ${diceAnimOn() ? 'checked' : ''} onchange="setDiceAnim(this.checked)"> Show the dice-rolling popup when you roll (click it to dismiss early)</label></li>
        <li>Dice are <b>only</b> rolled when you type <code>/roll</code>. For a plain d20 check, just add the number, e.g. <code>/roll +5</code>. For any other dice — your own damage or healing, anything the GM asks you to roll — use full notation like <code>/roll 2d6+3</code> or <code>/roll 1d4</code>.</li>
        <li>For advantage or disadvantage on a d20 roll: <code>/roll +5 adv</code> or <code>/roll 1d20+5 dis</code> — rolls two d20s and keeps the higher or lower.</li>
        <li><b>Ask the GM to continue the story</b> sends the recent log and character/party status to the Game Master, who narrates what happens next.</li>
        <li>Your <b>Sheet</b> tab is where you track your own HP and inventory, and where you can describe your character and paint a <b>portrait</b> (one at a time, a few per table).</li>
        <li><b>Advance Session</b> in the header marks a new session in the log — useful for pacing a Short Arc or longer story.</li>
      </ul>
      ${feedbackBoxHTML()}
    </div>
  `;
}

/* ---------------- Expose handlers referenced by inline HTML attributes ---------------- */
/* Everything else stays scoped to this closure so it can't collide with
   globals declared by browser extensions or other scripts on the page. */
window.startNewCampaign = startNewCampaign;
window.goToJoin = goToJoin;
window.goToLanding = goToLanding;
window.setLen = setLen;
window.setSeedMode = setSeedMode;
window.setCreateName = setCreateName;
window.setCreateTone = setCreateTone;
window.setCreateSeed = setCreateSeed;
window.setCreateRuleset = setCreateRuleset;
window.submitCreate = submitCreate;
window.submitJoin = submitJoin;
window.copyCode = copyCode;
window.leaveTable = leaveTable;
window.addSkillRow = addSkillRow;
window.removeSkillRow = removeSkillRow;
window.setDraftField = setDraftField;
window.setComposerDraft = setComposerDraft;
window.setNewItemDraft = setNewItemDraft;
window.setNotesDraft = setNotesDraft;
window.setSkillName = setSkillName;
window.setSkillMod = setSkillMod;
window.addInvRow = addInvRow;
window.removeInvRow = removeInvRow;
window.setInvItem = setInvItem;
window.submitCharacter = submitCharacter;
window.setCharGenMode = setCharGenMode;
window.generateCharacter = generateCharacter;
window.cancelCharGen = cancelCharGen;
window.setTab = setTab;
window.advanceSession = advanceSession;
window.submitAction = submitAction;
window.pickRoll = pickRoll;
window.setDiceAnim = setDiceAnim;
window.askGM = askGM;
window.cancelGM = cancelGM;
window.addItem = addItem;
window.removeItem = removeItem;
window.saveNotes = saveNotes;
window.generatePortrait = generatePortrait;
window.setAppearanceDraft = setAppearanceDraft;
window.setPortraitDraft = setPortraitDraft;
window.runChip = runChip;
window.pauseStory = pauseStory;
window.resumeStory = resumeStory;
window.pickOption = pickOption;

window.openShop = openShop;
window.closeShop = closeShop;
window.buyPack = buyPack;
window.copyInkKey = copyInkKey;
window.useInkKey = useInkKey;

/* ---------------- Ink: balance, shop, Google Play purchases ---------------- */
let WALLET = null; // { enforced, free_left, paid, free_per_month, costs } from /api/wallet
let SHOP_REASON = '';
let SHOP_PACKAGES = null; // RevenueCat packages, once loaded
let SHOP_STATUS = '';
let SHOP_BUSY = false;
let purchasesReady = null;

function inkTotal() { return WALLET ? (WALLET.free_left || 0) + (WALLET.paid || 0) : 0; }
function inkBadgeHTML() {
  if (!WALLET || !WALLET.enforced) return '';
  return `<button class="badge ink-badge" onclick="openShop()" title="Your ink: GM replies and portraits use it">&#x1F58B; ${inkTotal()} ink</button>`;
}
function inkCostLabel(kind) {
  const cost = WALLET && WALLET.enforced && WALLET.costs ? WALLET.costs[kind] : 0;
  return cost ? ` <span class="ink-cost">(${cost} ink)</span>` : '';
}
function setWallet(w) {
  WALLET = { ...(WALLET || { enforced: true }), ...w };
  document.querySelectorAll('.ink-badge').forEach(b => { b.innerHTML = `&#x1F58B; ${inkTotal()} ink`; });
  if (el('shopOverlay')) renderShop();
}
async function refreshWallet(action) {
  const resp = await fetch(api('/api/wallet'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: playerId(), action: action === 'redeem' ? 'redeem' : 'balance' }),
  });
  const data = await resp.json();
  if (!resp.ok || data.error) throw new Error(data.error || `Request failed (${resp.status})`);
  const firstLoad = !WALLET;
  WALLET = data;
  if (firstLoad && data.enforced && VIEW === 'game') render();
  else setWallet({});
  return data;
}

function purchasesPlugin() {
  const C = window.Capacitor;
  if (!C) return null;
  return (C.Plugins && C.Plugins.Purchases) || (typeof C.registerPlugin === 'function' ? C.registerPlugin('Purchases') : null);
}
function initPurchases() {
  if (!IS_APP || !cfg.REVENUECAT_ANDROID_KEY) return Promise.reject(new Error('The shop is not set up in this build.'));
  if (!purchasesReady) {
    purchasesReady = (async () => {
      const P = purchasesPlugin();
      if (!P) throw new Error('The Google Play store module is missing from this build.');
      await P.configure({ apiKey: cfg.REVENUECAT_ANDROID_KEY, appUserID: playerId() });
      return P;
    })().catch(e => { purchasesReady = null; throw e; });
  }
  return purchasesReady;
}
async function loadPackages() {
  try {
    const P = await initPurchases();
    const offerings = await P.getOfferings();
    const cur = offerings && offerings.current;
    SHOP_PACKAGES = (cur && cur.availablePackages) || [];
    if (!SHOP_PACKAGES.length) SHOP_STATUS = 'No ink packs are on sale right now. Try again later.';
  } catch (e) {
    console.error(e);
    SHOP_PACKAGES = [];
    SHOP_STATUS = "The ink merchant's stall is closed right now. Try again in a few minutes.";
  }
  if (el('shopOverlay')) renderShop();
}

function openShop(reason) {
  SHOP_REASON = typeof reason === 'string' ? reason : '';
  SHOP_STATUS = '';
  if (!el('shopOverlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'shopOverlay';
    overlay.className = 'dice-overlay shop-overlay';
    overlay.onclick = e => { if (e.target === overlay) closeShop(); };
    document.body.appendChild(overlay);
  }
  renderShop();
  refreshWallet().catch(() => {});
  if (IS_APP && SHOP_PACKAGES === null) loadPackages();
}
function closeShop() { const o = el('shopOverlay'); if (o) o.remove(); }

function renderShop() {
  const o = el('shopOverlay');
  if (!o) return;
  const w = WALLET || {};
  const costs = w.costs || { gm: 1, portrait: 8 };
  let store;
  if (!IS_APP) {
    store = cfg.PLAY_STORE_URL
      ? `<p class="helptext">More ink is sold in <a href="${escapeAttr(cfg.PLAY_STORE_URL)}" target="_blank" rel="noopener">The Ledger app for Android</a>. Copy your ink key below and enter it in the app, and what you buy there works here too.</p>`
      : `<p class="helptext">More ink is sold in The Ledger app for Android.</p>`;
  } else if (SHOP_PACKAGES === null) {
    store = `<p class="thinking">Opening the Google Play store...</p>`;
  } else {
    store = SHOP_PACKAGES.map((pkg, i) => {
      const prod = pkg.product || {};
      // Play adds "(App name)" to product titles; drop it.
      const title = String(prod.title || prod.identifier || 'Ink').replace(/\s*\(.*\)\s*$/, '');
      return `<button class="btn solid wide shop-pack" ${SHOP_BUSY ? 'disabled' : ''} onclick="buyPack(${i})">${escapeHtml(title)} &middot; ${escapeHtml(prod.priceString || '')}</button>`;
    }).join('');
  }
  o.innerHTML = `
    <div class="dice-card shop-card" role="dialog" aria-label="Ink pot">
      <div class="dice-title">The Ink Pot</div>
      ${SHOP_REASON ? `<p class="error-text">${escapeHtml(SHOP_REASON)}</p>` : ''}
      <div class="shop-balance">${inkTotal()} <span>ink</span></div>
      <p class="helptext">${w.free_left || 0} free ink left this month (of ${w.free_per_month || 0}; it refills on the 1st) &middot; ${w.paid || 0} bought ink, which never expires.</p>
      <p class="helptext">A Game Master reply costs ${costs.gm} ink. A character portrait costs ${costs.portrait}. Rolls, sheets and the story log are always free.</p>
      <div class="shop-packs">${store}</div>
      ${SHOP_STATUS ? `<p class="helptext shop-status">${escapeHtml(SHOP_STATUS)}</p>` : ''}
      ${accountNudgeHTML()}
      <details class="shop-key">
        <summary>Your ink key (to move your ink to another device)</summary>
        <p class="helptext">Ink belongs to this key. Keep a copy somewhere safe: if you reinstall the app or switch phones, enter it there to keep your ink.</p>
        <code class="ink-key">${escapeHtml(playerId())}</code> <button class="btn" onclick="copyInkKey()">Copy</button>
        <div class="shop-key-row">
          <input type="text" id="inkKeyInput" placeholder="Paste an ink key from another device" autocomplete="off" spellcheck="false">
          <button class="btn" onclick="useInkKey()">Use key</button>
        </div>
      </details>
      <button class="btn wide" style="margin-top:14px;" onclick="closeShop()">Close</button>
    </div>`;
}

async function buyPack(i) {
  const pkg = SHOP_PACKAGES && SHOP_PACKAGES[i];
  if (!pkg || SHOP_BUSY) return;
  SHOP_BUSY = true; SHOP_STATUS = 'Waiting for Google Play...'; renderShop();
  try {
    const P = await initPurchases();
    await P.purchasePackage({ aPackage: pkg });
    SHOP_STATUS = 'Payment received. Adding your ink...'; renderShop();
    // RevenueCat can take a moment to see the purchase; try a few times.
    let added = 0;
    for (let attempt = 0; attempt < 4 && !added; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1500 * attempt));
      try { added = (await refreshWallet('redeem')).added || 0; } catch (e) { console.warn('redeem after purchase failed:', e.message); }
    }
    SHOP_STATUS = added ? `Added ${added} ink. Thank you!` : 'Your purchase went through. The ink will appear within a few minutes (reopen the app if it doesn\'t).';
    SHOP_REASON = '';
  } catch (e) {
    // Raw native errors (no RevenueCat JS wrapper here): code "1" is PURCHASE_CANCELLED.
    const d = (e && e.data) || {};
    const cancelled = e && (e.userCancelled || d.userCancelled || String(e.code) === '1' || String(d.code) === '1' || /cancel/i.test(String(e.message || '')));
    SHOP_STATUS = cancelled ? 'Purchase cancelled.' : "The purchase didn't go through, and you weren't charged for anything you didn't receive. Try again in a moment.";
  } finally {
    SHOP_BUSY = false;
    renderShop();
  }
}

function copyInkKey() {
  const key = playerId();
  const done = () => { SHOP_STATUS = 'Ink key copied.'; renderShop(); };
  if (navigator.clipboard) navigator.clipboard.writeText(key).then(done, () => {});
}
async function useInkKey() {
  const box = el('inkKeyInput');
  const key = (box ? box.value : '').trim().toLowerCase();
  if (!PLAYER_ID_RE.test(key)) { SHOP_STATUS = 'That doesn\'t look like an ink key.'; return renderShop(); }
  if (key === playerId()) { SHOP_STATUS = 'That is already this device\'s key.'; return renderShop(); }
  if (signedIn()) { SHOP_STATUS = 'You\'re signed in, so your account keeps your ink key. Sign out first to use a different key.'; return renderShop(); }
  if (!confirm('Switch this device to that ink key? Ink on the current key stays with the current key, so copy it first if it has ink left.')) return;
  try { localStorage.setItem(PLAYER_KEY, key); } catch (e) { memoryPlayerId = key; }
  if (IS_APP && purchasesReady) {
    try { const P = await purchasesReady; await P.logIn({ appUserID: key }); } catch (e) { purchasesReady = null; }
  }
  await refreshMyHash();
  SHOP_STATUS = 'This device now uses that ink key.';
  try { await refreshWallet(IS_APP ? 'redeem' : 'balance'); } catch (e) { SHOP_STATUS = "The ink ledger is being re-bound. Your balance will show in a few minutes."; }
  renderShop();
}

/* ---------------- NFC minis: tap-to-play tags (see NFC-MINIS.md) ----------------
   A sticker in a mini's base holds https://<site>/t/<tag id>, which netlify.toml redirects to /?tag=<id>.
   Tags point at lasting heroes and monsters, never at a room (rooms get evicted), and are added into
   whatever table this device is sitting at (CURRENT_ROOM_KEY) or one picked by code. */
const TAG_ID_RE = /^[hmik]_[a-z0-9]{10,40}$/;
let TAG = null;        // { id, kind, data } once loaded
let TAG_STATE = '';    // '' | 'loading' | 'missing' | 'error'
let TAG_MSG = '';      // last result or problem, shown under the buttons
let TAG_BUSY = false;
let TAG_ROOM = null;   // { code, name } of the table this device is at, if it still exists

async function openTag(id) {
  VIEW = 'tag'; TAG = null; TAG_STATE = 'loading'; TAG_MSG = ''; TAG_ROOM = null;
  render();
  const { data, error } = await supabase.from('tags').select('id, kind, data, status, moved_to').eq('id', id).maybeSingle();
  minisCall('tap', { tagId: id }).catch(() => {}); // every tap is logged, so copied stickers show up
  if (error) { console.error(error); TAG_STATE = 'error'; }
  else if (!data || !['hero', 'monster', 'item'].includes(data.kind)) TAG_STATE = 'missing';
  else { TAG = data; TAG_STATE = ''; }
  const code = recallCurrentRoom();
  if (TAG && code) {
    const room = await dbGetRoom(code);
    if (room) TAG_ROOM = { code, name: (room.meta && room.meta.name) || code, meta: room.meta || {} };
    else forgetCurrentRoom();
  }
  if (VIEW === 'tag') render();
}
function closeTag() {
  TAG = null; TAG_MSG = '';
  goToLanding();
}
function tagCodeRow(label, onclick) {
  return `
    <div class="field tag-code">
      <label>${label}</label>
      <div class="tag-code-row">
        <input type="text" id="tagCode" placeholder="e.g. F3K9M" maxlength="5" autocomplete="off" style="text-transform:uppercase;letter-spacing:0.1em;">
        <button class="btn" ${TAG_BUSY ? 'disabled' : ''} onclick="${onclick}">Go</button>
      </div>
    </div>`;
}
function tagCodeInput() { const box = el('tagCode'); return box ? box.value : ''; }

function renderTag() {
  let eyebrow = 'Tapped Mini', body;
  if (TAG_STATE === 'loading') body = `<p class="thinking">Reading your mini...</p>`;
  else if (TAG_STATE === 'error') body = `<p class="error-text">Couldn't read this mini right now. Check your connection and tap it again.</p>`;
  else if (TAG_STATE === 'missing' || !TAG) body = `<h2>Unknown mini</h2><p class="helptext">This mini isn't linked to anything The Ledger knows about. If it came in a kit, contact support.</p>`;
  else if (TAG.status === 'moved') body = `<h2>This mini has moved</h2><p class="helptext">Its hero now lives on a different mini. Tap that one to play.</p>`;
  else if (TAG.status === 'disabled') body = `<h2>This mini has been retired</h2><p class="helptext">If you think that's a mistake, contact support.</p>`;
  else if (TAG.kind === 'hero' && TAG.status === 'blank') { eyebrow = 'Blank Mini'; body = tagBlankHTML(); }
  else if (TAG.kind === 'hero') { eyebrow = 'A Hero Answers'; body = tagHeroHTML(); }
  else if (TAG.kind === 'item') { eyebrow = 'Loot Found'; body = tagItemHTML(); }
  else { eyebrow = 'Monster Mini'; body = tagMonsterHTML(); }
  el('app').innerHTML = `
    <div class="top-nav"><button class="link-btn" onclick="closeTag()">&larr; The Ledger</button></div>
    <div class="panel" style="max-width:520px;margin:0 auto;">
      <div class="eyebrow">${eyebrow}</div>
      ${body}
      ${TAG_MSG ? `<p class="hero-note">${escapeHtml(TAG_MSG)}</p>` : ''}
    </div>`;
}

/* ---- hero minis ---- */
function tagHeroHTML() {
  const h = TAG.data || {};
  const name = h.name || 'this hero';
  const stats = ['str', 'dex', 'con', 'int', 'wis', 'cha']
    .map(k => `<div><b>${k.toUpperCase()}</b>${Number(h[k]) || 10}</div>`).join('');
  return `
    <h2>${escapeHtml(h.name || 'Unnamed hero')}</h2>
    <p class="helptext">${escapeHtml([h.race, h.klass].filter(Boolean).join(' ') || 'Adventurer')} &middot; Level ${Number(h.level) || 1} &middot; HP ${Number(h.maxhp) || 10} &middot; AC ${Number(h.ac) || 10}</p>
    <div class="tag-stats">${stats}</div>
    ${h.appearance ? `<p class="helptext">${escapeHtml(h.appearance)}</p>` : ''}
    ${TAG_ROOM ? `<button class="btn solid wide" ${TAG_BUSY ? 'disabled' : ''} onclick="tagHeroJoin('${escapeAttr(TAG_ROOM.code)}')">Bring ${escapeHtml(name)} to ${escapeHtml(TAG_ROOM.name)}</button>` : ''}
    ${tagCodeRow(TAG_ROOM ? 'Or join another table with its code' : 'Join a table with its code', 'tagHeroJoinCode()')}
    <button class="btn wide" ${TAG_BUSY ? 'disabled' : ''} onclick="tagHeroSolo()">Start a solo story with ${escapeHtml(name)}</button>`;
}
// Each hero sheet exactly as it was read from its tag, by tag id. Joining rebuilds the character from
// this copy, so the locked setup screen can't be used to change a mini's stats.
const HERO_SOURCES = {};
// A tag's character sheet, shaped like a fresh character draft and marked with the tag it came from.
function heroFromTag(tagId, data) {
  const h = data || {};
  const num = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const d = {
    ...blankChar(),
    name: String(h.name || 'Unnamed hero').slice(0, 60),
    race: String(h.race || '').slice(0, 40),
    klass: String(h.klass || '').slice(0, 40),
    level: num(h.level, 1, 20, 1),
    ac: num(h.ac, 1, 30, 10),
    notes: String(h.notes || '').slice(0, 2000),
    appearance: String(h.appearance || '').slice(0, 500),
    gender: String(h.gender || '').slice(0, 30),
    age: String(h.age || '').slice(0, 20),
    heroTag: tagId,
  };
  for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) d[k] = num(h[k], 1, 30, 10);
  d.maxhp = num(h.maxhp, 1, 999, 10);
  d.hp = d.maxhp;
  d.xp = num(h.xp, 0, 400000, [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000][d.level]);
  d.skills = Array.isArray(h.skills) ? h.skills.slice(0, 30).map(s => ({ name: String((s && s.name) || '').slice(0, 40), mod: num(s && s.mod, -10, 20, 0) })).filter(s => s.name) : [];
  d.inventory = Array.isArray(h.inventory) ? h.inventory.slice(0, 40).map(i => String(i).slice(0, 80)).filter(Boolean) : [];
  d.spells = Array.isArray(h.spells) ? h.spells.slice(0, 40).map(s => String(s).slice(0, 60)) : [];
  return d;
}
function heroDraft() {
  HERO_SOURCES[TAG.id] = TAG.data || {};
  return heroFromTag(TAG.id, TAG.data);
}
// Character setup for a hero that came from a mini: the sheet is shown read-only.
function renderHeroSetup(d) {
  const stats = ['str', 'dex', 'con', 'int', 'wis', 'cha'].map(k => `<div><b>${k.toUpperCase()}</b>${d[k]}</div>`).join('');
  const list = items => items.length ? `<ul class="hero-list">${items.map(i => `<li>${i}</li>`).join('')}</ul>` : '<p class="helptext">None</p>';
  el('app').innerHTML = `
    <div class="top-nav">
      ${codeBadge()}
      <div style="display:flex;gap:14px;align-items:center;">
        <button class="link-btn" onclick="copyCode()">${MODE === 'solo' ? 'Copy story code' : 'Copy invite code'}</button>
        <button class="link-btn" onclick="${MODE === 'solo' ? 'pauseStory()' : 'leaveTable()'}">${MODE === 'solo' ? 'Pause' : 'Leave'}</button>
      </div>
    </div>
    <div class="panel" style="max-width:600px;margin:0 auto;">
      <div class="eyebrow">Your Hero, From Your Mini</div>
      <h2>${escapeHtml(META.name)}</h2>
      <p class="hero-note">&#x2726; <b>${escapeHtml(d.name)}</b> came from your mini. A mini's sheet is set by the mini, so it can't be changed here. Add your own name and press <i>${MODE === 'solo' ? 'Begin' : 'Join the Table'}</i>.</p>
      <div class="field"><label>Your Name (player)</label><input type="text" id="pName" maxlength="40" value="${escapeAttr(d.player || '')}" oninput="setDraftField('player', this.value)"></div>
      <h3 class="hero-name">${escapeHtml(d.name)}</h3>
      <p class="helptext">${escapeHtml([d.race, d.klass].filter(Boolean).join(' ') || 'Adventurer')} &middot; Level ${d.level} &middot; HP ${d.maxhp} &middot; AC ${d.ac}</p>
      <div class="tag-stats">${stats}</div>
      <div class="field"><label>Skills</label>${list(d.skills.map(s => `${escapeHtml(s.name)} ${fmtMod(s.mod)}`))}</div>
      <div class="field"><label>Gear</label>${list(d.inventory.map(i => escapeHtml(i)))}</div>
      ${d.appearance ? `<div class="field"><label>Appearance</label><p class="helptext">${escapeHtml(d.appearance)}</p></div>` : ''}
      ${d.notes ? `<div class="field"><label>Notes</label><p class="helptext">${escapeHtml(d.notes)}</p></div>` : ''}
      <div id="charErr" class="error-text"></div>
      <button class="btn solid wide" onclick="submitCharacter()">${MODE === 'solo' ? 'Begin' : 'Join the Table'}</button>
      <button class="link-btn" style="display:block;margin:12px auto 0;" onclick="dropHeroDraft()">Build a different character instead</button>
    </div>`;
}
function dropHeroDraft() { draftChar = null; renderCharSetup(); }
window.dropHeroDraft = dropHeroDraft;
async function tagHeroJoin(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code || TAG_BUSY || !TAG) return;
  TAG_BUSY = true; TAG_MSG = ''; render();
  const tagId = TAG.id;
  try {
    draftChar = heroDraft(); charGenMode = 'manual'; CHARGEN_ERROR = '';
    const err = await enterRoom(code);
    if (err) { VIEW = 'tag'; TAG_MSG = err; return; }
    // Tapping the same mini again (or on another phone) picks that hero back up instead of adding a copy.
    const existingId = Object.keys(ROSTER).find(id => ROSTER[id].heroTag === tagId);
    if (existingId) {
      draftChar = null;
      MY_CHAR_ID = existingId; rememberCharacter(code, existingId); rememberCurrentRoom(code);
      VIEW = 'game'; ACTIVE_TAB = 'story'; subscribeRealtime(code);
    } else {
      VIEW = 'charsetup';
    }
    TAG = null;
  } finally {
    TAG_BUSY = false;
    render();
  }
}
function tagHeroJoinCode() { tagHeroJoin(tagCodeInput()); }
function tagHeroSolo() {
  if (!TAG) return;
  draftChar = heroDraft(); charGenMode = 'manual'; CHARGEN_ERROR = '';
  TAG = null;
  startNewCampaign('solo');
}

/* ---- monster minis: physical stand-ins only ----
   The AI Game Master decides which foes appear; players never add monsters. A monster mini is a piece for
   the real table: tapping it shows the creature's card and, if your table's current fight has any of that
   creature, each one's live HP and map square (from the game's foe tracking). */
function tagMonsterHTML() {
  const m = TAG.data || {};
  const name = m.name || 'Unknown creature';
  const hp = srdHp(name);
  const meta = (TAG_ROOM && TAG_ROOM.meta) || {};
  const base = creatureBase(name);
  const live = Object.values(meta.foes || {}).filter(f => creatureBase(f.name) === base);
  const tokens = (meta.grid && meta.grid.tokens) || [];
  const where = f => { const t = tokens.find(t => t.name.toLowerCase() === f.name.toLowerCase()); return t ? ` · square ${sq(t.x, t.y)}` : ''; };
  const fight = !TAG_ROOM ? `<p class="helptext">Join a table, then tap this mini during a fight to see its foes' hit points.</p>`
    : live.length ? `<div class="field"><label>In ${escapeHtml(TAG_ROOM.name)} right now</label><ul class="hero-list">${live.map(f => `<li><b>${escapeHtml(f.name)}</b> ${f.hp}/${f.maxhp} HP${where(f)}</li>`).join('')}</ul></div>`
    : `<p class="helptext">No ${escapeHtml(name)} in the fight at ${escapeHtml(TAG_ROOM.name)} right now.</p>`;
  return `
    <h2>${escapeHtml(name)}</h2>
    <p class="helptext">${m.cr ? `Challenge rating ${escapeHtml(String(m.cr))}` : ''}${m.cr && hp ? ' &middot; ' : ''}${hp ? `${hp} hit points` : ''}</p>
    <p class="hero-note">A stand-in for the real table: when the Game Master brings ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${escapeHtml(name)} into the story, set this mini on your grid. Tapping it never adds a monster; the GM decides who you fight.</p>
    ${fight}
    ${tagCodeRow(TAG_ROOM ? 'Check another table' : 'Check a table by its code', 'tagMonsterCheckCode()')}`;
}
async function tagMonsterCheckCode() {
  const code = String(tagCodeInput() || '').trim().toUpperCase();
  if (!code || TAG_BUSY || !TAG) return;
  TAG_BUSY = true; TAG_MSG = ''; render();
  try {
    const room = await dbGetRoom(code);
    if (!room) { TAG_MSG = 'No campaign found with that code.'; return; }
    TAG_ROOM = { code, name: (room.meta && room.meta.name) || code, meta: room.meta || {} };
  } finally {
    TAG_BUSY = false;
    if (VIEW === 'tag') render();
  }
}

/* ---- loot minis (i_ tags) ----
   Tapping a loot coin puts its item into your character's inventory at your table. Each coin can be
   claimed once per table per session (tracked in the room's meta.loot), so it can't be tapped for
   endless potions, but it can turn up again in a later session. */
const withArticle = name => `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name}`;
function tagItemHTML() {
  const it = TAG.data || {};
  return `
    <h2>${escapeHtml(it.name || 'A mysterious item')}</h2>
    ${it.description ? `<p class="helptext">${escapeHtml(it.description)}</p>` : ''}
    <p class="helptext">Your character picks it up and it goes into their inventory. Each loot token can be claimed once per table each session.</p>
    ${TAG_ROOM ? `<button class="btn solid wide" ${TAG_BUSY ? 'disabled' : ''} onclick="tagClaimItem('${escapeAttr(TAG_ROOM.code)}')">Give it to your hero in ${escapeHtml(TAG_ROOM.name)}</button>` : ''}
    ${tagCodeRow(TAG_ROOM ? 'Or claim it at another table' : 'Which table are you playing at? Enter its room code', 'tagClaimItemCode()')}`;
}
async function tagClaimItem(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code || TAG_BUSY || !TAG) return;
  TAG_BUSY = true; TAG_MSG = ''; render();
  try {
    const room = await dbGetRoom(code);
    if (!room) { TAG_MSG = 'No campaign found with that code.'; return; }
    const tableName = (room.meta && room.meta.name) || code;
    const mem = recallCharacter(code);
    const row = mem ? (await dbGetCharacters(code)).find(r => r.id === mem.characterId) : null;
    if (!row) { TAG_MSG = `You don't have a hero at ${tableName} on this device. Join the table first, then tap the loot again.`; return; }
    const meta = room.meta || {};
    const session = meta.session || 1;
    const loot = meta.loot && typeof meta.loot === 'object' ? meta.loot : {};
    if (loot[TAG.id] === session) { TAG_MSG = 'This loot has already been claimed at that table this session. It can turn up again next session.'; return; }
    const item = String((TAG.data && TAG.data.name) || 'Mysterious item').slice(0, 80);
    const c = row.data || {};
    const inv = Array.isArray(c.inventory) ? c.inventory.filter(i => String(i).trim()) : [];
    if (inv.length >= 40) { TAG_MSG = `${c.name || 'Your hero'}'s pack is full. Drop something from the Sheet tab first.`; return; }
    c.inventory = [...inv, item];
    await dbUpsertCharacter(row.id, code, c);
    await dbUpdateRoomMeta(code, { ...meta, loot: { ...loot, [TAG.id]: session } });
    const desc = String((TAG.data && TAG.data.description) || '').slice(0, 300);
    await dbInsertLog(code, { id: uid(6), author: 'The Ledger', type: 'system', text: `🎁 ${c.name || 'A hero'} found ${withArticle(item)}! (from a loot token)${desc ? ' ' + desc : ''}` });
    // Go to the table to see it land in the log.
    const err = await enterRoom(code);
    if (!err && VIEW === 'game') { TAG = null; return; }
    VIEW = 'tag';
    TAG_ROOM = { code, name: tableName };
    TAG_MSG = `${item} is now in ${c.name || 'your hero'}'s inventory.`;
  } finally {
    TAG_BUSY = false;
    if (VIEW === 'tag') render();
  }
}
function tagClaimItemCode() { tagClaimItem(tagCodeInput()); }
window.tagClaimItem = tagClaimItem;
window.tagClaimItemCode = tagClaimItemCode;

/* ---- levelling up (any character) ----
   Once the table has advanced to a new session, each character may gain one level: max HP goes up by
   the class hit die's average + CON modifier, and listed skills rise with the proficiency bonus. */
const HIT_DIE = { barbarian: 12, fighter: 10, paladin: 10, ranger: 10, sorcerer: 6, wizard: 6 }; // everything else d8
function hitDieFor(klass) {
  const k = String(klass || '').toLowerCase();
  for (const [name, die] of Object.entries(HIT_DIE)) if (k.includes(name)) return die;
  return 8;
}
const profFor = lvl => 2 + Math.floor((Math.max(1, lvl) - 1) / 4);
function levelUpGain(c) { return Math.max(1, hitDieFor(c.klass) / 2 + 1 + abilityMod(c.con)); }
/* ---- foe hit points are kept by the game, not the GM ----
   META.foes = { "goblin a (blade)": { name, hp, maxhp } }, shared live through the room like the map.
   - [[foe: Goblin A | 7]] adds a foe; an SRD creature's HP comes from its stat block (srd-xp.js) if no number is given.
   - [[hit: Goblin A, Goblin B half | Brannoc]] applies the HERO'S OWN damage roll: the game finds that hero's latest
     unused, un-voided damage roll since the previous GM message and takes exactly its total off each foe (half for
     foes marked half, as for a made save). No roll in the log, no damage. Players always roll their own damage.
   - NPC allies' attacks ([[foe-attack]] with an AC) are rolled by the game and come off tracked foes too.
   - At 0 HP a foe is defeated: XP is awarded and it leaves the map. */
function creatureBase(name) {
  return String(name || '').toLowerCase().replace(/\s*\([^)]*\)\s*/g, ' ').trim().replace(/^(the|a|an)\s+/, '').replace(/\s+(#?\d+|[a-z])$/, '').trim();
}
function srdHp(name) {
  const t = window.SRD_HP || {};
  const n = creatureBase(name);
  return t[n] ?? t[n.replace(/s$/, '')] ?? t[n.replace(/es$/, '')];
}
function foeTable() { if (!META) return {}; if (!META.foes || typeof META.foes !== 'object') META.foes = {}; return META.foes; }
function findFoe(name) {
  const foes = foeTable();
  const k = String(name || '').trim().toLowerCase();
  if (!k) return null;
  if (foes[k]) return foes[k];
  const list = Object.values(foes);
  return list.find(f => f.name.toLowerCase().replace(/\s*\([^)]*\)/g, '').trim() === k.replace(/\s*\([^)]*\)/g, '').trim())
    || list.find(f => f.name.toLowerCase().startsWith(k) || k.startsWith(f.name.toLowerCase()))
    || null;
}
function addFoe(name, hpText, ally) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const existing = findFoe(clean);
  const given = parseInt(String(hpText || '').replace(/[^0-9]/g, ''));
  const hp = Number.isFinite(given) && given > 0 ? Math.min(999, given) : srdHp(clean);
  if (existing) { if (Number.isFinite(given) && given > 0) { existing.maxhp = hp; existing.hp = Math.min(existing.hp, hp); } if (ally) existing.ally = true; return existing; }
  if (!hp) return null;
  const foe = { name: clean, hp, maxhp: hp, ...(ally ? { ally: true } : {}) };
  foeTable()[clean.toLowerCase()] = foe;
  return foe;
}
function dropFoe(foe) { const t = foeTable(); for (const k of Object.keys(t)) if (t[k] === foe) delete t[k]; }
function foesPromptText() {
  const all = Object.values(foeTable());
  const list = all.filter(f => !f.ally), allies = all.filter(f => f.ally);
  return (list.length ? `Foes (hit points tracked by the game; copy these into your Foes line, never change them yourself): ${list.map(f => `${f.name} ${f.hp}/${f.maxhp} HP`).join(' · ')}` : 'Foes tracked by the game: none.')
    + (allies.length ? `\nAllies (friendly NPCs; hit points tracked by the game): ${allies.map(f => `${f.name} ${f.hp}/${f.maxhp} HP${f.hp === 0 ? ' (down)' : ''}`).join(' · ')}` : '');
}
// When a foe reaches 0: defeat it (XP, off the map) and fold that into the caller's log line.
function foeFell(foe) {
  if (foe.ally) return { text: `${foe.name} is down!` };
  dropFoe(foe);
  return resolveDefeat({ target: foe.name, cr: '' });
}
// [[foe: Goblin A | 7]]
function resolveFoe(f) {
  const foe = addFoe(f.target, f.hp, f.ally);
  if (!foe) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${f.target}: the game doesn't know its hit points, so give a number, e.g. [[foe: ${f.target} | 20${f.ally ? ' | ally' : ''}]].` };
  return { id: uid(6), author: 'The Ledger', type: 'system', text: foe.ally ? `🛡 ${foe.name} fights alongside you (${foe.hp}/${foe.maxhp} HP).` : `⚔ ${foe.name} joins the fight (${foe.hp}/${foe.maxhp} HP).`, saveMeta: true };
}
// [[hit: Goblin A, Goblin B half | Brannoc]]
function resolveHit(h) {
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text });
  const hero = h.hero ? findTarget(h.hero) : (Object.keys(ROSTER).length === 1 ? Object.values(ROSTER)[0] : null);
  if (!hero) return fail(`A hit on ${h.target} was called, but the game couldn't tell whose roll it was.`);
  // The hero's newest damage roll since the GM message before this one (the current GM message is already in LOG).
  const gmIdx = LOG.map((e, i) => e.type === 'gm' ? i : -1).filter(i => i >= 0);
  const from = gmIdx.length >= 2 ? gmIdx[gmIdx.length - 2] + 1 : 0;
  const used = new Set(Array.isArray(META.usedRolls) ? META.usedRolls : []);
  const voided = rerollIds();
  const roll = LOG.slice(from).filter(e => e.type === 'roll' && String(e.author).toLowerCase() === hero.name.toLowerCase()
    && !/d20\(/.test(e.text) && !used.has(e.id) && !voided.has(e.id)).pop();
  if (!roll) return fail(`No damage to ${h.target}: ${hero.name} hasn't rolled damage for it yet. Roll it with /roll (e.g. /roll 1d8+3).`);
  const total = parseInt((/=\s*(-?\d+)/.exec(roll.text) || [])[1]);
  if (!(total >= 0)) return fail(`No damage to ${h.target}: the game couldn't read ${hero.name}'s roll.`);
  META.usedRolls = [...used, roll.id].slice(-100);
  const parts = [];
  const fell = [];
  let saveAll = false;
  for (let raw of String(h.target).split(/\s*(?:,|;|&|\band\b)\s*/i)) {
    raw = raw.trim(); if (!raw) continue;
    const half = /\s*\(?\bhalf\b\)?$/i.test(raw);
    const name = raw.replace(/\s*\(?\bhalf\b\)?$/i, '').trim();
    const foe = findFoe(name) || addFoe(name);
    if (!foe) { parts.push(`${name}: not a foe the game is tracking`); continue; }
    const dmg = half ? Math.floor(total / 2) : total;
    const before = foe.hp;
    foe.hp = Math.max(0, foe.hp - dmg);
    parts.push(`${foe.name} ${dmg}${half ? ' (halved by the save)' : ''} — HP ${before} → ${foe.hp}/${foe.maxhp}${foe.hp === 0 ? ' (down!)' : ''}`);
    if (foe.hp === 0) fell.push(foe);
  }
  let text = `🗡 ${hero.name}'s roll (${total}): ${parts.join('; ')}`;
  for (const foe of fell) { const d = foeFell(foe); text += ` ${d.text}`; saveAll = saveAll || !!d.saveAll; }
  return { id: uid(6), author: 'The Ledger', type: 'system', text, saveMeta: true, saveAll };
}

/* ---- levelling: XP earned in play, level-ups at a long rest ----
   Characters can't level just by pressing Advance Session. XP comes only from things the game can check:
   - kills: [[defeat: Goblin]] -> XP from the SRD monster list (srd-xp.js), split across the party.
     Made-up creatures may give a CR ([[defeat: Cave Wyrm | CR 2]]), and every kill is capped near the
     party's level (CR = level), so a story can't hand a level-1 hero a dragon's worth of XP.
   - skills: [[success: Brannoc | Stealth | DC 15]] pays only if that character has a real, un-voided
     d20 roll since the previous GM message that meets the DC; each roll can pay once.
   Level Up then needs enough XP *and* a long rest ([[long-rest]]), which restores full HP anyway. */
const XP_FOR_LEVEL = [0, 0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];
const CR_XP = { '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900, '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000, '14': 11500, '15': 13000, '16': 15000, '17': 18000, '18': 20000, '19': 22000, '20': 25000 };
const LONG_REST_GAP = 8;  // GM replies needed between long rests
const SHORT_REST_GAP = 3; // ...and between short rests
const crNum = cr => { const s = String(cr); if (s.includes('/')) { const [a, b] = s.split('/').map(Number); return a / b; } return Number(s) || 0; };
function xpOf(c) { const lvl = parseInt(c.level) || 1; return Number.isFinite(c.xp) ? c.xp : XP_FOR_LEVEL[lvl]; }
function nextLevelXp(c) { const lvl = parseInt(c.level) || 1; return lvl >= 20 ? null : XP_FOR_LEVEL[lvl + 1]; }
function partyLevel() { const cs = Object.values(ROSTER); return cs.length ? Math.round(cs.reduce((s, c) => s + (parseInt(c.level) || 1), 0) / cs.length) : 1; }
function gmCount() { return LOG.filter(e => e.type === 'gm').length; }
const sysEntry = (text, extra) => ({ id: uid(6), author: 'The Ledger', type: 'system', text, ...(extra || {}) });

function addXp(c, amount) {
  c.xp = xpOf(c) + Math.max(0, Math.round(amount));
  const need = nextLevelXp(c);
  return need !== null && c.xp >= need;
}
// XP for a creature by name: SRD table first ("Goblin B" -> goblin, "goblins" -> goblin), then a CR the GM gave.
function creatureXp(name, crText) {
  const table = window.SRD_XP || {};
  let n = creatureBase(name);
  let xp = table[n] ?? table[n.replace(/s$/, '')] ?? table[n.replace(/es$/, '')];
  let cr = null;
  if (xp === undefined) {
    const m = /cr\s*([0-9]+(?:\/[0-9]+)?)/i.exec(String(crText || ''));
    if (m && CR_XP[m[1]] !== undefined) { cr = m[1]; xp = CR_XP[cr]; }
  }
  if (xp === undefined) return { xp: 0, known: false };
  // Cap: one kill is never worth more than a creature of the party's own level (CR = average level).
  const capCr = Math.min(20, partyLevel());
  const capXp = CR_XP[String(capCr)] || 25000;
  return { xp: Math.min(xp, capXp), known: true, capped: xp > capXp };
}
// [[defeat: Goblin]] — split the creature's XP across everyone at the table.
function resolveDefeat(d) {
  const ally = findFoe(d.target);
  if (ally && ally.ally) return sysEntry(`${ally.name} is an ally, not a foe: no XP for that.`);
  const cs = Object.values(ROSTER);
  const { xp, known, capped } = creatureXp(d.target, d.cr);
  if (!known) { const off = removeTokenNamed(d.target); return sysEntry(`⚔ ${d.target} is defeated (no XP: the game doesn't know that creature's challenge rating).`, { saveMeta: off }); }
  const tracked = findFoe(d.target);
  if (tracked) dropFoe(tracked);
  const offMap = removeTokenNamed(d.target) || !!tracked;
  const each = Math.floor(xp / Math.max(cs.length, 1));
  const ready = [];
  cs.forEach(c => { if (addXp(c, each)) ready.push(c.name); });
  return sysEntry(`⚔ ${d.target} defeated: +${each} XP${cs.length > 1 ? ' each' : ''}${capped ? ' (capped for your level)' : ''}.${ready.length ? ` ${ready.join(', ')} ${ready.length > 1 ? 'have' : 'has'} enough XP to level up at the next long rest.` : ''}`, { saveAll: true, saveMeta: offMap });
}
// [[success: Brannoc | Stealth | DC 15]] — pays only for a real roll that met the DC.
function resolveSuccess(s) {
  const c = findTarget(s.target);
  if (!c) return sysEntry(`A success was noted, but the game couldn't tell whose it was.`);
  const dc = Math.max(5, Math.min(30, parseInt(String(s.dc || '').replace(/[^0-9]/g, '')) || 0));
  if (!dc) return sysEntry(`${c.name}'s success had no DC, so it earns no XP.`);
  const voided = rerollIds();
  const paid = new Set(Array.isArray(c.xpRolls) ? c.xpRolls : []);
  // Rolls since the GM message before this one (the current GM message is already in LOG).
  const gmIdx = LOG.map((e, i) => e.type === 'gm' ? i : -1).filter(i => i >= 0);
  const from = gmIdx.length >= 2 ? gmIdx[gmIdx.length - 2] + 1 : 0;
  const skill = String(s.skill || '').toLowerCase();
  const rolls = LOG.slice(from).filter(e => e.type === 'roll' && String(e.author).toLowerCase() === c.name.toLowerCase()
    && /d20\(/.test(e.text) && !/attack|death save/i.test(e.text) && !voided.has(e.id) && !paid.has(e.id));
  const pick = rolls.filter(e => skill && String(e.text).toLowerCase().includes(skill)).pop() || rolls.pop();
  if (!pick) return sysEntry(`${c.name}'s ${s.skill || 'check'} earns no XP: there's no new roll for it in the log.`);
  const total = parseInt((/=\s*(-?\d+)/.exec(pick.text) || [])[1]);
  if (!(total >= dc)) return sysEntry(`${c.name}'s ${s.skill || 'check'} earns no XP: the roll (${total}) didn't meet DC ${dc}.`);
  const lvl = parseInt(c.level) || 1;
  const xp = (dc - 5) * 3 * lvl;
  c.xpRolls = [...paid, pick.id].slice(-60);
  const ready = addXp(c, xp);
  return sysEntry(`✦ ${c.name}: ${s.skill || 'check'} succeeded (${total} vs DC ${dc}) — +${xp} XP.${ready ? ` ${c.name} has enough XP to level up at the next long rest.` : ''}`, { hpChar: charIdOf(c) });
}

// ---- rests ----
function roomMeta() { return META || {}; }
function shortRestOpen() { const m = roomMeta(); return Number.isFinite(m.shortRestAt) && m.shortRestAt === gmCount(); }
function hitDiceLeft(c) { return Math.max(0, (parseInt(c.level) || 1) - (parseInt(c.hitDiceUsed) || 0)); }
// [[long-rest]]: full HP, half your hit dice back, and Level Up unlocks for anyone with the XP.
function resolveLongRest() {
  const m = roomMeta();
  const since = gmCount() - (Number.isFinite(m.lastLongRest) ? m.lastLongRest : -999);
  if (since < LONG_REST_GAP) return sysEntry(`🌙 Too soon for another long rest (the story needs to move on first), so it gives no benefits.`);
  m.lastLongRest = gmCount();
  m.shortRestAt = null;
  const ammoBack = recoverAmmo();
  refillFeatures('long');
  const ready = [];
  for (const c of Object.values(ROSTER)) {
    c.hp = parseInt(c.maxhp) || c.hp;
    c.hitDiceUsed = Math.max(0, (parseInt(c.hitDiceUsed) || 0) - Math.max(1, Math.floor((parseInt(c.level) || 1) / 2)));
    c.slotsUsed = {}; c.pactUsed = 0;
    const need = nextLevelXp(c);
    c.levelReady = need !== null && xpOf(c) >= need;
    if (c.levelReady) ready.push(c.name);
  }
  const casters = Object.values(ROSTER).some(c => casterOf(c));
  return sysEntry(`🌙 Long rest: everyone is back to full HP and regains hit dice.${casters ? ' Spell slots are back, and casters can change their spells now (Your Sheet tab).' : ''}${ammoBack.length ? ' ' + ammoBack.join('; ') + '.' : ''}${ready.length ? ` ${ready.join(', ')} can level up now (Your Sheet tab).` : ''}`, { saveAll: true, saveMeta: true });
}
// [[short-rest]]: opens a window (until the next GM message) to spend hit dice on the Sheet tab.
function resolveShortRest() {
  const m = roomMeta();
  const since = gmCount() - (Number.isFinite(m.lastShortRest) ? m.lastShortRest : -999);
  if (since < SHORT_REST_GAP) return sysEntry(`☕ Too soon for another short rest, so it gives no benefits.`);
  m.lastShortRest = gmCount();
  m.shortRestAt = gmCount();
  const pact = Object.values(ROSTER).filter(c => { const cs = casterOf(c); return cs && cs.pact && (parseInt(c.pactUsed) || 0) > 0; });
  pact.forEach(c => { c.pactUsed = 0; });
  const refilled = refillFeatures('short');
  return sysEntry(`☕ Short rest: each hero can spend hit dice on the Your Sheet tab to heal, until the story continues.${pact.length ? ` ${pact.map(c => c.name).join(', ')} regain${pact.length > 1 ? '' : 's'} pact magic slots.` : ''}${refilled.length ? ` Back again: ${refilled.join(', ')}.` : ''}`, { saveMeta: true, saveAll: pact.length > 0 || refilled.length > 0 });
}
async function spendHitDie() {
  const c = ROSTER[MY_CHAR_ID];
  if (!c || !shortRestOpen() || hitDiceLeft(c) < 1) return;
  const die = hitDieFor(c.klass);
  const roll = dieRoll(die);
  const heal = Math.max(1, roll + abilityMod(c.con));
  c.hitDiceUsed = (parseInt(c.hitDiceUsed) || 0) + 1;
  const { before, after, max } = changeHP(c, heal);
  await persistRoster();
  const entry = sysEntry(`☕ ${c.name} spends a hit die: d${die}(${roll}) ${fmtMod(abilityMod(c.con))} = ${heal} — HP ${before} → ${after}/${max}. ${hitDiceLeft(c)} hit ${hitDiceLeft(c) === 1 ? 'die' : 'dice'} left.`);
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
}
window.spendHitDie = spendHitDie;

// Sheet tab: XP, hit dice, short-rest healing and the Level Up offer.
function progressHTML(c) {
  const need = nextLevelXp(c);
  const xp = xpOf(c);
  const pct = need === null ? 100 : Math.max(0, Math.min(100, Math.round((xp - XP_FOR_LEVEL[parseInt(c.level) || 1]) / (need - XP_FOR_LEVEL[parseInt(c.level) || 1]) * 100)));
  const die = hitDieFor(c.klass);
  const rest = shortRestOpen() && hitDiceLeft(c) > 0 && c.hp < c.maxhp
    ? `<button class="btn" onclick="spendHitDie()">Spend a hit die (d${die} ${fmtMod(abilityMod(c.con))})</button>` : '';
  return `<div class="xp-panel">
    <div class="xp-row"><span><b>XP</b> ${xp}${need !== null ? ` / ${need} for level ${(parseInt(c.level) || 1) + 1}` : ' (max level)'}</span><span><b>Hit dice</b> ${hitDiceLeft(c)}/${parseInt(c.level) || 1} (d${die})</span></div>
    <div class="xp-bar"><div style="width:${pct}%"></div></div>
    ${rest}
  </div>`;
}
function canLevelUp(c) {
  const need = nextLevelXp(c);
  return !!c.levelReady && need !== null && xpOf(c) >= need;
}
function levelUpHTML(c) {
  const need = nextLevelXp(c);
  const next = (parseInt(c.level) || 1) + 1;
  if (canLevelUp(c)) {
    return `<div class="hero-note level-up-note"><span>&#x2726; Rested and ready: <b>${escapeHtml(c.name)}</b> can reach level ${next} (+${levelUpGain(c)} max HP${profFor(next) > profFor(next - 1) ? ', +1 to skills' : ''}).</span><button class="btn solid" onclick="levelUp()">Level Up</button></div>`;
  }
  if (need !== null && xpOf(c) >= need) return `<p class="helptext">&#x2726; Enough XP for level ${next}. It unlocks at your next long rest.</p>`;
  return '';
}
async function levelUp() {
  const c = ROSTER[MY_CHAR_ID];
  if (!c || !canLevelUp(c)) return;
  const old = parseInt(c.level) || 1;
  const gain = levelUpGain(c);
  c.level = old + 1;
  c.maxhp = (parseInt(c.maxhp) || 1) + gain;
  c.hp = c.maxhp; // level-ups happen at a long rest, so the hero is at full health
  c.levelReady = false; // one level per long rest
  const bump = profFor(c.level) - profFor(old);
  if (bump) c.skills = (c.skills || []).map(s => ({ ...s, mod: (parseInt(s.mod) || 0) + bump }));
  await persistRoster();
  const entry = sysEntry(`⬆ ${c.name} reached level ${c.level}! Max HP +${gain} (now ${c.hp}/${c.maxhp})${bump ? ', skills +' + bump : ''}.`);
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
  saveHeroToMini(false);
}
window.levelUp = levelUp;


/* ---- heroes save their progress back to the mini ----
   The hero-save function checks the character really came from that mini, binds the mini to the first
   ink key that saves it, and limits each save to +1 level. Runs on its own after a level-up, when the
   session advances and when leaving the table; the Sheet tab also has a button. */
const MINI_SAVE = { busy: false, msg: '', again: false };
function miniPanelHTML(c) {
  if (!c.heroTag) return '';
  return `<div class="mini-panel">
    <p class="helptext"><b>${escapeHtml(c.name)} came from your mini.</b> Their level, max HP, gear and notes are saved back to it when you level up, advance the session or leave, so the next tap brings them back as they are now.</p>
    <button class="btn" ${MINI_SAVE.busy ? 'disabled' : ''} onclick="saveHeroToMini()">Save to my mini now</button>
    <button class="link-btn" onclick="openMyMinis()">Backups and moving: My minis</button>
    ${MINI_SAVE.msg ? `<p class="helptext mini-save-msg">${escapeHtml(MINI_SAVE.msg)}</p>` : ''}
  </div>`;
}
async function saveHeroToMini(quiet) {
  const c = ROSTER[MY_CHAR_ID];
  if (!c || !c.heroTag || !ROOM || !MY_CHAR_ID) return;
  if (MINI_SAVE.busy) { MINI_SAVE.again = true; return; } // e.g. Level Up pressed while the session-advance save runs
  // Built before the first await, so leaving the table (which clears ROOM/ROSTER) can't change it.
  const body = JSON.stringify({ tagId: c.heroTag, roomCode: ROOM, characterId: MY_CHAR_ID, playerId: playerId() });
  const showSheet = () => { if (VIEW === 'game' && ACTIVE_TAB === 'sheet') renderSheetTab(); };
  MINI_SAVE.busy = true;
  if (quiet !== true) { MINI_SAVE.msg = 'Saving to your mini...'; showSheet(); }
  try {
    const resp = await fetch(api('/api/hero-save'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 429) { MINI_SAVE.again = true; MINI_SAVE.msg = quiet === true ? MINI_SAVE.msg : 'Saving to your mini in a few seconds...'; return; }
    if (!resp.ok || data.error) throw new Error(data.error || "Your mini's record is out of reach right now. It'll save next time.");
    MINI_SAVE.msg = `Saved to your mini: level ${data.saved.level}, ${data.saved.maxhp} max HP, ${data.saved.items} item${data.saved.items === 1 ? '' : 's'}.` +
      (data.claimed ? ' This mini is now bound to your ink key.' : '');
  } catch (e) {
    console.warn('Saving to the mini failed:', e.message);
    MINI_SAVE.msg = e && e.name === 'TypeError' ? "Couldn't reach your mini's record. Check your connection; it'll save next time." : e.message;
  } finally {
    MINI_SAVE.busy = false;
    showSheet();
    // A save was asked for while this one ran (or the server said "too soon"): send the latest once more.
    if (MINI_SAVE.again) { MINI_SAVE.again = false; setTimeout(() => saveHeroToMini(quiet), 6000); }
  }
}
window.saveHeroToMini = saveHeroToMini;

window.closeTag = closeTag;
window.tagHeroJoin = tagHeroJoin;
window.tagHeroJoinCode = tagHeroJoinCode;
window.tagHeroSolo = tagHeroSolo;
window.tagMonsterCheckCode = tagMonsterCheckCode;

/* ---------------- Boot ---------------- */
if (checkConfigured()) {
  let tagParam = '';
  try { tagParam = new URLSearchParams(location.search).get('tag') || ''; } catch (e) {}
  if (TAG_ID_RE.test(tagParam)) {
    // Drop ?tag= from the address bar so a refresh doesn't re-run the tap.
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    openTag(tagParam);
  } else {
    render();
  }
  loadSiteConfig();
  refreshMyHash().then(() => initAuth()).catch(() => {});
  // In the app, "redeem" also credits any purchase whose confirmation was interrupted last time.
  refreshWallet(IS_APP ? 'redeem' : 'balance').catch(() => {});
}

})();

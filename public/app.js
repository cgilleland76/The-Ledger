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
const roomCode = () => uid(5).toUpperCase();

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
async function dbEvictOldestRoomIfAtCapacity() {
  const total = await dbCountRooms();
  if (total < MAX_TOTAL_ROOMS) return;
  const { data, error } = await supabase.from('rooms').select('code').order('created_at', { ascending: true }).limit(1);
  if (error || !data || !data.length) { console.error(error); return; }
  await supabase.from('rooms').delete().eq('code', data[0].code);
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
      if (r) { META = r.meta; if (VIEW === 'game') render(); }
    })
    .subscribe();
}

/* ---------------- Local persistence (real browser, real localStorage) ---------------- */
function rememberCharacter(code, charId) {
  try { localStorage.setItem(`ledger:${code}`, JSON.stringify({ characterId: charId })); } catch (e) {}
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
    const email = String((await resp.json()).supportEmail || '').trim();
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
      ...(isTester() ? { tester: true } : {})
    };
    ROOM = code;
    await dbEvictOldestRoomIfAtCapacity();
    await dbInsertRoom(code, MODE, META);
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
  const room = await dbGetRoom(code);
  if (!room) return "No campaign found with that code — double-check it with whoever created the room, or use the code shown when you paused.";
  ROOM = code; META = room.meta; MODE = room.mode || 'group';
  ROSTER = rosterFromRows(await dbGetCharacters(code));
  LOG = logFromRows(await dbGetLog(code));
  let mine = recallCharacter(code);
  // A solo story has exactly one character, so resuming from a new device (no saved link) picks it back up.
  if (!(mine && ROSTER[mine.characterId]) && MODE === 'solo' && Object.keys(ROSTER).length === 1) {
    mine = { characterId: Object.keys(ROSTER)[0] };
    rememberCharacter(code, mine.characterId);
  }
  pausedStory = null;
  if (mine && ROSTER[mine.characterId]) {
    MY_CHAR_ID = mine.characterId;
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
        <div class="field"><label>Race / Species ${charGenMode === 'auto' ? '(optional — leave blank to let the GM choose)' : ''}</label><input type="text" id="cRace" value="${escapeAttr(d.race)}" oninput="setDraftField('race', this.value)"></div>
        <div class="field"><label>Class ${charGenMode === 'auto' ? '(optional — leave blank to let the GM choose)' : ''}</label><input type="text" id="cClass" value="${escapeAttr(d.klass)}" oninput="setDraftField('klass', this.value)"></div>
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
${raceHint ? `The player wants a ${raceHint} character.` : 'Choose a race/species that fits the tone.'}
${classHint ? `The player wants to play a ${classHint}.` : 'Choose a class that fits the tone.'}
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
      race: parsed.race || draftChar.race,
      klass: parsed.klass || draftChar.klass,
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
      CHARGEN_ERROR = `Couldn't generate a character: ${e.message}. Try again, or switch to "I'll roll my own."`;
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
  navigator.clipboard?.writeText(ROOM);
  const b = event.target; const old = b.innerText; b.innerText = 'Copied!'; setTimeout(() => b.innerText = old, 1200);
}

// The story code is the room code: it is what lets you (or a friend) come back to the same room later.
function codeBadge() {
  return MODE === 'solo'
    ? `<span class="badge">Solo Story</span> <span class="badge">Story code <span class="room-code">${ROOM}</span></span>`
    : `<span class="badge">Room <span class="room-code">${ROOM}</span></span>`;
}
let pausedStory = null;   // { code, name, error? } shown on the landing page right after pausing
function pauseStory() {
  pausedStory = { code: ROOM, name: META.name };
  try { navigator.clipboard?.writeText(ROOM); } catch (e) {}
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
  ROOM = null; META = null; ROSTER = {}; LOG = []; MY_CHAR_ID = null; draftChar = null;
  MODE = 'group'; ACTIVE_TAB = 'story';
  VIEW = 'landing';
  render();
}

/* ---------------- GAME SCREEN ---------------- */
const lengthLabel = { oneshot: 'One-Shot', arc: 'Short Arc', long: 'Long Campaign' };

function renderGame() {
  const tabs = MODE === 'solo'
    ? [['story', 'The Ledger (Story)'], ['sheet', 'Your Sheet'], ['help', 'Field Notes']]
    : [['story', 'The Ledger (Story)'], ['party', 'The Party'], ['sheet', 'Your Sheet'], ['help', 'Field Notes']];
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
  else if (ACTIVE_TAB === 'party') renderPartyTab();
  else if (ACTIVE_TAB === 'sheet') renderSheetTab();
  else renderHelpTab();
}
function setTab(k) { ACTIVE_TAB = k; render(); }

async function advanceSession() {
  META.session = (META.session || 1) + 1;
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
  const box = el('logBox'); if (box) box.scrollTop = box.scrollHeight;
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
    ${abilityGridHTML(c)}
  </div>`;
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
      `<option value="${escapeAttr(o.key)}">${escapeHtml(o.name)} (${fmtMod(o.mod)})</option>`).join('')}</optgroup>`).join('')}
  </select>`;
}
function pickRoll(key) {
  const opt = rollOptions(ROSTER[MY_CHAR_ID]).find(o => o.key === key);
  const picker = el('rollPicker');
  if (picker) picker.value = '';
  if (!opt) return;
  composerDraft = `/roll ${fmtMod(opt.mod)} ${opt.name}`;
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
  return `<div class="entry ${cls}${voided ? ' void' : ''}"><div class="who">${dot}${escapeHtml(e.author)}</div><div class="text">${voided ? '<s class="void-text">' + body + '</s>' : body}${flag}${voided ? ' <span class="roll-void" title="Only your first roll of each kind counts">rolled in error — ignored</span>' : ''}</div></div>`;
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

  // Matches "/roll +5", "/roll 1d20+4", "/roll 2d6+3 adv", "/roll d20", "/roll 1d4", and an
  // optional label after the dice, e.g. "/roll +7 Stealth" or "/roll +7 adv Stealth".
  const rollMatch = text.match(/^\/roll(?=\s|$)\s*(?:(\d*)d(\d+))?\s*([+-]\d+)?\s*(.*)$/i);
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
      text: `rolls ${detail}${mod !== 0 ? ' ' + fmtMod(mod) : ''} = ${total}${label ? ' (' + label + ')' : ''}${flagged ? ' ' + UNLISTED_FLAG : ''}` };
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

// kind 'story' = a Game Master story turn: the server adds its GM playbook and looks up stat blocks
// for any monsters named in `lore` (the recent log text).
async function fetchGM(prompt, signal, kind, lore) {
  const resp = await fetch(api('/api/gm'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, roomCode: ROOM, kind, lore, playerId: playerId() }),
    signal,
  });
  const data = await resp.json();
  if (data.wallet) setWallet(data.wallet);
  if (data.outOfInk) {
    openShop(data.error);
    throw new Error(data.error + ' Tap the ink badge at the top of the page to get more.');
  }
  if (!resp.ok || data.error) throw new Error(data.error || `Request failed (${resp.status})`);
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
      entry = { id: uid(6), author: 'The Ledger', type: 'system', text: `The GM could not be reached: ${e.message}` };
    }
  } finally {
    GM_PENDING = false;
    GM_ABORT = null;
  }
  const { clean, attacks, heals, gives, uses } = entry.type === 'gm' ? extractFoeAttacks(entry.text) : { clean: entry.text, attacks: [], heals: [], gives: [], uses: [] };
  // A message that was nothing but directives has no story text of its own to log.
  if (clean || !(attacks.length || heals.length || gives.length || uses.length)) {
    entry.text = clean || entry.text;
    await dbInsertLog(ROOM, entry);
    LOG.push({ ...entry, ts: Date.now() });
  }
  // Damage, healing and items change the sheet itself: save every character that changed.
  for (const r of [...attacks.map(resolveFoeAttack), ...heals.map(resolveHeal), ...gives.map(resolveGive), ...uses.map(resolveUse)]) {
    const { hpChar, ...result } = r;
    await dbInsertLog(ROOM, result);
    LOG.push({ ...result, ts: Date.now() });
    if (hpChar && ROSTER[hpChar]) await dbUpsertCharacter(hpChar, ROOM, ROSTER[hpChar]);
  }
  if (VIEW === 'game') render();
}

function cancelGM() {
  if (GM_ABORT) GM_ABORT.abort();
}

/* ---------------- Foe attacks ---------------- */
// The GM can't roll dice, so it writes a directive line for each monster attack and the game rolls it:
//   [[foe-attack: Goblin B | scimitar | +4 | 1d6+2 | Telilin]]
// Only the browser that asked the GM resolves them; everyone else just sees the results in the log.
const FOE_DIRECTIVE = /\[\[\s*foe-attack:([^\]]*)\]\]/gi;
const HEAL_DIRECTIVE = /\[\[\s*heal:([^\]]*)\]\]/gi;
const GIVE_DIRECTIVE = /\[\[\s*give:([^\]]*)\]\]/gi;
const USE_DIRECTIVE = /\[\[\s*use:([^\]]*)\]\]/gi;
function extractFoeAttacks(text) {
  const attacks = [];
  const heals = [];
  const gives = [];
  const uses = [];
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
    if (p.length >= 2 && p[1] && gives.length < 4) gives.push({ target: p[0], item: p[1].slice(0, 80) });
    return '';
  }).replace(USE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 2 && p[1] && uses.length < 4) uses.push({ target: p[0], item: p[1].slice(0, 80) });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { clean, attacks, heals, gives, uses };
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
function changeHP(c, delta) {
  const before = parseInt(c.hp) || 0;
  const max = parseInt(c.maxhp) || Math.max(before, 1);
  c.hp = Math.max(0, Math.min(max, before + delta));
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
  if (hit) {
    const dmg = rollSpec(dice, crit ? 2 : 1);
    text += `: ${dmg.total} damage (${dmg.text})`;
    if (target.enemy) {
      text += ` — ${target.name}'s HP is the GM's to track`;
    } else {
      const { before, after, max } = changeHP(target, -dmg.total);
      hpChar = charIdOf(target);
      text += ` — ${target.name}: HP ${before} → ${after}/${max}${after === 0 ? ' (down!)' : ''}`;
    }
  }
  return { id: uid(6), author: a.who, type: 'roll', text, hpChar };
}
// [[heal: Telilin | 2d4+2 | potion of healing]]: rolls (or takes a flat amount) and raises HP up to max.
function resolveHeal(h) {
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text });
  const target = findTarget(h.target);
  const dice = parseDice(h.amount);
  if (!target) return fail(`${h.src}: the game couldn't tell who was healed.`);
  // Stabilising only ends death saves; it never restores HP, so a heal line worded that way is ignored.
  if (/stabili[sz]|healer|medicine|spare the dying/i.test(h.src)) return fail(`${h.src} → ${target.name}: stabilising restores no HP; ${target.name} stays at ${target.hp ?? 0} HP.`);
  if (!dice) return fail(`${h.src} heals ${target.name}, but the amount (${h.amount}) couldn't be read.`);
  const r = rollSpec(dice, 1);
  const { before, after, max } = changeHP(target, r.total);
  return { id: uid(6), author: 'The Ledger', type: 'system', hpChar: charIdOf(target),
    text: `${h.src} → ${target.name}: heals ${r.total}${dice.flat === undefined ? ' (' + r.text + ')' : ''} — HP ${before} → ${after}/${max}` };
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
// [[give: Brannoc | Potion of Healing]]: the story hands a character an item.
function resolveGive(g) {
  const target = findTarget(g.target);
  if (!target) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${g.item}: the game couldn't tell who received it.` };
  target.inventory = (target.inventory || []).filter(i => String(i).trim());
  if (target.inventory.length >= 40) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${target.name}'s pack is full, so ${g.item} wasn't added.` };
  target.inventory.push(g.item);
  return { id: uid(6), author: 'The Ledger', type: 'system', hpChar: charIdOf(target), text: `🎁 ${target.name} gains ${g.item}.` };
}
// [[use: Brannoc | Potion of Healing]]: a consumable is used up. "Potion (3)" becomes "Potion (2)".
function resolveUse(u) {
  const target = findTarget(u.target);
  if (!target) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${u.item}: the game couldn't tell who used it.` };
  const inv = target.inventory || [];
  const want = itemBase(u.item);
  const flags = handFlags(target);
  const order = [...inv.keys()].sort((a, b) => flags[a] - flags[b]); // earned items first
  const idx = order.find(i => itemBase(inv[i]) === want) ?? order.find(i => { const b = itemBase(inv[i]); return want && (b.includes(want) || want.includes(b)); });
  if (idx === undefined) return { id: uid(6), author: 'The Ledger', type: 'system', text: `${target.name} has no ${u.item} to use.` };
  const old = inv[idx];
  const q = QTY_RE.exec(old);
  const n = q ? parseInt(q[1]) : 1;
  const base = String(old).replace(QTY_RE, '').trim();
  const wasHand = flags[idx];
  if (n > 1) {
    const next = n - 1 > 1 ? `${base} (${n - 1})` : base;
    inv[idx] = next;
    if (wasHand) { dropHandItem(target, old); target.handItems.push(next); }
  } else {
    inv.splice(idx, 1);
    if (wasHand) dropHandItem(target, old);
  }
  return { id: uid(6), author: 'The Ledger', type: 'system', hpChar: charIdOf(target),
    text: `${target.name} uses ${base}${n > 1 ? ` (${n - 1} left)` : ''}.` };
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
  const party = Object.values(ROSTER).map(c => `${c.name} — Lv${c.level} ${c.race} ${c.klass}, HP ${c.hp}/${c.maxhp} (current, from the sheet), AC ${c.ac}, inventory: ${earnedItems(c).join(', ') || 'none'}${handItems(c).length ? `; written in by the player, never given in the story (NOT owned): ${handItems(c).join(', ')}` : ''}
  Sheet modifiers (the only d20 bonuses this character has): ${rollOptions(c).map(o => `${o.name} ${fmtMod(o.mod)}`).join(', ')}`).join('\n');
  const prompt = `You are the Game Master for a tabletop RPG ${MODE === 'solo' ? 'solo story' : 'session'} titled "${META.name}".
Ruleset: ${META.ruleset}. Tone/genre: ${META.tone || 'unspecified — infer something fitting'}. Length: ${lengthLabel[META.length]}.
${META.seed ? 'Opening premise the GM previously established: ' + META.seed : ''}
${MODE === 'solo' ? 'Character' : 'Party'}:
${party}

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
- Players never roll for monsters. For each attack a foe makes, write it in the fiction and put this directive on its own line: [[foe-attack: Goblin B | scimitar | +4 | 1d6+2 | Telilin]] (attacker | attack name | to-hit bonus from its stat block | damage dice | the target's exact character name). When an ally NPC attacks an enemy, add the enemy's AC as a sixth field, e.g. [[foe-attack: Scout | longbow | +4 | 1d8+2 | Goblin A | AC 15]]; the result tells you what happened and you track the enemy's HP. The game rolls the attack against the target's AC and the damage if it hits, and posts the result to the log; use one directive per attack (max 4). Then stop: don't say whether it hit and don't state the AC. Narrate the outcome next turn, once the result is in the log. The game subtracts the damage from the target's HP itself, so never ask players to take it off their HP. For any healing (a potion, a spell, a rest) put [[heal: Telilin | 2d4+2 | potion of healing]] on its own line (the character's exact name | dice or a flat number | source); the game rolls it and raises their HP up to their maximum. One per healing, max 4. Never use [[heal]] to stabilise a dying character: stabilising (a healer's kit, a Medicine check, spare the dying) restores no HP, it only ends their death saves, so ask the player for a Medicine check (DC 10, or a healer's kit with no roll) and narrate them stable at 0 HP. When a player's own character is doing the healing (their spell or potion), ask that player to /roll it; once that roll is in the log, put [[heal: <their name> | <that roll's total> | <source>]] with the total as a plain number, and the game adds it. Never state anyone's new HP total yourself (the game posts it), and never work HP out from older log lines: a character's current HP is only the "HP x/y (current, from the sheet)" in the party list above.
- Items: each character's inventory above is what they really carry. Items "written in by the player" were typed in by the player and never given in the story: they are NOT owned. If a player tries to use one, it isn't in their pack, and say so plainly. When the story gives a character an item (found, bought, looted, handed over), put [[give: <their name> | <item>]] on its own line and the game adds it. When a character uses up a consumable (drinks a potion, reads a scroll, spends a charge item), put [[use: <their name> | <item>]] on its own line and the game removes one. Max 4 of each per message.
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
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    const path = `${room}/${charId}-upload-${Date.now()}.${ext}`;
    const up = await supabase.storage.from('portraits').upload(path, blob, { contentType: blob.type, upsert: false });
    if (up.error) throw new Error(up.error.message || 'the picture could not be stored');
    const url = PORTRAIT_URL_PREFIX + path;
    const at = new Date().toISOString();
    const { error } = await supabase.from('characters')
      .update({ portrait_url: url, portrait_status: 'ready', portrait_updated_at: at })
      .eq('id', charId).eq('room_code', room);
    if (error) throw new Error(error.message || 'the character could not be updated');
    const c = ROSTER[charId];
    if (c) { c.portrait = url; c.portraitStatus = 'ready'; c.portraitAt = at; }
    portraitPendingSince = 0;
  } catch (e) {
    console.error(e);
    PORTRAIT_UPLOAD.error = 'Upload failed: ' + (e.message || e) + '. Try again.';
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
    const body = JSON.stringify({ roomCode: ROOM, characterId: MY_CHAR_ID, playerId: playerId() });
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
        <div class="sheet-stat"><div class="label">HP</div><div class="val">${c.hp} / ${c.maxhp}</div></div>
        <div class="sheet-stat"><div class="label">AC</div><div class="val">${c.ac}</div></div>
        <div class="sheet-stat"><div class="label">Level</div><div class="val">${c.level}</div></div>
      </div>
      ${levelUpHTML(c)}
      ${miniPanelHTML(c)}
      ${abilityGridHTML(c)}
      <div class="mini-btns" style="max-width:260px;margin-bottom:20px;">
        <button class="mini-btn" onclick="hpDelta(-1)">HP -1</button>
        <button class="mini-btn" onclick="hpDelta(-5)">HP -5</button>
        <button class="mini-btn" onclick="hpDelta(5)">HP +5</button>
        <button class="mini-btn" onclick="hpDelta(1)">HP +1</button>
      </div>

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
async function hpDelta(n) {
  const c = ROSTER[MY_CHAR_ID]; c.hp = Math.max(0, Math.min(c.maxhp, c.hp + n));
  await persistRoster();
  const entry = { id: uid(6), author: 'The Ledger', type: 'system', text: `${c.name}'s HP is now ${c.hp}/${c.maxhp}.` };
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
}
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
      <h2>Field Notes</h2>
      <ul>
        ${MODE === 'group' ? `<li>Everyone in this room shares the same <b>Ledger</b> (story log) and <b>Party</b> roster — anyone can open the room code on their own device.</li>` : `<li>This is your own solo story — only your character and the GM are here.</li>`}
        <li>Type plain text and hit Send to describe what your character says or does. It's narrated ${MODE === 'group' ? 'to the whole table' : 'into the story'}.</li>
        <li>Playing solo? <b>Pause Story</b> saves your place under your <b>story code</b>. Later, choose <b>Join or Resume with Code</b> and enter it, on any device, to carry on where you left off.</li>
        <li>In the GM's newest message, click the emoji beside an option to choose it, and click a <b>🎲 /roll</b> button to make that roll. Each can be used once.</li>
        <li>The <b>Roll from sheet</b> menu next to the message box lists your ability checks, skills, weapon attacks, and initiative — pick one and it fills in the right modifier and label for you. If a d20 roll uses a bonus higher than your sheet allows, the log tags it <b>⚠ unlisted modifier</b> so the table can see it (legit situational bonuses like Bless will trigger it too — just a heads-up, nothing is blocked).</li>
        <li>In a fight, the game rolls monster attacks and damage for you and posts the result in the log (damage comes off your HP automatically, and so does healing the GM grants). The GM keeps a <b>Foes</b> line with each monster's hit points at the end of its messages.</li>
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
window.hpDelta = hpDelta;
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
    SHOP_STATUS = 'Could not reach Google Play: ' + (e.message || e);
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
      added = (await refreshWallet('redeem')).added || 0;
    }
    SHOP_STATUS = added ? `Added ${added} ink. Thank you!` : 'Your purchase went through. The ink will appear within a few minutes (reopen the app if it doesn\'t).';
    SHOP_REASON = '';
  } catch (e) {
    // Raw native errors (no RevenueCat JS wrapper here): code "1" is PURCHASE_CANCELLED.
    const d = (e && e.data) || {};
    const cancelled = e && (e.userCancelled || d.userCancelled || String(e.code) === '1' || String(d.code) === '1' || /cancel/i.test(String(e.message || '')));
    SHOP_STATUS = cancelled ? 'Purchase cancelled.' : 'The purchase didn\'t go through: ' + (e.message || e);
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
  if (!confirm('Switch this device to that ink key? Ink on the current key stays with the current key, so copy it first if it has ink left.')) return;
  try { localStorage.setItem(PLAYER_KEY, key); } catch (e) { memoryPlayerId = key; }
  if (IS_APP && purchasesReady) {
    try { const P = await purchasesReady; await P.logIn({ appUserID: key }); } catch (e) { purchasesReady = null; }
  }
  SHOP_STATUS = 'This device now uses that ink key.';
  try { await refreshWallet(IS_APP ? 'redeem' : 'balance'); } catch (e) { SHOP_STATUS = e.message; }
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
  const { data, error } = await supabase.from('tags').select('id, kind, data').eq('id', id).maybeSingle();
  if (error) { console.error(error); TAG_STATE = 'error'; }
  else if (!data || !['hero', 'monster', 'item'].includes(data.kind)) TAG_STATE = 'missing';
  else { TAG = data; TAG_STATE = ''; }
  const code = recallCurrentRoom();
  if (TAG && code) {
    const room = await dbGetRoom(code);
    if (room) TAG_ROOM = { code, name: (room.meta && room.meta.name) || code };
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
  else if (TAG.kind === 'hero') { eyebrow = 'A Hero Answers'; body = tagHeroHTML(); }
  else if (TAG.kind === 'item') { eyebrow = 'Loot Found'; body = tagItemHTML(); }
  else { eyebrow = 'A Foe Appears'; body = tagMonsterHTML(); }
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

/* ---- monster minis ---- */
function tagMonsterHTML() {
  const m = TAG.data || {};
  return `
    <h2>${escapeHtml(m.name || 'Unknown creature')}</h2>
    ${m.cr ? `<p class="helptext">Challenge rating ${escapeHtml(String(m.cr))}</p>` : ''}
    <p class="helptext">Summoning puts it into the scene. Everyone at the table sees it in the story log, and the Game Master gets its full stat block on the next turn.</p>
    ${TAG_ROOM ? `<button class="btn solid wide" ${TAG_BUSY ? 'disabled' : ''} onclick="tagSummon('${escapeAttr(TAG_ROOM.code)}')">Summon into ${escapeHtml(TAG_ROOM.name)}</button>` : ''}
    ${tagCodeRow(TAG_ROOM ? 'Or summon into another table' : 'Which table? Enter its room code', 'tagSummonCode()')}`;
}
async function tagSummon(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code || TAG_BUSY || !TAG) return;
  TAG_BUSY = true; TAG_MSG = ''; render();
  try {
    const room = await dbGetRoom(code);
    if (!room) { TAG_MSG = 'No campaign found with that code.'; return; }
    const name = String((TAG.data && TAG.data.name) || 'creature').slice(0, 60);
    const article = /^[aeiou]/i.test(name) ? 'An' : 'A';
    await dbInsertLog(code, { id: uid(6), author: 'The Ledger', type: 'system', text: `⚔ ${article} ${name} enters the scene! (summoned by a mini)` });
    // If this device has a character at that table, go straight to the game to watch it arrive.
    if (recallCharacter(code)) {
      const err = await enterRoom(code);
      if (!err && VIEW === 'game') { TAG = null; return; }
      VIEW = 'tag';
    }
    TAG_ROOM = { code, name: (room.meta && room.meta.name) || code };
    TAG_MSG = `${article} ${name} has entered ${TAG_ROOM.name}. Ask the GM to continue the story and it will join the scene.`;
  } finally {
    TAG_BUSY = false;
    if (VIEW === 'tag') render();
  }
}
function tagSummonCode() { tagSummon(tagCodeInput()); }

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
function canLevelUp(c) {
  return (parseInt(c.level) || 1) < 20 && ((META && META.session) || 1) > (parseInt(c.levelSession) || 1);
}
function levelUpHTML(c) {
  if (!canLevelUp(c)) return '';
  const next = (parseInt(c.level) || 1) + 1;
  return `<div class="hero-note level-up-note"><span>&#x2726; A new session has begun. <b>${escapeHtml(c.name)}</b> can reach level ${next} (+${levelUpGain(c)} max HP${profFor(next) > profFor(next - 1) ? ', +1 to skills' : ''}).</span><button class="btn solid" onclick="levelUp()">Level Up</button></div>`;
}
async function levelUp() {
  const c = ROSTER[MY_CHAR_ID];
  if (!c || !canLevelUp(c)) return;
  const old = parseInt(c.level) || 1;
  const gain = levelUpGain(c);
  const hpBefore = parseInt(c.hp) || 0;
  c.level = old + 1;
  c.maxhp = (parseInt(c.maxhp) || 1) + gain;
  c.hp = Math.min(c.maxhp, (parseInt(c.hp) || 0) + gain);
  c.levelSession = (META && META.session) || 1;
  const bump = profFor(c.level) - profFor(old);
  if (bump) c.skills = (c.skills || []).map(s => ({ ...s, mod: (parseInt(s.mod) || 0) + bump }));
  await persistRoster();
  const entry = { id: uid(6), author: 'The Ledger', type: 'system', text: `⬆ ${c.name} reached level ${c.level}! Max HP +${gain}${bump ? ', skills +' + bump : ''} — HP ${hpBefore} → ${c.hp}/${c.maxhp}.` };
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
    if (!resp.ok || data.error) throw new Error(data.error || `Request failed (${resp.status})`);
    MINI_SAVE.msg = `Saved to your mini: level ${data.saved.level}, ${data.saved.maxhp} max HP, ${data.saved.items} item${data.saved.items === 1 ? '' : 's'}.` +
      (data.claimed ? ' This mini is now bound to your ink key.' : '');
  } catch (e) {
    console.warn('Saving to the mini failed:', e.message);
    MINI_SAVE.msg = e.message;
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
window.tagSummon = tagSummon;
window.tagSummonCode = tagSummonCode;

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
  // In the app, "redeem" also credits any purchase whose confirmation was interrupted last time.
  refreshWallet(IS_APP ? 'redeem' : 'balance').catch(() => {});
}

})();

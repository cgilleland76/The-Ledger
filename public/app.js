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
}

/* ---------------- Feedback / contact / support ---------------- */
let CONTACT_EMAIL = (cfg.CONTACT_EMAIL || '').trim(); // config.js value is the fallback; the SUPPORT_EMAIL Netlify variable wins (see loadSiteConfig)
const SUPPORT_URL = (cfg.SUPPORT_URL || '').trim();
const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The support email lives in a Netlify environment variable; ask the site-config function for it.
// Any failure (offline, local file preview) just keeps the config.js address.
async function loadSiteConfig() {
  try {
    const resp = await fetch('/api/site-config');
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
          <p>Already have a room code from a friend? Join their table and build your character.</p>
          <button class="btn wide" onclick="goToJoin()">Join with Code</button>
        </div>
      </div>
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
function startNewCampaign(mode) { MODE = mode; VIEW = 'create'; render(); }
function goToJoin() { VIEW = 'join'; render(); }
function goToLanding() { VIEW = 'landing'; render(); }

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
      openingGenerated: false
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
      <div class="eyebrow">Join Campaign</div>
      <h2>Enter the Hollow</h2>
      <div class="field">
        <label>Room Code</label>
        <input type="text" id="joinCode" placeholder="e.g. F3K9M" style="text-transform:uppercase;letter-spacing:0.1em;">
      </div>
      <div id="joinErr" class="error-text"></div>
      <button class="btn solid wide" onclick="submitJoin()">Continue</button>
    </div>
  `;
}
async function submitJoin() {
  const code = el('joinCode').value.trim().toUpperCase();
  if (!code) return;
  const room = await dbGetRoom(code);
  if (!room) { el('joinErr').innerText = "No campaign found with that code — double-check it with whoever created the room."; return; }
  ROOM = code; META = room.meta; MODE = room.mode || 'group';
  ROSTER = rosterFromRows(await dbGetCharacters(code));
  LOG = logFromRows(await dbGetLog(code));
  const mine = recallCharacter(code);
  if (mine && ROSTER[mine.characterId]) {
    MY_CHAR_ID = mine.characterId;
    VIEW = 'game'; subscribeRealtime(code); render();
  } else {
    VIEW = 'charsetup'; render();
  }
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
  el('app').innerHTML = `
    <div class="top-nav">
      <span class="badge">${MODE === 'solo' ? 'Solo Story' : 'Room <span class="room-code">' + ROOM + '</span>'}</span>
      <div style="display:flex;gap:14px;align-items:center;">
        ${MODE === 'group' ? `<button class="link-btn" onclick="copyCode()">Copy invite code</button>` : ''}
        <button class="link-btn" onclick="leaveTable()">Leave</button>
      </div>
    </div>
    <div class="panel" style="max-width:680px;margin:0 auto;">
      <div class="eyebrow">Build Your Character</div>
      <h2>${escapeHtml(META.name)}</h2>
      <p class="helptext">${META.ruleset === 'loose' ? 'Loose narrative mode — modifiers are approximate, the GM will use judgment.' : 'Enter your skill modifiers as already-calculated numbers. <code style="color:var(--glow)">/roll +5</code> rolls a d20+5; <code style="color:var(--glow)">/roll 2d6+3</code> rolls any other dice, like damage.'}</p>

      <div class="field"><label>Your Name (player)</label><input type="text" id="pName" value="${escapeAttr(d.player)}" oninput="setDraftField('player', this.value)"></div>
      <div class="field"><label>Character Name</label><input type="text" id="cCharName" value="${escapeAttr(d.name)}" oninput="setDraftField('name', this.value)"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div class="field"><label>Gender (optional)</label><input type="text" id="cGender" maxlength="30" placeholder="e.g. female, male, nonbinary" value="${escapeAttr(d.gender || '')}" oninput="setDraftField('gender', this.value)"></div>
        <div class="field"><label>Age (optional)</label><input type="text" id="cAge" maxlength="20" placeholder="e.g. 34, or ancient" value="${escapeAttr(d.age || '')}" oninput="setDraftField('age', this.value)"></div>
      </div>
      <div class="field"><label>Appearance (optional — used to paint your portrait)</label><textarea id="cAppearance" maxlength="500" placeholder="e.g. Tall and wiry, silver hair, a scar over one eye, patched green cloak" oninput="setDraftField('appearance', this.value)">${escapeAttr(d.appearance || '')}</textarea></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
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

    const charId = uid(10);
    await dbUpsertCharacter(charId, ROOM, draftChar);
    ROSTER[charId] = draftChar;
    rememberCharacter(ROOM, charId);
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

function leaveTable() {
  closeDiceRoll();
  stopPortraitPoll(); portraitPendingSince = 0; appearanceDraft = null; genderDraft = null; ageDraft = null;
  if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  if (GM_ABORT) GM_ABORT.abort();
  if (CHARGEN_ABORT) CHARGEN_ABORT.abort();
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
        ${MODE === 'group' ? `<span class="badge">Room <span class="room-code">${ROOM}</span></span>` : `<span class="badge">Solo Story</span>`}
        <span class="badge">${lengthLabel[META.length]}</span>
        <span class="badge">Session ${META.session}</span>
      </div>
      <div style="display:flex;gap:8px;">
        ${MODE === 'group' ? `<button class="btn" onclick="copyCode()">Copy Invite Code</button>` : ''}
        <button class="btn rust" onclick="advanceSession()">Advance Session</button>
        <button class="btn" onclick="leaveTable()">Leave Table</button>
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
function mdInline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^*\w])\*(?!\s)([^*\n]*[^*\s])\*(?![*\w])/g, '$1<em>$2</em>')
       .replace(/(^|[\s(])_(?!\s)([^_\n]*[^_\s])_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}
function renderMarkdown(text) {
  const lines = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('\n');
  const out = [];
  let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(para.join('<br>'))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${mdInline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${mdInline(quote.join('<br>'))}</blockquote>`); quote = []; } };
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
  const body = e.type === 'gm' ? `<div class="md">${renderMarkdown(e.text)}</div>`
    : escapeHtml(flagged ? e.text.replace(UNLISTED_FLAG, '').trim() : e.text);
  const flag = flagged ? ` <span class="roll-flag" title="This bonus isn't on that character's sheet">${UNLISTED_FLAG}</span>` : '';
  return `<div class="entry ${cls}"><div class="who">${dot}${escapeHtml(e.author)}</div><div class="text">${body}${flag}</div></div>`;
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

async function submitAction() {
  const input = el('composerInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  composerDraft = '';
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

// kind 'story' = a Game Master story turn: the server adds its GM playbook and looks up stat blocks
// for any monsters named in `lore` (the recent log text).
async function fetchGM(prompt, signal, kind, lore) {
  const resp = await fetch('/api/gm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, roomCode: ROOM, kind, lore }),
    signal,
  });
  const data = await resp.json();
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
  const { clean, attacks } = entry.type === 'gm' ? extractFoeAttacks(entry.text) : { clean: entry.text, attacks: [] };
  // A message that was nothing but attack directives has no story text of its own to log.
  if (clean || !attacks.length) {
    entry.text = clean || entry.text;
    await dbInsertLog(ROOM, entry);
    LOG.push({ ...entry, ts: Date.now() });
  }
  for (const a of attacks) {
    const result = resolveFoeAttack(a);
    await dbInsertLog(ROOM, result);
    LOG.push({ ...result, ts: Date.now() });
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
function extractFoeAttacks(text) {
  const attacks = [];
  const clean = String(text).replace(FOE_DIRECTIVE, (_, body) => {
    const p = body.split('|').map(s => s.trim());
    if (p.length >= 5 && attacks.length < 4) attacks.push({ who: p[0].slice(0, 40), atk: p[1].slice(0, 40), bonus: p[2], dmg: p[3], target: p[4] });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { clean, attacks };
}
function findTarget(name) {
  const chars = Object.values(ROSTER);
  const n = String(name || '').trim().toLowerCase();
  return chars.find(c => c.name.toLowerCase() === n)
    || chars.find(c => n && (c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase())))
    || (chars.length === 1 ? chars[0] : null);
}
const dieRoll = sides => Math.floor(Math.random() * sides) + 1;
function resolveFoeAttack(a) {
  const target = findTarget(a.target);
  const bonus = Math.max(-10, Math.min(30, parseInt(String(a.bonus).replace(/\s/g, '')) || 0));
  const dm = String(a.dmg).replace(/\s/g, '').match(/^(\d*)d(\d+)([+-]\d+)?$/i);
  const fail = text => ({ id: uid(6), author: 'The Ledger', type: 'system', text });
  if (!target) return fail(`${a.who} attacks, but the game couldn't tell who it was aimed at.`);
  if (!dm) return fail(`${a.who} attacks ${target.name}, but its damage dice (${a.dmg}) couldn't be read.`);
  const count = Math.min(Math.max(parseInt(dm[1] || '1'), 1), 20);
  const sides = Math.min(Math.max(parseInt(dm[2]), 2), 20);
  const dmgMod = dm[3] ? parseInt(dm[3]) : 0;
  const natural = dieRoll(20);
  const total = natural + bonus;
  const crit = natural === 20;
  const hit = crit || (natural !== 1 && total >= (parseInt(target.ac) || 10));
  let text = `${a.atk ? a.atk + ' → ' : ''}${target.name}: d20(${natural}) ${fmtMod(bonus)} = ${total} vs AC ${target.ac} — ${crit ? 'CRITICAL HIT' : hit ? 'HIT' : 'miss'}`;
  if (hit) {
    const rolls = Array.from({ length: count * (crit ? 2 : 1) }, () => dieRoll(sides));
    const dmgTotal = Math.max(0, rolls.reduce((x, y) => x + y, 0) + dmgMod);
    text += `: ${dmgTotal} damage (${rolls.length}d${sides}(${rolls.join('+')})${dmgMod ? fmtMod(dmgMod) : ''}) — ${target.name}, take it off your HP`;
  }
  return { id: uid(6), author: a.who, type: 'roll', text };
}

async function askGM() {
  if (GM_PENDING) return;
  const recent = LOG.slice(-30).map(e => `${e.author} (${e.type}): ${e.text}`).join('\n');
  const party = Object.values(ROSTER).map(c => `${c.name} — Lv${c.level} ${c.race} ${c.klass}, HP ${c.hp}/${c.maxhp}, AC ${c.ac}, inventory: ${(c.inventory || []).join(', ') || 'none'}
  Sheet modifiers (the only d20 bonuses this character has): ${rollOptions(c).map(o => `${o.name} ${fmtMod(o.mod)}`).join(', ')}`).join('\n');
  const prompt = `You are the Game Master for a tabletop RPG ${MODE === 'solo' ? 'solo story' : 'session'} titled "${META.name}".
Ruleset: ${META.ruleset}. Tone/genre: ${META.tone || 'unspecified — infer something fitting'}. Length: ${lengthLabel[META.length]}.
${META.seed ? 'Opening premise the GM previously established: ' + META.seed : ''}
${MODE === 'solo' ? 'Character' : 'Party'}:
${party}

Recent table log:
${recent}

Continue the story in 2-4 short paragraphs, stay consistent with everything established, and end by presenting clear options or an open question. Keep it vivid but concise.

Roll resolution rules — follow these exactly:
- Never narrate the outcome of an attack, save, skill check, or damage until the specific roll for it already appears in the recent table log above. If a needed roll isn't in the log yet, stop and ask for it instead of describing what happens.
- Resolve one roll at a time. Ask for an attack or check roll first; only after its result appears in the log do you ask for a damage roll (only if the attack hit); only after the damage roll appears do you narrate the consequence (injury, death, effect). Never narrate a hit, miss, or damage result speculatively ahead of the actual roll.
- If a turn involves multiple attacks or rolls, resolve each one completely — roll, then damage if applicable, then narration — before moving to the next.
- Always phrase a requested roll using the exact command the player should type, formatted as inline code, e.g. "/roll +5 Attack (DEX)" for an attack, "/roll 2d6+3" for damage, "/roll +5 adv Attack (DEX)" for advantage. Never say "roll a d20" or similar without giving the exact /roll command.
- For any d20 check or save, the bonus in your /roll command must be one of that character's Sheet modifiers listed above, and the command should name it, e.g. "/roll +3 Dexterity" or "/roll +7 Stealth". Never add a proficiency bonus, expertise, or any other bonus that isn't on the sheet. If the right skill or tool isn't listed, use the matching ability's modifier as-is (and say that's what you're using). Weapon attack rolls use the listed "Attack (STR)" or "Attack (DEX)" modifier, e.g. "/roll +5 Attack (DEX)". Damage rolls use dice notation for the weapon or spell, e.g. "/roll 1d8+3".
- Players never roll for monsters. For each attack a foe makes, write it in the fiction and put this directive on its own line: [[foe-attack: Goblin B | scimitar | +4 | 1d6+2 | Telilin]] (attacker | attack name | to-hit bonus from its stat block | damage dice | the target's exact character name). The game rolls the attack against the target's AC and the damage if it hits, and posts the result to the log; use one directive per attack (max 4). Then stop: don't say whether it hit and don't state the AC. Narrate the outcome next turn, once the result is in the log.
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
    : `<button class="btn" onclick="generatePortrait()">${img ? 'Regenerate portrait' : 'Generate portrait'}</button>${state === 'error' ? `<div class="error-text" style="margin-top:8px;">${escapeHtml(portraitErrorText(c))}</div>` : ''}`;
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
    const resp = await fetch('/.netlify/functions/portrait-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomCode: ROOM, characterId: MY_CHAR_ID }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    startPortraitPoll();
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
      ${(c.inventory || []).map((it, i) => `<div class="item-row"><span>${escapeHtml(it)}</span><button class="small-x" onclick="removeItem(${i})">&times;</button></div>`).join('') || '<p class="helptext">Empty-handed.</p>'}
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
  newItemDraft = '';
  await persistRoster(); render();
}
async function removeItem(i) {
  ROSTER[MY_CHAR_ID].inventory.splice(i, 1);
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
        <li>The <b>Roll from sheet</b> menu next to the message box lists your ability checks, skills, weapon attacks, and initiative — pick one and it fills in the right modifier and label for you. If a d20 roll uses a bonus higher than your sheet allows, the log tags it <b>⚠ unlisted modifier</b> so the table can see it (legit situational bonuses like Bless will trigger it too — just a heads-up, nothing is blocked).</li>
        <li>In a fight, the game rolls monster attacks and damage for you and posts the result in the log (adjust your HP when you're hit). The GM keeps a <b>Foes</b> line with each monster's hit points at the end of its messages.</li>
        <li><label style="cursor:pointer;"><input type="checkbox" ${diceAnimOn() ? 'checked' : ''} onchange="setDiceAnim(this.checked)"> Show the dice-rolling popup when you roll (click it to dismiss early)</label></li>
        <li>Dice are <b>only</b> rolled when you type <code>/roll</code>. For a plain d20 check, just add the number, e.g. <code>/roll +5</code>. For any other dice — damage, healing, anything the GM asks for — use full notation like <code>/roll 2d6+3</code> or <code>/roll 1d4</code>.</li>
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

/* ---------------- Boot ---------------- */
if (checkConfigured()) { render(); loadSiteConfig(); }

})();

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
let CHARGEN_PENDING = false;
let CHARGEN_ABORT = null;
let CHARGEN_ERROR = '';

const el = id => document.getElementById(id);
const uid = (n = 8) => Array.from({ length: n }, () => "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 32)]).join('');
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
async function dbUpsertCharacter(id, roomCode, data) {
  const { error } = await supabase.from('characters').upsert({ id, room_code: roomCode, data });
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
  rows.forEach(r => { out[r.id] = r.data; });
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
  if (VIEW === 'landing') return renderLanding();
  if (VIEW === 'modepick') return renderModePick();
  if (VIEW === 'create') return renderCreate();
  if (VIEW === 'join') return renderJoin();
  if (VIEW === 'charsetup') return renderCharSetup();
  if (VIEW === 'game') return renderGame();
}

/* ---------------- LANDING ---------------- */
function renderLanding() {
  el('app').innerHTML = `
    <div class="landing">
      <svg class="lantern" viewBox="0 0 64 64" fill="none">
        <ellipse cx="32" cy="46" rx="14" ry="6" fill="#7fd9c4" opacity="0.15"/>
        <path d="M20 20 L44 20 L40 44 L24 44 Z" stroke="#7fd9c4" stroke-width="2" fill="rgba(127,217,196,0.12)"/>
        <circle cx="32" cy="30" r="6" fill="#7fd9c4"/>
        <line x1="32" y1="8" x2="32" y2="20" stroke="#7fd9c4" stroke-width="2"/>
        <line x1="24" y1="44" x2="20" y2="54" stroke="#7fd9c4" stroke-width="2"/>
        <line x1="40" y1="44" x2="44" y2="54" stroke="#7fd9c4" stroke-width="2"/>
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
    </div>
  `;
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
        <input type="text" id="cname" placeholder="e.g. The Last Tide, Ashwood Reach, Nine of Cups..." value="${createDraft.name}">
      </div>

      <div class="field">
        <label>Length</label>
        <div class="radio-grid" id="lengthGrid">
          ${lengths.map(l => `<div class="radio-card ${createDraft.length === l.k ? 'active' : ''}" onclick="setLen('${l.k}')"><b>${l.t}</b><span>${l.d}</span></div>`).join('')}
        </div>
      </div>

      <div class="field">
        <label>Ruleset</label>
        <select id="ruleset">
          <option value="5e2014" ${createDraft.ruleset === '5e2014' ? 'selected' : ''}>5e (2014 rules, SRD 5.1)</option>
          <option value="5e2024" ${createDraft.ruleset === '5e2024' ? 'selected' : ''}>5e (2024 rules, SRD 5.2)</option>
          <option value="loose" ${createDraft.ruleset === 'loose' ? 'selected' : ''}>Loose narrative (light rules, GM's judgment)</option>
        </select>
      </div>

      <div class="field">
        <label>Genre / Tone</label>
        <input type="text" id="tone" placeholder="e.g. dark survival horror, swashbuckling heist, cozy village mystery..." value="${createDraft.tone}">
      </div>

      <div class="field">
        <label>Opening Story Seed</label>
        <div class="radio-grid" style="margin-bottom:10px;">
          <div class="radio-card ${createDraft.seedMode === 'blank' ? 'active' : ''}" onclick="setSeedMode('blank')"><b>Let the GM invent it</b><span>Fresh hook from your genre/tone</span></div>
          <div class="radio-card ${createDraft.seedMode === 'custom' ? 'active' : ''}" onclick="setSeedMode('custom')"><b>I'll write it</b><span>Bring your own premise</span></div>
        </div>
        ${createDraft.seedMode === 'custom' ? `<textarea id="seed" placeholder="Describe the opening situation, setting, and hook...">${createDraft.seed}</textarea>` : `<p class="helptext">Leave this — once you continue, the GM will generate an opening scene from the genre and tone above.</p>`}
      </div>

      <button class="btn solid wide" onclick="submitCreate()">${MODE === 'solo' ? 'Create My Story' : 'Create Room'}</button>
    </div>
  `;
}
function setLen(k) { createDraft.length = k; renderCreate(); }
function setSeedMode(m) { createDraft.seedMode = m; renderCreate(); }

async function submitCreate() {
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
    skills: [{ name: '', mod: 0 }], inventory: [''], spells: [], notes: ''
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
      <h2>${META.name}</h2>
      <p class="helptext">${META.ruleset === 'loose' ? 'Loose narrative mode — modifiers are approximate, the GM will use judgment.' : 'Enter your skill modifiers as already-calculated numbers. When you type <code style="color:var(--glow)">/roll</code> later, only the d20 gets rolled — your modifier is added automatically.'}</p>

      <div class="field"><label>Your Name (player)</label><input type="text" id="pName" value="${d.player}"></div>
      <div class="field"><label>Character Name</label><input type="text" id="cCharName" value="${d.name}"></div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
        <div class="field"><label>Race / Species ${charGenMode === 'auto' ? '(optional — leave blank to let the GM choose)' : ''}</label><input type="text" id="cRace" value="${d.race}"></div>
        <div class="field"><label>Class ${charGenMode === 'auto' ? '(optional — leave blank to let the GM choose)' : ''}</label><input type="text" id="cClass" value="${d.klass}"></div>
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
        <div class="field"><label>Level</label><input type="text" id="cLevel" value="${d.level}"></div>
        <div class="field"><label>Max HP</label><input type="text" id="cMaxHP" value="${d.maxhp}"></div>
        <div class="field"><label>AC</label><input type="text" id="cAC" value="${d.ac}"></div>
      </div>

      <div class="field">
        <label>Ability Scores</label>
        <div class="ability-grid">
          <div><label>STR</label><input type="text" id="cSTR" value="${d.str}"></div>
          <div><label>DEX</label><input type="text" id="cDEX" value="${d.dex}"></div>
          <div><label>CON</label><input type="text" id="cCON" value="${d.con}"></div>
          <div><label>INT</label><input type="text" id="cINT" value="${d.int}"></div>
          <div><label>WIS</label><input type="text" id="cWIS" value="${d.wis}"></div>
          <div><label>CHA</label><input type="text" id="cCHA" value="${d.cha}"></div>
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

      <div class="field"><label>Notes / Backstory (optional)</label><textarea id="cNotes">${d.notes}</textarea></div>

      <div id="charErr" class="error-text"></div>
      <button class="btn solid wide" onclick="submitCharacter()">${MODE === 'solo' ? 'Begin' : 'Join the Table'}</button>
    </div>
  `;
  renderSkillRows(); renderInvRows();
}
function renderSkillRows() {
  el('skillRows').innerHTML = draftChar.skills.map((s, i) => `
    <div class="skill-row">
      <input type="text" placeholder="Skill name" value="${s.name}" oninput="setSkillName(${i}, this.value)">
      <input type="number" placeholder="+0" value="${s.mod}" oninput="setSkillMod(${i}, this.value)">
      <button class="remove-x" onclick="removeSkillRow(${i})">&times;</button>
    </div>`).join('');
}
function addSkillRow() { draftChar.skills.push({ name: '', mod: 0 }); renderSkillRows(); }
function removeSkillRow(i) { draftChar.skills.splice(i, 1); renderSkillRows(); }
function setSkillName(i, val) { draftChar.skills[i].name = val; }
function setSkillMod(i, val) { draftChar.skills[i].mod = parseInt(val || 0); }
function renderInvRows() {
  el('invRows').innerHTML = draftChar.inventory.map((it, i) => `
    <div class="skill-row">
      <input type="text" placeholder="Item" value="${it}" style="flex:1;" oninput="setInvItem(${i}, this.value)">
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
  renderCharSetup();

  const prompt = `Generate a complete tabletop RPG character sheet for a new level 1 character in a ${MODE === 'solo' ? 'solo story' : 'campaign'} titled "${META.name}". Ruleset: ${META.ruleset}. Genre/tone: ${META.tone || 'unspecified — pick something fitting'}.
${raceHint ? `The player wants a ${raceHint} character.` : 'Choose a race/species that fits the tone.'}
${classHint ? `The player wants to play a ${classHint}.` : 'Choose a class that fits the tone.'}

Respond with ONLY a single JSON object, no markdown code fences, no commentary, matching exactly this shape:
{"race":"string","klass":"string","str":10,"dex":10,"con":10,"int":10,"wis":10,"cha":10,"maxhp":10,"ac":10,"skills":[{"name":"string","mod":0}],"inventory":["string"],"notes":"one or two sentence backstory hook"}

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
    renderCharSetup();
  }
}

async function submitCharacter() {
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
}

function copyCode() {
  navigator.clipboard?.writeText(ROOM);
  const b = event.target; const old = b.innerText; b.innerText = 'Copied!'; setTimeout(() => b.innerText = old, 1200);
}

function leaveTable() {
  if (realtimeChannel) { supabase.removeChannel(realtimeChannel); realtimeChannel = null; }
  if (GM_ABORT) GM_ABORT.abort();
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
        <h1>${META.name}</h1>
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
        <div class="log" id="logBox">${LOG.map(entryHTML).join('') || '<p class="thinking">The story hasn&#39;t begun yet...</p>'}</div>
        <div class="composer">
          <input type="text" id="composerInput" placeholder="Type an action, say something in character, or use /roll +modifier..." onkeydown="if(event.key==='Enter') submitAction()">
          <button class="btn solid" onclick="submitAction()">Send</button>
        </div>
        <div class="hint-bar">Try <code>/roll +5</code> to roll a d20 and add your modifier &middot; <code>/roll +3 adv</code> for advantage &middot; plain text is narrated as your action.</div>
        <div style="margin-top:10px;">
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
    <div class="rname"><b>${c.name}</b><span class="rclass">Lv${c.level} ${c.race} ${c.klass}</span></div>
    <div class="hpbar"><div class="hpbar-fill ${pct < 30 ? 'low' : ''}" style="width:${pct}%"></div></div>
    <div class="hprow"><span>HP ${c.hp}/${c.maxhp}</span><span>AC ${c.ac}</span></div>
    ${abilityGridHTML(c)}
  </div>`;
}
function entryHTML(e) {
  const cls = e.type === 'gm' ? 'gm' : e.type === 'roll' ? 'roll' : e.type === 'system' ? 'system' : 'action';
  const dot = e.type === 'gm' ? '<span class="glow-dot"></span>' : '';
  return `<div class="entry ${cls}"><div class="who">${dot}${e.author}</div><div class="text">${escapeHtml(e.text)}</div></div>`;
}
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'); }

function renderRosterMini() {
  const box = el('rosterMini'); if (!box) return;
  box.innerHTML = Object.entries(ROSTER).map(([id, c]) => {
    const pct = Math.max(0, Math.min(100, Math.round((c.hp / c.maxhp) * 100)));
    return `<div class="roster-card ${id === MY_CHAR_ID ? 'mine' : ''}">
      <div class="rname"><b>${c.name}</b><span class="rclass">Lv${c.level} ${c.race} ${c.klass}</span></div>
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
  const me = ROSTER[MY_CHAR_ID];
  const authorName = me ? me.name : 'Player';

  const rollMatch = text.match(/^\/roll\s*([+-]?\d+)?\s*(adv|dis)?/i);
  let entry;
  if (rollMatch) {
    let mod = rollMatch[1] ? parseInt(rollMatch[1]) : 0;
    const mode = (rollMatch[2] || '').toLowerCase();
    let r1 = Math.floor(Math.random() * 20) + 1;
    let roll = r1;
    let detail = `d20(${r1})`;
    if (mode === 'adv' || mode === 'dis') {
      let r2 = Math.floor(Math.random() * 20) + 1;
      roll = mode === 'adv' ? Math.max(r1, r2) : Math.min(r1, r2);
      detail = `d20(${r1},${r2} ${mode})`;
    }
    const total = roll + mod;
    entry = { id: uid(6), author: authorName, type: 'roll', text: `rolls ${detail} ${mod >= 0 ? '+' : ''}${mod} = ${total}` };
  } else {
    entry = { id: uid(6), author: authorName, type: 'action', text };
  }
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  render();
}

async function fetchGM(prompt, signal) {
  const resp = await fetch('/api/gm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
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
    const text = await fetchGM(prompt, GM_ABORT.signal);
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
  await dbInsertLog(ROOM, entry);
  LOG.push({ ...entry, ts: Date.now() });
  if (VIEW === 'game') render();
}

function cancelGM() {
  if (GM_ABORT) GM_ABORT.abort();
}

async function askGM() {
  if (GM_PENDING) return;
  const recent = LOG.slice(-30).map(e => `${e.author} (${e.type}): ${e.text}`).join('\n');
  const party = Object.values(ROSTER).map(c => `${c.name} — Lv${c.level} ${c.race} ${c.klass}, HP ${c.hp}/${c.maxhp}, AC ${c.ac}, inventory: ${(c.inventory || []).join(', ') || 'none'}`).join('\n');
  const prompt = `You are the Game Master for a tabletop RPG ${MODE === 'solo' ? 'solo story' : 'session'} titled "${META.name}".
Ruleset: ${META.ruleset}. Tone/genre: ${META.tone || 'unspecified — infer something fitting'}. Length: ${lengthLabel[META.length]}.
${META.seed ? 'Opening premise the GM previously established: ' + META.seed : ''}
${MODE === 'solo' ? 'Character' : 'Party'}:
${party}

Recent table log:
${recent}

Continue the story. Narrate consequences of the most recent action(s)/roll(s) in 2-4 short paragraphs, stay consistent with everything established, and end by presenting clear options or an open question. Do not roll dice yourself or invent skill-check results — if a roll is needed, ask the player to use /roll. Never resolve combat or damage on your own initiative without the player(s) acting first. Keep it vivid but concise.`;

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
          <div class="rname"><b>${c.name}</b><span class="rclass">${c.player}</span></div>
          <div class="rclass">Lv${c.level} ${c.race} ${c.klass}</div>
          <div class="hpbar"><div class="hpbar-fill ${pct < 30 ? 'low' : ''}" style="width:${pct}%"></div></div>
          <div class="hprow"><span>HP ${c.hp}/${c.maxhp}</span><span>AC ${c.ac}</span></div>
          ${abilityGridHTML(c)}
          ${(c.inventory && c.inventory.length) ? `<div class="helptext" style="margin-top:8px;"><b style="color:var(--parchment-dim)">Carries:</b> ${c.inventory.join(', ')}</div>` : ''}
        </div>`;
      }).join('')}
    </div>
  `;
}

/* ---------------- SHEET TAB ---------------- */
function renderSheetTab() {
  const c = ROSTER[MY_CHAR_ID];
  if (!c) { el('tabBody').innerHTML = `<p class="thinking">No character found for this device.</p>`; return; }
  el('tabBody').innerHTML = `
    <div class="panel" style="max-width:640px;">
      <h2>${c.name}</h2>
      <p class="rclass">${c.player} &middot; Lv${c.level} ${c.race} ${c.klass}</p>
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
      ${(c.skills || []).map(s => `<div class="item-row"><span>${s.name}</span><span style="font-family:'IBM Plex Mono',monospace;color:var(--glow)">${s.mod >= 0 ? '+' : ''}${s.mod}</span></div>`).join('') || '<p class="helptext">None recorded.</p>'}

      <h3 style="font-size:1rem;margin-top:20px;">Inventory</h3>
      ${(c.inventory || []).map((it, i) => `<div class="item-row"><span>${it}</span><button class="small-x" onclick="removeItem(${i})">&times;</button></div>`).join('') || '<p class="helptext">Empty-handed.</p>'}
      <div class="skill-row" style="margin-top:10px;">
        <input type="text" id="newItem" placeholder="Add item...">
        <button class="add-row" onclick="addItem()">Add</button>
      </div>

      <h3 style="font-size:1rem;margin-top:20px;">Notes</h3>
      <textarea id="charNotes" style="width:100%;min-height:80px;background:var(--bg-deep);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:10px;">${c.notes || ''}</textarea>
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
async function addItem() {
  const v = el('newItem').value.trim(); if (!v) return;
  ROSTER[MY_CHAR_ID].inventory = ROSTER[MY_CHAR_ID].inventory || [];
  ROSTER[MY_CHAR_ID].inventory.push(v);
  await persistRoster(); render();
}
async function removeItem(i) {
  ROSTER[MY_CHAR_ID].inventory.splice(i, 1);
  await persistRoster(); render();
}
async function saveNotes() {
  ROSTER[MY_CHAR_ID].notes = el('charNotes').value;
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
        <li>Dice are <b>only</b> rolled when you type <code>/roll</code>. Your skill modifiers are already saved on your sheet — just add the number, e.g. <code>/roll +5</code>.</li>
        <li>For advantage or disadvantage: <code>/roll +5 adv</code> or <code>/roll +5 dis</code> — rolls two d20s and keeps the higher or lower.</li>
        <li><b>Ask the GM to continue the story</b> sends the recent log and character/party status to the Game Master, who narrates what happens next.</li>
        <li>Your <b>Sheet</b> tab is where you track your own HP and inventory.</li>
        <li><b>Advance Session</b> in the header marks a new session in the log — useful for pacing a Short Arc or longer story.</li>
      </ul>
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
window.submitCreate = submitCreate;
window.submitJoin = submitJoin;
window.copyCode = copyCode;
window.leaveTable = leaveTable;
window.addSkillRow = addSkillRow;
window.removeSkillRow = removeSkillRow;
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
window.askGM = askGM;
window.cancelGM = cancelGM;
window.hpDelta = hpDelta;
window.addItem = addItem;
window.removeItem = removeItem;
window.saveNotes = saveNotes;

/* ---------------- Boot ---------------- */
if (checkConfigured()) render();

})();

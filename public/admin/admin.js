// public/admin/admin.js — the admin page. Not linked from the site and not in the Android app.
// Holds no secrets and no power of its own: every read and write goes to /api/admin (netlify/functions/admin.js)
// with the admin token in a header. The token is kept in sessionStorage (this tab only), never in the URL.
// Everything a player wrote is put on the page as text (textContent), never as HTML.
(function () {
  "use strict";

  const TOKEN_KEY = "ledgerAdminToken";
  const HIDE_KEY = "ledgerAdmin.hideWatcher";
  const PORTRAIT_PREFIX = "https://jmhgkbeqvbbxrztkvenb.supabase.co/storage/v1/object/public/portraits/";
  const POLL_MS = 4000;
  const BEAT_MS = 55000;

  // ---------- small helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "value") e.value = v;
      else if (k === "checked") e.checked = !!v;
      else e.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const same = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
  const short = (s, n = 10) => (s ? String(s).slice(0, n) + (String(s).length > n ? "…" : "") : "");
  const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "—");
  const ago = (t) => { if (!t) return "never"; const m = Math.round((Date.now() - Date.parse(t)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = "none"), 2600); }
  const store = {
    get(k, s = sessionStorage) { try { return s.getItem(k); } catch (e) { return null; } },
    set(k, v, s = sessionStorage) { try { v == null ? s.removeItem(k) : s.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  // ---------- the admin API ----------
  let TOKEN = store.get(TOKEN_KEY) || "";
  async function api(action, body, opts) {
    const resp = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": TOKEN },
      body: JSON.stringify({ action, ...(body || {}) }),
      keepalive: !!(opts && opts.keepalive),
    });
    let data = {};
    try { data = await resp.json(); } catch (e) { /* not JSON */ }
    if (resp.status === 401 || (resp.status === 429 && data.reason === "locked") || (resp.status === 503 && data.reason === "not_configured")) {
      signOut(data.error || "Sign in again.");
      throw Object.assign(new Error(data.error || "Signed out"), { status: resp.status, data, signedOut: true });
    }
    if (!resp.ok) throw Object.assign(new Error(data.error || `HTTP ${resp.status}`), { status: resp.status, data });
    return data;
  }

  // ---------- sign-in ----------
  function signOut(msg) {
    TOKEN = ""; store.set(TOKEN_KEY, null);
    stopGod(true);
    $("#nav").hidden = true; $("#signOut").hidden = true;
    const main = $("#main");
    main.replaceChildren(signInForm(msg));
  }
  function signInForm(msg) {
    const input = h("input", { id: "token", type: "password", autocomplete: "off", spellcheck: "false", placeholder: "ADMIN_SECRET" });
    const err = h("p", { class: "err" }, msg || "");
    const form = h("form", { class: "tile narrow" }, h("h2", {}, "Admin token"), h("p", { class: "hint" }, "Kept in this tab only. Closing the tab forgets it."), input, h("button", { type: "submit", class: "primary" }, "Open"), err);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      TOKEN = input.value.trim(); input.value = "";
      if (!TOKEN) return;
      err.textContent = "Checking…";
      try { await api("ping"); store.set(TOKEN_KEY, TOKEN); start(); }
      catch (e) { if (!e.signedOut) err.textContent = e.message; }
    });
    setTimeout(() => input.focus(), 0);
    return form;
  }
  $("#signOut").addEventListener("click", () => signOut("Signed out."));
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));

  async function start() {
    $("#nav").hidden = false; $("#signOut").hidden = false;
    show("rooms");
  }

  let TAB = "";
  function show(tab) {
    if (TAB === "god" && tab !== "god") pauseGodPolling();
    TAB = tab;
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    const main = $("#main");
    main.replaceChildren(h("p", { class: "hint" }, "Loading…"));
    const views = { rooms: roomsView, characters: charactersView, minis: () => tagsView("minis"), chests: () => tagsView("chests"), audit: auditView, god: godView };
    Promise.resolve(views[tab]()).catch((e) => { if (!e.signedOut) main.replaceChildren(h("p", { class: "err" }, e.message)); });
  }

  // ---------- inventory strings ----------
  // Hero packs store a count at the end ("Handaxe (2)", see QTY_RE in app.js); loot chests at the start ("10 silver").
  const QTY_RE = /\s*\((\d+)\)\s*$/;
  const LEAD_RE = /^\s*(\d+)\s+(.+)$/;
  function parseItem(s, lead) {
    const str = String(s == null ? "" : s);
    const m = lead ? LEAD_RE.exec(str) : QTY_RE.exec(str);
    if (!m) return { name: str.trim(), qty: 1, had: false };
    return lead ? { name: m[2].trim(), qty: parseInt(m[1], 10), had: true } : { name: str.replace(QTY_RE, "").trim(), qty: parseInt(m[1], 10), had: true };
  }
  function formatItem(it, lead) {
    const name = String(it.name || "").trim();
    if (!name) return "";
    const q = Math.max(1, parseInt(it.qty, 10) || 1);
    if (q === 1 && !it.had) return name;
    return lead ? `${q} ${name}` : `${name} (${q})`;
  }
  // Which inventory slots the player typed in themselves (same rule as handFlags in app.js).
  function handFlags(d) {
    const left = Array.isArray(d.handItems) ? d.handItems.filter((i) => (d.inventory || []).includes(i)) : [];
    const inv = d.inventory || [];
    const flags = inv.map(() => false);
    for (let i = inv.length - 1; i >= 0 && left.length; i--) { const k = left.indexOf(inv[i]); if (k >= 0) { flags[i] = true; left.splice(k, 1); } }
    return flags;
  }

  // ---------- the editor shared by every tile ----------
  // kind: 'character' | 'monster' | 'item' | 'meta' | 'raw'. Keeps a working copy; diff() lists only changed keys.
  const NUMS = [["hp", "HP"], ["maxhp", "Max HP"], ["ac", "AC"], ["level", "Level"], ["xp", "XP"]];
  const ABIL = ["str", "dex", "con", "int", "wis", "cha"];
  const TEXTS = [["name", "Name"], ["race", "Race"], ["klass", "Class"], ["player", "Player"], ["gender", "Gender"], ["age", "Age"]];
  function makeEditor(kind, base, onChange) {
    let B = clone(base || {}), W = clone(B);
    const root = h("div");
    const fire = () => { mark(); onChange && onChange(); };
    function mark() {
      const d = diff();
      const changed = new Set([...Object.keys(d.set), ...d.unset]);
      root.querySelectorAll("[data-key]").forEach((el) => el.classList.toggle("changed", changed.has(el.dataset.key)));
    }
    function diff() {
      const set = {}, unset = [];
      for (const k of Object.keys(W)) if (!(k in B) || !same(W[k], B[k])) set[k] = W[k];
      for (const k of Object.keys(B)) if (!(k in W)) unset.push(k);
      return { set, unset };
    }
    const numInput = (k, label) => {
      const el = h("input", { type: "number", inputmode: "numeric", "data-key": k, value: W[k] == null ? "" : W[k] });
      el.addEventListener("input", () => { const v = el.value.trim(); if (v === "") { if (k in B) W[k] = clone(B[k]); else delete W[k]; } else W[k] = parseInt(v, 10); fire(); });
      return h("label", {}, label, el);
    };
    const textInput = (k, label, max, area) => {
      const el = h(area ? "textarea" : "input", { "data-key": k, maxlength: max, value: W[k] == null ? "" : String(W[k]) });
      el.addEventListener("input", () => { if (el.value === "" && !(k in B)) delete W[k]; else W[k] = el.value; fire(); });
      return h("label", {}, label, el);
    };
    const boolInput = (k, label) => {
      const el = h("input", { type: "checkbox", "data-key": k, checked: !!W[k] });
      el.addEventListener("change", () => { if (!el.checked && !(k in B)) delete W[k]; else W[k] = el.checked; fire(); });
      return h("label", { class: "inline" }, el, label);
    };
    function skillsBlock() {
      const box = h("div", { class: "list", "data-key": "skills" });
      const rows = (Array.isArray(W.skills) ? W.skills : []).map((s) => ({ name: (s && s.name) || "", mod: s && s.mod != null ? s.mod : 0 }));
      const write = () => { const list = rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), mod: parseInt(r.mod, 10) || 0 })); if (!list.length && !("skills" in B)) delete W.skills; else W.skills = list; fire(); };
      const draw = () => {
        box.replaceChildren(...rows.map((r, i) => h("div", { class: "li skill" },
          h("input", { value: r.name, placeholder: "Skill", maxlength: 40, oninput: (e) => { r.name = e.target.value; write(); } }),
          h("input", { type: "number", value: r.mod, oninput: (e) => { r.mod = e.target.value; write(); } }),
          h("button", { type: "button", class: "small", onclick: () => { rows.splice(i, 1); draw(); write(); } }, "✕"))),
        h("button", { type: "button", class: "small", onclick: () => { rows.push({ name: "", mod: 0 }); draw(); } }, "+ skill"));
      };
      draw();
      return box;
    }
    function itemsBlock(key, lead, withHand) {
      const box = h("div", { class: "list", "data-key": key });
      const flags = withHand ? handFlags(W) : [];
      const rows = (Array.isArray(W[key]) ? W[key] : []).map((s, i) => ({ ...parseItem(s, lead), hand: !!flags[i] }));
      const write = () => {
        const list = rows.map((r) => formatItem(r, lead)).filter(Boolean);
        if (!list.length && !(key in B)) delete W[key]; else W[key] = list;
        if (withHand) {
          const hand = rows.filter((r) => r.hand).map((r) => formatItem(r, lead)).filter(Boolean);
          if (!hand.length && !("handItems" in B)) delete W.handItems; else W.handItems = hand;
        }
        fire();
      };
      const draw = () => {
        box.replaceChildren(...rows.map((r, i) => h("div", { class: "li" },
          h("input", { value: r.name, placeholder: "Item", maxlength: 72, oninput: (e) => { r.name = e.target.value; write(); } }),
          h("input", { type: "number", min: 1, value: r.qty, title: "Quantity", oninput: (e) => { r.qty = e.target.value; write(); } }),
          withHand ? h("label", { class: "inline hand", title: "Typed in by the player, not given in the story" }, h("input", { type: "checkbox", checked: r.hand, onchange: (e) => { r.hand = e.target.checked; write(); } }), "typed") : h("span"),
          h("button", { type: "button", class: "small", onclick: () => { rows.splice(i, 1); draw(); write(); } }, "✕"))),
        h("button", { type: "button", class: "small", onclick: () => { rows.push({ name: "", qty: 1, had: false, hand: false }); draw(); } }, "+ item"));
      };
      draw();
      return box;
    }
    function rawBlock() {
      const ta = h("textarea", { class: "json", spellcheck: "false", value: JSON.stringify(W, null, 2) });
      const msg = h("p", { class: "err" });
      const apply = h("button", { type: "button", class: "small", onclick: () => {
        let v;
        try { v = JSON.parse(ta.value); } catch (e) { msg.textContent = "That isn't valid JSON: " + e.message; return; }
        if (!v || typeof v !== "object" || Array.isArray(v)) { msg.textContent = "It must be an object { … }."; return; }
        W = v; msg.textContent = ""; draw(); fire();
      } }, "Use this JSON");
      return h("details", {}, h("summary", {}, "Raw JSON (every field)"), h("p", { class: "hint" }, "Edit, then “Use this JSON”, then Save. Removing a key here removes it from the record."), ta, apply, msg);
    }
    function draw() {
      const parts = [];
      if (kind === "character") {
        parts.push(h("div", { class: "row r5" }, NUMS.map(([k, l]) => numInput(k, l))));
        parts.push(h("div", { class: "row r6" }, ABIL.map((k) => numInput(k, k.toUpperCase()))));
        parts.push(h("div", { class: "actions" }, boolInput("dead", "Dead"), boolInput("stable", "Stable")));
        parts.push(h("details", {}, h("summary", {}, `Inventory (${(W.inventory || []).length})`), itemsBlock("inventory", false, true)));
        parts.push(h("details", {}, h("summary", {}, `Skills (${(W.skills || []).length})`), skillsBlock()));
        parts.push(h("details", {}, h("summary", {}, "Details and notes"),
          h("div", { class: "row r3" }, TEXTS.map(([k, l]) => textInput(k, l, k === "gender" ? 30 : k === "age" ? 20 : 40))),
          h("div", { class: "row r2" }, numInput("markOfReturn", "Mark of Return"), numInput("gravewardenDebt", "Gravewarden debt")),
          textInput("appearance", "Appearance", 500, true), textInput("notes", "Notes", 2000, true)));
        const other = Object.keys(W).filter((k) => ![...NUMS.map((n) => n[0]), ...ABIL, ...TEXTS.map((t) => t[0]), "dead", "stable", "inventory", "handItems", "skills", "markOfReturn", "gravewardenDebt", "appearance", "notes"].includes(k));
        if (other.length) parts.push(h("p", { class: "hint" }, "Also stored (edit in Raw JSON): " + other.join(", ")));
      } else if (kind === "monster") {
        parts.push(h("div", { class: "row r2" }, textInput("name", "Name", 40), textInput("cr", "CR", 4)));
      } else if (kind === "item") {
        parts.push(textInput("name", "Name", 60), textInput("description", "Description", 500, true));
        parts.push(h("p", { class: "hint" }, "Contents (name and how many):"), itemsBlock("items", true, false));
      } else if (kind === "meta") {
        parts.push(h("div", { class: "row r2" }, textInput("name", "Story name", 80), textInput("tone", "Tone", 80)));
      }
      parts.push(rawBlock());
      root.replaceChildren(...parts);
      mark();
    }
    draw();
    return {
      el: root, diff,
      dirty() { const d = diff(); return Object.keys(d.set).length > 0 || d.unset.length > 0; },
      base() { return B; },
      // After a save: the server's record becomes the new starting point.
      reset(newBase, keepMine) {
        const mine = diff();
        B = clone(newBase || {});
        W = clone(B);
        if (keepMine) { for (const k of Object.keys(mine.set)) if (!keepMine.includes(k)) W[k] = mine.set[k]; for (const k of mine.unset) if (!keepMine.includes(k)) delete W[k]; }
        draw(); onChange && onChange();
      },
      revert() { W = clone(B); draw(); onChange && onChange(); },
    };
  }

  // A save area for a tile: shows what changed, Save / Reset, and handles "changed since you loaded it".
  // save(diff, base) must call the API and return its reply; extra() adds tile-level changes (status, batch).
  function saveBar(tile, editor, save, extra) {
    const info = h("div", { class: "changes" });
    const msg = h("div", { class: "err" });
    const saveBtn = h("button", { type: "button", class: "primary", disabled: true }, "Save");
    const resetBtn = h("button", { type: "button", disabled: true }, "Reset");
    function refresh() {
      const d = editor.diff();
      const ex = extra ? extra.changes() : [];
      const names = [...Object.keys(d.set), ...d.unset.map((k) => k + " (removed)"), ...ex];
      info.textContent = names.length ? "Changed: " + names.join(", ") : "";
      saveBtn.disabled = resetBtn.disabled = !names.length;
      tile.classList.toggle("dirty", names.length > 0);
    }
    async function doSave(baseOverride) {
      const d = editor.diff();
      msg.textContent = ""; msg.className = "err";
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        const r = await save(d, baseOverride || editor.base());
        editor.reset(r.data || r.meta || null);
        if (extra) extra.saved(r);
        msg.className = "ok"; msg.textContent = "Saved. Open sheets update within a second.";
      } catch (e) {
        if (e.signedOut) return;
        if (e.status === 409 && e.data && e.data.current) showConflict(e.data);
        else msg.textContent = e.message;
      } finally { saveBtn.textContent = "Save"; refresh(); }
    }
    function showConflict(data) {
      const keys = data.keys || [];
      const mine = editor.diff().set;
      const lines = keys.map((k) => `${k}\n  now:  ${JSON.stringify(data.current[k])}\n  yours: ${JSON.stringify(k in mine ? mine[k] : "(removed)")}`).join("\n");
      msg.replaceChildren(
        h("p", {}, "Someone changed this since you loaded it (the game, or another admin):"),
        h("div", { class: "diff" }, lines),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "danger", onclick: () => { const b = { ...editor.base() }; for (const k of keys) b[k] = data.current[k]; doSave(b); } }, "Save mine anyway"),
          h("button", { type: "button", onclick: () => { editor.reset(data.current, keys); msg.textContent = "Reloaded the latest values for: " + keys.join(", ") + ". Your other changes are kept."; } }, "Take theirs, keep my other changes")));
    }
    saveBtn.addEventListener("click", () => doSave());
    resetBtn.addEventListener("click", () => { editor.revert(); if (extra) extra.revert(); msg.textContent = ""; refresh(); });
    return { el: h("div", { class: "actions" }, saveBtn, resetBtn, info, msg), refresh };
  }

  // ---------- characters ----------
  function portrait(url) { return typeof url === "string" && url.startsWith(PORTRAIT_PREFIX) && !/[\s"'<>()]/.test(url) ? h("img", { src: url, alt: "" }) : null; }
  function characterTile(c, opts) {
    const tile = h("div", { class: "tile" });
    let bar;
    const editor = makeEditor("character", c.data, () => bar && bar.refresh());
    const d = c.data || {};
    const head = h("div", { class: "head" }, portrait(c.portrait_url),
      h("div", {}, h("h3", {}, d.name || "(no name)"),
        h("div", { class: "sub" }, [d.race, d.klass].filter(Boolean).join(" "), " ",
          h("span", { class: "pill" }, c.room_code), d.dead ? h("span", { class: "pill red" }, "dead") : null, d.stable ? h("span", { class: "pill" }, "stable") : null,
          d.heroTag ? h("span", { class: "pill", title: "Plays from a mini" }, "mini") : null)));
    bar = saveBar(tile, editor, async (diff, base) => api("patch_character", { room: c.room_code, id: c.id, set: diff.set, unset: diff.unset, base }));
    tile.append(head, editor.el, bar.el, h("p", { class: "hint" }, `id ${c.id}`));
    if (opts && opts.adjust) tile.append(adjustBox(c, (data) => editor.reset(data)));
    return tile;
  }
  // HP / XP change with a line in the story log, so the table sees what changed.
  function adjustBox(c, after) {
    const hp = h("input", { type: "number", placeholder: "HP ±" }), xp = h("input", { type: "number", placeholder: "XP ±" }), note = h("input", { placeholder: "Why (shown to the table)", maxlength: 200 });
    const msg = h("span", { class: "hint" });
    const go = h("button", { type: "button", onclick: async () => {
      try {
        const r = await api("adjust_character", { room: c.room_code, id: c.id, hp: hp.value, xp: xp.value, note: note.value });
        hp.value = xp.value = note.value = ""; msg.textContent = r.line; after(r.data);
      } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
    } }, "Apply + log");
    return h("details", {}, h("summary", {}, "Change HP / XP with a log line"), h("div", { class: "row r3" }, hp, xp, go), note, msg);
  }

  let ROOMS = [];
  const roomName = (code) => { const r = ROOMS.find((x) => x.code === code); return (r && r.meta && r.meta.name) || ""; };
  async function charactersView() {
    const [cr, rr] = await Promise.all([api("characters"), api("rooms")]);
    ROOMS = rr.rooms;
    const all = cr.characters;
    const search = h("input", { type: "search", placeholder: "Search name, room, race, class, id" });
    const count = h("span", { class: "count" });
    const grid = h("div", { class: "grid" });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const list = all.filter((c) => !q || [c.id, c.room_code, roomName(c.room_code), c.data && c.data.name, c.data && c.data.race, c.data && c.data.klass].some((v) => String(v || "").toLowerCase().includes(q)));
      count.textContent = `${list.length} of ${all.length}`;
      const parts = [];
      let last = null;
      for (const c of list) {
        if (c.room_code !== last) { last = c.room_code; parts.push(h("h4", { class: "group-title" }, `${c.room_code} — ${roomName(c.room_code) || "untitled"}`)); }
        parts.push(characterTile(c, { adjust: true }));
      }
      grid.replaceChildren(...parts);
    };
    let t; search.addEventListener("input", () => { clearTimeout(t); t = setTimeout(draw, 200); });
    $("#main").replaceChildren(h("div", { class: "bar" }, search, count), grid);
    draw();
  }

  // ---------- rooms ----------
  function openOverlay(content) {
    const o = h("div", { class: "overlay", onclick: (e) => { if (e.target === o) o.remove(); } }, h("div", { class: "tile" }, h("div", { class: "actions" }, h("button", { type: "button", onclick: () => o.remove() }, "Close")), content));
    document.body.append(o);
    return o;
  }
  function roomTile(r) {
    const tile = h("div", { class: "tile" });
    const meta = r.meta || {};
    const nChars = (r.characters && r.characters[0] && r.characters[0].count) || 0;
    const nMembers = (r.room_members && r.room_members[0] && r.room_members[0].count) || 0;
    const msg = h("p", { class: "err" });
    const act = async (field, value, label) => {
      try { await api("set_room", { room: r.code, field, value }); toast(label); show("rooms"); }
      catch (e) { if (!e.signedOut) msg.textContent = e.message; }
    };
    const joinCode = r.kind === "account" ? r.join_code : r.code;
    const guests = h("input", { type: "checkbox", checked: !!r.allow_guests, onchange: (e) => act("allow_guests", e.target.checked, e.target.checked ? "Guests allowed" : "Guests not allowed") });
    const details = h("div");
    let bar;
    const metaEditor = makeEditor("meta", meta, () => bar && bar.refresh());
    bar = saveBar(tile, metaEditor, async (diff, base) => api("patch_room_meta", { room: r.code, set: diff.set, unset: diff.unset, base }));
    tile.append(
      h("div", { class: "head" }, h("div", {},
        h("h3", {}, r.code, " — ", meta.name || "untitled"),
        h("div", { class: "sub" },
          h("span", { class: "pill" }, r.mode), h("span", { class: "pill" }, r.kind),
          r.archived_at ? h("span", { class: "pill" }, "archived") : null,
          r.admin_paused_at ? h("span", { class: "pill red" }, "paused") : null,
          r.watcher_at && Date.now() - Date.parse(r.watcher_at) < 180000 ? h("span", { class: "pill green" }, "watched") : null))),
      h("div", { class: "sub" },
        `${nChars} character${nChars === 1 ? "" : "s"} · ${nMembers} member${nMembers === 1 ? "" : "s"} · played ${ago(r.last_played)} · made ${when(r.created_at)}`),
      h("div", { class: "sub" }, r.kind === "account" ? `Join code ${r.join_code || "—"} · owner ${short(r.owner_id, 8)}` : "Guest table (joined with its code)",
        meta.host ? ` · host ${short(meta.host, 8)}` : "", r.paused_at ? ` · story paused ${ago(r.paused_at)}` : ""),
      h("label", { class: "inline" }, guests, "Guests may join"),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "primary", onclick: () => enterGod(r.code) }, "Enter as GOD"),
        h("button", { type: "button", onclick: () => act("paused", !r.admin_paused_at, r.admin_paused_at ? "Resumed" : "Paused") }, r.admin_paused_at ? "Resume" : "Pause"),
        h("button", { type: "button", onclick: () => act("archived", !r.archived_at, r.archived_at ? "Restored" : "Archived") }, r.archived_at ? "Unarchive" : "Archive"),
        h("button", { type: "button", onclick: () => { navigator.clipboard && navigator.clipboard.writeText(joinCode).then(() => toast("Copied " + joinCode), () => toast(joinCode)); } }, "Copy code"),
        h("button", { type: "button", onclick: () => loadRoomDetails(r, details) }, "Characters & members"),
        h("button", { type: "button", class: "danger", onclick: () => deleteRoom(r, msg) }, "Delete…")),
      details,
      h("details", {}, h("summary", {}, "Campaign meta"), metaEditor.el, bar.el),
      msg);
    return tile;
  }
  async function loadRoomDetails(r, box) {
    box.replaceChildren(h("p", { class: "hint" }, "Loading…"));
    try {
      const d = await api("room", { room: r.code });
      box.replaceChildren(
        h("p", { class: "hint" }, "Characters (tap to edit):"),
        h("div", {}, d.characters.map((c) => h("button", { type: "button", class: "small mini", onclick: () => openOverlay(characterTile(c, { adjust: true })) },
          `${(c.data && c.data.name) || c.id} · HP ${(c.data && c.data.hp) ?? "?"}/${(c.data && c.data.maxhp) ?? "?"}`))),
        h("p", { class: "hint" }, "Members:"),
        h("div", {}, d.members.length ? d.members.map((m) => h("span", { class: "pill" }, `${m.role} ${short(m.user_id, 8)}${m.character_id ? " → " + m.character_id : ""}`)) : "none"));
    } catch (e) { if (!e.signedOut) box.replaceChildren(h("p", { class: "err" }, e.message)); }
  }
  async function deleteRoom(r, msg) {
    const typed = window.prompt(`Delete ${r.code} with its characters and story log? This can't be undone (the audit keeps a copy of the characters).\n\nType the room code to confirm:`);
    if (typed == null) return;
    try { const res = await api("delete_room", { room: r.code, confirm: typed.trim() }); toast(`Deleted ${r.code} (${res.characters} characters, ${res.log_lines} log lines)`); show("rooms"); }
    catch (e) { if (!e.signedOut) msg.textContent = e.data && e.data.code === "confirm" ? "The code didn't match. Nothing was deleted." : e.message; }
  }
  async function roomsView() {
    const rr = await api("rooms");
    ROOMS = rr.rooms;
    const search = h("input", { type: "search", placeholder: "Search code, name, join code" });
    const kind = h("select", {}, h("option", { value: "" }, "All tables"), h("option", { value: "guest" }, "Guest"), h("option", { value: "account" }, "Account"), h("option", { value: "paused" }, "Paused"), h("option", { value: "archived" }, "Archived"));
    const count = h("span", { class: "count" });
    const grid = h("div", { class: "grid" });
    const draw = () => {
      const q = search.value.trim().toLowerCase(), k = kind.value;
      const list = ROOMS.filter((r) => (!q || [r.code, r.join_code, r.meta && r.meta.name].some((v) => String(v || "").toLowerCase().includes(q)))
        && (!k || (k === "paused" ? r.admin_paused_at : k === "archived" ? r.archived_at : r.kind === k)));
      count.textContent = `${list.length} of ${ROOMS.length}`;
      grid.replaceChildren(...list.map(roomTile));
    };
    search.addEventListener("input", draw); kind.addEventListener("change", draw);
    $("#main").replaceChildren(h("div", { class: "bar" }, search, kind, count), grid);
    draw();
  }

  // ---------- minis and chests (the tags table) ----------
  const TAG_STATUSES = ["blank", "active", "moved", "disabled", "used"];
  const tagKind = (id) => (id.startsWith("h_") ? "character" : id.startsWith("m_") ? "monster" : id.startsWith("i_") ? "item" : "raw");
  function tagTile(t, batches) {
    const tile = h("div", { class: "tile" });
    const d = t.data || {};
    const status = h("select", {}, TAG_STATUSES.map((s) => h("option", { value: s }, s)));
    status.value = t.status;
    const batch = h("input", { value: t.batch || "", list: "batchList", maxlength: 40, placeholder: "batch" });
    let bar;
    const editor = makeEditor(tagKind(t.id), d, () => bar && bar.refresh());
    let cur = { status: t.status, batch: t.batch || "" };
    const extra = {
      changes: () => [status.value !== cur.status ? "status" : null, batch.value.trim() !== cur.batch ? "batch" : null].filter(Boolean),
      revert: () => { status.value = cur.status; batch.value = cur.batch; },
      saved: () => { cur = { status: status.value, batch: batch.value.trim() }; },
    };
    status.addEventListener("change", () => bar.refresh()); batch.addEventListener("input", () => bar.refresh());
    bar = saveBar(tile, editor, async (diff, base) => api("patch_tag", { id: t.id, set: diff.set, unset: diff.unset, base,
      status: status.value !== cur.status ? status.value : undefined, batch: batch.value.trim() !== cur.batch ? batch.value.trim() : undefined }), extra);
    const used = t.kind === "item" && t.status === "used";
    const history = h("div");
    const msg = h("p", { class: "err" });
    tile.append(
      h("div", { class: "head" }, h("div", {},
        h("h3", {}, d.name || (t.status === "blank" ? "(blank mini)" : "(no name)")),
        h("div", { class: "sub" }, h("span", { class: "pill" }, t.kind), h("span", { class: t.status === "active" ? "pill green" : t.status === "used" || t.status === "disabled" ? "pill red" : "pill" }, t.status), t.id))),
      t.kind === "item"
        ? h("p", { class: "sub" }, used ? `Opened ${when(t.used_at)} by ${t.used_by || "?"} at ${t.used_room || "?"}` : "Not opened yet")
        : h("p", { class: "sub" }, `Owner ${t.claimed_by ? short(t.claimed_by, 10) : "none"} · forged ${when(t.forged_at)} · played ${ago(t.last_played)}${t.moved_to ? " · moved to " + t.moved_to : ""}`),
      h("div", { class: "row r2" }, h("label", {}, "Status", status), h("label", {}, "Batch", batch)),
      editor.el, bar.el,
      h("div", { class: "actions" },
        t.kind === "item" ? h("button", { type: "button", disabled: !used && t.status === "active", onclick: async () => {
          if (!window.confirm(`Reset ${d.name || t.id} to unopened? It can then be opened again.`)) return;
          try { await api("reset_loot", { id: t.id }); toast("Reset to unopened"); show(TAB); } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
        } }, "Reopen / reset to active") : null,
        h("button", { type: "button", onclick: () => loadTagHistory(t, history) }, "History & snapshots")),
      history, msg);
    return tile;
  }
  async function loadTagHistory(t, box) {
    box.replaceChildren(h("p", { class: "hint" }, "Loading…"));
    try {
      const d = await api("tag", { id: t.id });
      const c = d.claim;
      box.replaceChildren(
        h("p", { class: "sub" }, c ? `Claim code: batch ${c.batch} #${c.serial}, issued ${when(c.issued_at)}, ${c.claimed_at ? `claimed ${when(c.claimed_at)} by ${short(c.claimed_by, 10)}` : "not claimed yet"}` : "No claim code on record."),
        d.snapshots.length ? h("details", { open: true }, h("summary", {}, `Snapshots (${d.snapshots.length})`),
          d.snapshots.map((s) => h("div", { class: "actions" },
            h("span", { class: "sub" }, `${when(s.saved_at)} · level ${(s.data && s.data.level) ?? "?"} · ${((s.data && s.data.inventory) || []).length} items`),
            h("button", { type: "button", class: "small", onclick: async () => {
              if (!window.confirm("Restore this snapshot onto the mini? The current version is kept in the audit.")) return;
              try { await api("restore_snapshot", { id: t.id, snapshot: s.id }); toast("Restored"); show(TAB); } catch (e) { if (!e.signedOut) toast(e.message); }
            } }, "Restore this snapshot")))) : h("p", { class: "hint" }, "No snapshots."),
        h("details", {}, h("summary", {}, `Events (${d.events.length})`),
          h("table", { class: "events" }, d.events.map((e) => h("tr", {}, h("td", {}, when(e.at)), h("td", {}, e.event), h("td", {}, short(e.key_hash, 8)), h("td", {}, e.detail || ""))))));
    } catch (e) { if (!e.signedOut) box.replaceChildren(h("p", { class: "err" }, e.message)); }
  }
  async function tagsView(which) {
    const chests = which === "chests";
    const kindSel = h("select", {}, ...(chests ? [h("option", { value: "item" }, "Chests and coins")] : ["", "hero", "monster", "item", "keystone"].map((k) => h("option", { value: k }, k || "All kinds"))));
    const statusSel = h("select", {}, ["", ...TAG_STATUSES].map((s) => h("option", { value: s }, s || "Any status")));
    const batchSel = h("select", {}, h("option", { value: "" }, "Any batch"));
    const search = h("input", { type: "search", placeholder: chests ? "Search name, contents, room" : "Search name, id, owner" });
    const count = h("span", { class: "count" });
    const grid = h("div", { class: "grid" });
    const datalist = h("datalist", { id: "batchList" });
    let rows = [];
    async function load() {
      grid.replaceChildren(h("p", { class: "hint" }, "Loading…"));
      const r = await api("tags", { kind: chests ? "item" : kindSel.value || undefined, status: statusSel.value || undefined, batch: batchSel.value || undefined });
      rows = r.tags;
      if (batchSel.options.length === 1) r.batches.forEach((b) => batchSel.append(h("option", { value: b.batch }, `${b.batch} (${b.kind}, ${b.size})${b.active ? "" : " off"}`)));
      datalist.replaceChildren(...r.batches.map((b) => h("option", { value: b.batch })));
      draw(r.batches);
    }
    function draw(batches) {
      const q = search.value.trim().toLowerCase();
      const list = rows.filter((t) => !q || [t.id, t.claimed_by, t.used_room, t.used_by, JSON.stringify(t.data || {})].some((v) => String(v || "").toLowerCase().includes(q)));
      count.textContent = `${list.length} of ${rows.length}`;
      grid.replaceChildren(...list.map((t) => tagTile(t, batches)));
    }
    [kindSel, statusSel, batchSel].forEach((s) => s.addEventListener("change", load));
    search.addEventListener("input", () => draw());
    $("#main").replaceChildren(h("div", { class: "bar" }, search, chests ? null : kindSel, statusSel, batchSel, count), datalist, grid);
    await load();
  }

  // ---------- audit ----------
  async function auditView() {
    const r = await api("audit", { limit: 300 });
    $("#main").replaceChildren(h("div", { class: "bar" }, h("span", { class: "count" }, `Last ${r.audit.length} admin changes`)),
      h("div", { class: "grid" }, r.audit.map((a) => h("div", { class: "tile" },
        h("div", { class: "sub" }, when(a.at), " · ", h("b", {}, a.action), " · ", a.target),
        h("details", {}, h("summary", {}, "Before / after"), h("div", { class: "diff" }, "before: " + JSON.stringify(a.before, null, 1) + "\n\nafter: " + JSON.stringify(a.after, null, 1)))))));
  }

  // ---------- GOD view ----------
  // Not a player: no membership, no character, no limits or ink. Reads the table through /api/admin every few
  // seconds (players' live updates are for members only) and marks the table as watched about once a minute,
  // unless the badge is hidden.
  const GOD = { room: null, poll: null, lastBeat: 0, data: null, logKey: "", partyKey: "" };
  const hideWatcher = () => store.get(HIDE_KEY, localStorage) === "1";
  function enterGod(code) {
    stopGod(false);
    GOD.room = code; GOD.lastBeat = 0; GOD.data = null; GOD.logKey = GOD.partyKey = "";
    $("#godTab").hidden = false; $("#godTab").textContent = "GOD " + code;
    show("god");
  }
  function stopGod(leaving) {
    if (GOD.poll) clearInterval(GOD.poll);
    GOD.poll = null;
    if (leaving && GOD.room) {
      if (TOKEN) api("watch", { room: GOD.room, on: false }, { keepalive: true }).catch(() => {});
      GOD.room = null; const t = $("#godTab"); if (t) t.hidden = true;
    }
  }
  function pauseGodPolling() { if (GOD.poll) clearInterval(GOD.poll); GOD.poll = null; }
  window.addEventListener("pagehide", () => { if (GOD.room && TOKEN && !hideWatcher()) api("watch", { room: GOD.room, on: false }, { keepalive: true }).catch(() => {}); });
  async function godFetch() {
    const beat = !hideWatcher() && Date.now() - GOD.lastBeat > BEAT_MS;
    const d = await api("god", { room: GOD.room, watch: beat });
    if (beat) GOD.lastBeat = Date.now();
    GOD.data = d;
    return d;
  }
  async function godView() {
    if (!GOD.room) { $("#main").replaceChildren(h("p", { class: "hint" }, "Pick a table on Rooms and press “Enter as GOD”.")); return; }
    const room = GOD.room;
    if (hideWatcher()) api("watch", { room, on: false }).catch(() => {});
    const title = h("h3", {});
    const state = h("span", {});
    const hide = h("input", { type: "checkbox", checked: hideWatcher(), onchange: (e) => { store.set(HIDE_KEY, e.target.checked ? "1" : null, localStorage); if (e.target.checked) api("watch", { room, on: false }).catch(() => {}); else GOD.lastBeat = 0; } });
    const pauseBtn = h("button", { type: "button" }, "Pause");
    const log = h("div", { class: "log" });
    const party = h("div", { class: "party" });
    const foes = h("div");
    const map = h("div");
    const msg = h("p", { class: "err" });
    // post a message
    const asSel = h("select", {}, h("option", { value: "god" }, "As GOD"), h("option", { value: "narrator" }, "As Narrator"), h("option", { value: "system" }, "System note"), h("option", { value: "gm" }, "As the GM"));
    const text = h("textarea", { placeholder: "Message to the table", maxlength: 4000 });
    const send = h("button", { type: "button", class: "primary", onclick: async () => {
      if (!text.value.trim()) return;
      try { await api("post", { room, as: asSel.value, text: text.value }); text.value = ""; await refresh(true); } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
    } }, "Post");
    const expr = h("input", { placeholder: "d20+3, 2d6, d20 adv" }), label = h("input", { placeholder: "label (optional)", maxlength: 40 });
    const roll = h("button", { type: "button", onclick: async () => {
      try { const r = await api("roll", { room, expr: expr.value, label: label.value }); toast(`GOD ${r.text}`); await refresh(true); } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
    } }, "Roll");
    pauseBtn.addEventListener("click", async () => {
      const paused = !!(GOD.data && GOD.data.room.admin_paused_at);
      try { await api("set_room", { room, field: "paused", value: !paused }); await refresh(true); } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
    });

    function drawLog(d) {
      const key = d.log.length + ":" + (d.log.length ? d.log[d.log.length - 1].id : "");
      if (key === GOD.logKey) return;
      GOD.logKey = key;
      const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.replaceChildren(...d.log.map((e) => h("div", { class: "entry " + (e.type || "") }, h("div", { class: "who" }, `${e.author || "?"} · ${e.type} · ${when(e.created_at)}`), e.text || "")));
      if (atEnd || !GOD.logKey) log.scrollTop = log.scrollHeight;
    }
    function drawParty(d) {
      if (party.contains(document.activeElement)) return; // don't redraw under someone typing
      const key = JSON.stringify(d.characters.map((c) => [c.id, c.data]));
      if (key === GOD.partyKey) return;
      GOD.partyKey = key;
      party.replaceChildren(...d.characters.map((c) => {
        const x = c.data || {};
        const hp = Number(x.hp) || 0, mx = Math.max(Number(x.maxhp) || 1, 1);
        const delta = h("input", { type: "number", placeholder: "HP ±" }), xp = h("input", { type: "number", placeholder: "XP ±" });
        return h("div", { class: "tile" },
          h("div", { class: "head" }, portrait(c.portrait_url), h("div", {}, h("h3", {}, x.name || c.id), h("div", { class: "sub" }, `Lv ${x.level ?? "?"} ${x.race || ""} ${x.klass || ""} · AC ${x.ac ?? "?"} · XP ${x.xp ?? 0}`, x.dead ? " · DEAD" : ""))),
          h("div", { class: "hpbar" }, h("div", { style: `width:${Math.max(0, Math.min(100, Math.round((hp / mx) * 100)))}%` })),
          h("div", { class: "sub" }, `HP ${hp}/${mx}`),
          h("div", { class: "row r3" }, delta, xp, h("button", { type: "button", onclick: async () => {
            try { await api("adjust_character", { room, id: c.id, hp: delta.value, xp: xp.value }); delta.value = xp.value = ""; await refresh(true); } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
          } }, "Apply")),
          h("button", { type: "button", class: "small", onclick: () => openOverlay(characterTile(c, { adjust: true })) }, "Edit everything"));
      }));
    }
    function drawFoes(d) {
      const f = Object.values((d.room.meta && d.room.meta.foes) || {}).filter((x) => x && typeof x === "object");
      foes.replaceChildren(f.length ? h("div", {}, f.map((x) => h("div", { class: "sub" }, `${x.ally ? "Ally" : "Foe"}: ${x.name} ${Number(x.hp) || 0}/${Number(x.maxhp) || 0} HP`))) : h("p", { class: "hint" }, "No foes tracked."));
    }
    function drawMap(d) {
      const g = d.room.meta && d.room.meta.grid;
      const w = Math.min(60, Math.max(0, Number(g && g.w) || 0)), ht = Math.min(60, Math.max(0, Number(g && g.h) || 0));
      if (!w || !ht) { map.replaceChildren(h("p", { class: "hint" }, "No battle map.")); return; }
      const at = {}; for (const t of g.tokens || []) at[Number(t.x) + "," + Number(t.y)] = t;
      const walls = new Set(g.walls || []);
      const col = (x) => String.fromCharCode(65 + x);
      const cells = [];
      for (let y = 0; y < ht; y++) for (let x = 0; x < w; x++) {
        const t = at[x + "," + y];
        cells.push(t ? h("div", { class: t.kind === "hero" ? "hero" : t.kind === "ally" ? "ally" : "foe", title: `${t.name} ${col(x)}${y + 1}` }, String(t.name || "?").split(/\s+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase())
          : h("div", { class: walls.has(col(x) + (y + 1)) ? "wall" : "" }));
      }
      const grid = h("div", { class: "map", style: `grid-template-columns: repeat(${w}, 20px)` }, cells);
      map.replaceChildren(grid);
    }
    async function refresh() {
      if (!GOD.room || TAB !== "god") return;
      try {
        const d = await godFetch();
        const r = d.room;
        title.textContent = `${r.code} — ${(r.meta && r.meta.name) || "untitled"}`;
        state.replaceChildren(h("span", {}, h("span", { class: "pill" }, r.mode), r.admin_paused_at ? h("span", { class: "pill red" }, "paused") : h("span", { class: "pill green" }, "playing"),
          r.archived_at ? h("span", { class: "pill" }, "archived") : null, h("span", { class: "sub" }, ` updated ${new Date().toLocaleTimeString()}`)));
        pauseBtn.textContent = r.admin_paused_at ? "Resume" : "Pause";
        drawLog(d); drawParty(d); drawFoes(d); drawMap(d);
        msg.textContent = "";
      } catch (e) { if (!e.signedOut) msg.textContent = e.message; }
    }
    $("#main").replaceChildren(
      h("div", { class: "tile" }, h("div", { class: "head" }, h("div", {}, title, state)),
        h("div", { class: "actions" }, pauseBtn,
          h("label", { class: "inline" }, hide, "Hide the Watcher badge"),
          h("button", { type: "button", onclick: () => { stopGod(true); show("rooms"); } }, "Leave"))),
      h("div", { class: "god" },
        h("div", {}, log,
          h("div", { class: "tile" }, h("div", { class: "row r2" }, asSel, send), text),
          h("div", { class: "tile" }, h("div", { class: "row r3" }, expr, label, roll)), msg),
        h("div", {}, h("h4", { class: "group-title" }, "Party"), party, h("h4", { class: "group-title" }, "Foes"), h("div", { class: "tile" }, foes),
          h("h4", { class: "group-title" }, "Battle map"), h("div", { class: "tile" }, map))));
    await refresh(true);
    GOD.poll = setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, POLL_MS);
  }

  // ---------- go ----------
  if (TOKEN) api("ping").then(start, (e) => { if (!e.signedOut) signOut(e.message); });
  else signOut("");
})();

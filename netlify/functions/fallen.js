// netlify/functions/fallen.js
//
// The Hall of the Fallen (supabase/fallen.sql).
//   POST { action: "record", roomCode, characterId }    a hero just died: record them, with their best
//                                                       achievement and an epitaph written from the story log
//   POST { action: "returned", roomCode, characterId }  a hero was brought back: take them out of the Hall
// Everything is read from the database (the character must really be dead), so nobody can write their own
// epitaph or add a hero who didn't die. The Gravewarden (revive.js) marks returns itself as well.

const { ROOM_CODE_RE, sbRest, corsHeaders, requireMember } = require("./lib/shared");

const enc = encodeURIComponent;
const clean = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);

async function writeMemorial(apiKey, c, story, logText) {
  const prompt = `A hero has died in a tabletop story. Write their memorial for the Hall of the Fallen.
Hero: ${c.name}, level ${c.level || 1} ${c.race || ""} ${c.klass || ""}. Story: "${story}". ${c.deathCause === "massive" ? "They were killed outright by a massive blow." : "They died after failing their death saves."}
Recent story log (oldest first):
${logText}

From the log, pick the single best thing this hero achieved (a brave deed, a rescue, a victory, a clever moment). If the log shows nothing notable, honour how they fell.
Respond with ONLY a JSON object, no markdown: {"achievement":"one sentence in the past tense, under 120 characters, naming the deed","epitaph":"a short epitaph, under 70 characters"}`;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`memorial ${resp.status}`);
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  return { achievement: clean(j.achievement, 160), epitaph: clean(j.epitaph, 90) };
}

exports.handler = async function (event) {
  const headers = { ...corsHeaders(event), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: "Method Not Allowed" };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  let b;
  try { b = JSON.parse(event.body || "{}"); } catch (e) { return reply(400, { error: "That request couldn't be read." }); }
  const roomCode = String(b.roomCode || "").toUpperCase(), characterId = String(b.characterId || "");
  if (!ROOM_CODE_RE.test(roomCode) || !/^[a-z0-9]{4,20}$/i.test(characterId)) return reply(400, { error: "That request couldn't be read." });
  // Only a player at this table (session token + membership) can record or clear one of its heroes.
  const member = await requireMember(b.accessToken, roomCode);
  if (!member.ok) return reply(member.status, { error: member.status === 503 ? "Try again in a moment." : "You aren't at this table. Join it again with its code.", reason: member.reason });

  try {
    const rows = await sbRest(`characters?id=eq.${enc(characterId)}&room_code=eq.${enc(roomCode)}&select=data`);
    const c = rows && rows[0] && rows[0].data;
    if (!c) return reply(404, { error: "That hero isn't at this table." });

    if (b.action === "returned") {
      if (c.dead) return reply(409, { error: `${c.name} is still dead.` });
      await sbRest(`fallen_heroes?room_code=eq.${enc(roomCode)}&character_id=eq.${enc(characterId)}&returned=eq.false`, { method: "PATCH", body: { returned: true } });
      return reply(200, { ok: true });
    }

    if (!c.dead || !c.diedAt) return reply(409, { error: `${c.name} isn't dead.` });
    const diedAt = new Date(parseInt(c.diedAt, 10)).toISOString();
    const already = await sbRest(`fallen_heroes?room_code=eq.${enc(roomCode)}&character_id=eq.${enc(characterId)}&died_at=eq.${enc(diedAt)}&select=id`);
    if (already && already.length) return reply(200, { ok: true, already: true });

    const rooms = await sbRest(`rooms?code=eq.${enc(roomCode)}&select=meta`);
    const story = clean(rooms && rooms[0] && rooms[0].meta && rooms[0].meta.name, 80) || "an untitled story";
    let memorial = { achievement: "", epitaph: "" };
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const log = await sbRest(`log_entries?room_code=eq.${enc(roomCode)}&type=neq.note&order=created_at.desc&limit=40&select=author,text`);
        const logText = (log || []).reverse().map((e) => `${e.author}: ${clean(e.text, 400)}`).join("\n").slice(-9000);
        memorial = await writeMemorial(apiKey, c, story, logText);
      } catch (e) { console.warn("fallen: memorial not written:", e.message); }
    }
    if (!memorial.achievement) memorial.achievement = `Reached level ${parseInt(c.level, 10) || 1} in ${story}.`;

    try {
      await sbRest("fallen_heroes", { method: "POST", body: {
        room_code: roomCode, character_id: characterId, died_at: diedAt, name: clean(c.name, 60) || "A nameless hero",
        race: clean(c.race, 40), klass: clean(c.klass, 40), level: parseInt(c.level, 10) || 1, story,
        cause: c.deathCause === "massive" ? "struck down by a massive blow" : "fell after failing their death saves",
        achievement: memorial.achievement, epitaph: memorial.epitaph, owner_hash: /^[0-9a-f]{64}$/.test(c.ownerHash || "") ? c.ownerHash : null,
      } });
    } catch (e) {
      if (/\((409|23505)\)/.test(e.message)) return reply(200, { ok: true, already: true }); // recorded by another player's device
      throw e;
    }
    return reply(200, { ok: true, achievement: memorial.achievement, epitaph: memorial.epitaph });
  } catch (e) {
    console.error("fallen error:", e && e.message);
    return reply(503, { error: "The Hall of the Fallen can't be reached right now." });
  }
};

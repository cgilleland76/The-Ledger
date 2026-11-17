// netlify/functions/room-cleanup.js
//
// Scheduled (daily): deletes guest tables with no story activity for 30 days. Their characters and log
// go with them (cascade). A solo story paused with its story code in the last 30 days is kept, and
// account (signed-in) tables are never deleted. The rules live in the database:
// supabase/soft-launch.sql, cleanup_idle_rooms(). Uses the service-role key.
// The daily schedule is in netlify.toml. Netlify runs scheduled functions itself; browsers can't call them.

const billing = require("./lib/billing");

const IDLE_DAYS = 30;

async function cleanup(sbAdmin = billing.sbAdmin) {
  const removed = await sbAdmin("rpc/cleanup_idle_rooms", { method: "POST", body: { p_days: IDLE_DAYS } });
  return Number(removed) || 0;
}

exports.handler = async function () {
  try {
    const removed = await cleanup();
    console.log(`room-cleanup: deleted ${removed} guest table(s) idle for ${IDLE_DAYS}+ days`);
    return { statusCode: 200, body: JSON.stringify({ removed }) };
  } catch (e) {
    console.error("room-cleanup failed (has supabase/soft-launch.sql been run?):", e.message);
    return { statusCode: 500, body: "cleanup failed" };
  }
};
exports.cleanup = cleanup;
exports.IDLE_DAYS = IDLE_DAYS;


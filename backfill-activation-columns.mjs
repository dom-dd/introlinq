// One-off backfill for the ACTIVATION_V2 model (see api/dashboard.js).
// Populates publishers.activated_at / last_activity_at / last_script_activity_at
// from existing match_logs + click_logs history so the reminder cron and
// admin panel have correct state the moment ACTIVATION_V2 is switched on.
//
//   node backfill-activation-columns.mjs           # dry run, prints planned values
//   node backfill-activation-columns.mjs --apply   # write
//   node backfill-activation-columns.mjs --revert   # set all three columns back to NULL
//
// Safe to re-run. Only ever fills columns from real activity; --revert is
// the clean undo (nothing else reads these columns while ACTIVATION_V2 is off).

import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');

await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ`.catch(() => {});
await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`.catch(() => {});
await sql`ALTER TABLE publishers ADD COLUMN IF NOT EXISTS last_script_activity_at TIMESTAMPTZ`.catch(() => {});

if (REVERT) {
  const r = await sql`UPDATE publishers SET activated_at = NULL, last_activity_at = NULL, last_script_activity_at = NULL RETURNING slug`;
  console.log(`Reverted ${r.length} publishers (all three columns set to NULL).`);
  process.exit(0);
}

const minTs = (...xs) => xs.filter(Boolean).map(x => new Date(x)).sort((a, b) => a - b)[0] || null;
const maxTs = (...xs) => xs.filter(Boolean).map(x => new Date(x)).sort((a, b) => b - a)[0] || null;

const publishers = await sql`SELECT id, slug, first_widget_fire_at, last_widget_fire_at FROM publishers WHERE slug NOT LIKE 'demo-%'`;
const plan = [];

for (const p of publishers) {
  const [ml] = await sql`
    SELECT MIN(created_at) AS mn, MAX(created_at) AS mx
    FROM match_logs WHERE publisher = ${p.slug} AND is_bot = false AND source IN ('carousel','board')`.catch(() => [{}]);
  const [clkAll] = await sql`
    SELECT MAX(created_at) AS mx FROM click_logs WHERE publisher = ${p.slug} AND is_bot = false`.catch(() => [{}]);
  const [clkScript] = await sql`
    SELECT MIN(created_at) AS mn, MAX(created_at) AS mx
    FROM click_logs WHERE publisher = ${p.slug} AND is_bot = false AND traffic_source IN ('carousel','board')`.catch(() => [{}]);
  // A non-manual, non-embed click (widget Book button etc.) is script activity too.
  const [clkOther] = await sql`
    SELECT MIN(created_at) AS mn FROM click_logs
    WHERE publisher = ${p.slug} AND is_bot = false
      AND COALESCE(traffic_source,'') <> 'newsletter' AND COALESCE(phrase,'') <> 'newsletter'
      AND COALESCE(traffic_source,'') NOT IN ('carousel','board')`.catch(() => [{}]);
  // Manual link click only activates from the 2nd calendar day on - a lone
  // batch of signup-day self-tests shouldn't silence the reminder sequence.
  const [clkManual] = await sql`
    SELECT MIN(created_at) AS mn FROM click_logs c
    WHERE c.publisher = ${p.slug} AND c.is_bot = false
      AND (c.traffic_source = 'newsletter' OR c.phrase = 'newsletter')
      AND c.created_at::date > (
        SELECT MIN(created_at)::date FROM click_logs
        WHERE publisher = ${p.slug} AND is_bot = false AND (traffic_source = 'newsletter' OR phrase = 'newsletter')
      )`.catch(() => [{}]);

  const activated_at = minTs(p.first_widget_fire_at, ml?.mn, clkScript?.mn, clkOther?.mn, clkManual?.mn);
  const last_activity_at = maxTs(p.last_widget_fire_at, ml?.mx, clkAll?.mx);
  const last_script_activity_at = maxTs(p.last_widget_fire_at, ml?.mx, clkScript?.mx);

  if (!activated_at && !last_activity_at && !last_script_activity_at) continue;
  plan.push({ slug: p.slug, id: p.id, activated_at, last_activity_at, last_script_activity_at });
}

console.table(plan.map(r => ({
  slug: r.slug,
  activated_at: r.activated_at?.toISOString().slice(0, 10) || null,
  last_activity_at: r.last_activity_at?.toISOString().slice(0, 10) || null,
  last_script_activity_at: r.last_script_activity_at?.toISOString().slice(0, 10) || null,
})));

if (!APPLY) {
  console.log(`\nDry run - ${plan.length} publishers would be updated. Re-run with --apply to write.`);
  process.exit(0);
}

for (const r of plan) {
  await sql`
    UPDATE publishers SET
      activated_at = ${r.activated_at ? r.activated_at.toISOString() : null},
      last_activity_at = ${r.last_activity_at ? r.last_activity_at.toISOString() : null},
      last_script_activity_at = ${r.last_script_activity_at ? r.last_script_activity_at.toISOString() : null}
    WHERE id = ${r.id}`;
}
console.log(`\nApplied to ${plan.length} publishers.`);

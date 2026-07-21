import { neon } from '@neondatabase/serverless';

const OPENINTRO_API = 'https://open-intro.com/api/experts';

async function fetchAllExperts() {
  const res = await fetch(`${OPENINTRO_API}?key=${process.env.OPENINTRO_API_KEY}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenIntro API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.experts || [];
}

// OpenIntro's endpoint only ever returns public, approved, bookable experts -
// no status field to check, no filtering needed on our side (confirmed with
// them directly: "we can just assume that all experts we receive are good
// to go").
function mapExpert(raw, providerId) {
  return {
    provider_id: providerId,
    external_id: raw.id,
    name: raw.name || '',
    bio: raw.bio || '',
    description_long: raw.description_long || '',
    highlights: Array.isArray(raw.highlights) ? raw.highlights : [],
    photo_url: raw.photo_url || '',
    position: raw.position || '',
    company: raw.company || '',
    topics: Array.isArray(raw.tags) ? raw.tags : [],
    notable_categories: Array.isArray(raw.notable_categories) ? raw.notable_categories : [],
    services: Array.isArray(raw.services) ? raw.services : [],
    // OpenIntro doesn't capture this field yet - always [] for now.
    languages: Array.isArray(raw.languages) ? raw.languages : [],
    location_country: raw.location_country || '',
    price_from: typeof raw.price === 'number' ? raw.price : null,
    price_currency: raw.price_currency || 'GBP',
    booking_url: raw.booking_url || null,
    profile_url: raw.booking_url || null,
    raw_data: raw,
  };
}

export default async function handler(req, res) {
  if (req.query.key !== 'il2026') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Dry run: computes and returns exactly what would happen (matched /
  // inserted / removed, with names) without writing anything - use this
  // first to sanity-check the one-time ID migration before committing it.
  const dryRun = req.query.dry_run === 'true';

  try {
    const sql = neon(process.env.DATABASE_URL);

    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS position TEXT`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS company TEXT`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS description_long TEXT`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS services TEXT[] DEFAULT '{}'`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS highlights TEXT[] DEFAULT '{}'`;
    await sql`ALTER TABLE experts ADD COLUMN IF NOT EXISTS notable_categories TEXT[] DEFAULT '{}'`;
    // price_eur/usd/cad were fetched from the old Bubble sync but never
    // read anywhere else in the codebase - confirmed dead, and the new
    // OpenIntro platform only sends a single price + currency anyway.
    await sql`ALTER TABLE experts DROP COLUMN IF EXISTS price_eur`;
    await sql`ALTER TABLE experts DROP COLUMN IF EXISTS price_usd`;
    await sql`ALTER TABLE experts DROP COLUMN IF EXISTS price_cad`;

    const [provider] = await sql`SELECT id FROM providers WHERE slug = 'openintro'`;
    if (!provider) return res.status(500).json({ error: 'OpenIntro provider not found' });

    const rawExperts = await fetchAllExperts();
    const incoming = rawExperts.map(r => mapExpert(r, provider.id)).filter(e => e.name && e.external_id);
    const incomingIds = new Set(incoming.map(e => e.external_id));

    // Existing rows for this provider, so name-reconciliation can run
    // entirely in memory rather than one query per expert.
    const existingRows = await sql`SELECT id, external_id, name FROM experts WHERE provider_id = ${provider.id}`;
    const existingByExternalId = new Map(existingRows.map(r => [r.external_id, r]));
    // Only rows NOT already tied to some current incoming id are eligible
    // to be claimed by name - never steal a row that's already correctly
    // linked to a different expert in this same batch.
    const nameIndex = new Map(); // lowercased trimmed name -> [rows]
    for (const r of existingRows) {
      if (incomingIds.has(r.external_id)) continue;
      const key = r.name.trim().toLowerCase();
      if (!nameIndex.has(key)) nameIndex.set(key, []);
      nameIndex.get(key).push(r);
    }

    const claimedOldRowIds = new Set();
    const plan = { directMatch: [], nameReconciled: [], newInsert: [], ambiguousSkipped: [] };

    for (const e of incoming) {
      if (existingByExternalId.has(e.external_id)) {
        plan.directMatch.push({ name: e.name, external_id: e.external_id });
        continue;
      }
      const candidates = (nameIndex.get(e.name.trim().toLowerCase()) || []).filter(r => !claimedOldRowIds.has(r.id));
      if (candidates.length === 1) {
        claimedOldRowIds.add(candidates[0].id);
        plan.nameReconciled.push({ name: e.name, old_external_id: candidates[0].external_id, new_external_id: e.external_id, internal_id: candidates[0].id });
      } else if (candidates.length > 1) {
        plan.ambiguousSkipped.push({ name: e.name, matches: candidates.length });
      } else {
        plan.newInsert.push({ name: e.name, external_id: e.external_id });
      }
    }

    const toRemove = existingRows.filter(r => !incomingIds.has(r.external_id) && !claimedOldRowIds.has(r.id));

    if (dryRun) {
      return res.status(200).json({
        dry_run: true,
        total_fetched: rawExperts.length,
        total_current_in_db: existingRows.length,
        would_direct_match: plan.directMatch.length,
        would_reconcile_by_name: plan.nameReconciled,
        would_insert_new: plan.newInsert,
        would_remove: toRemove.map(r => ({ name: r.name, external_id: r.external_id })),
        ambiguous_skipped_as_new: plan.ambiguousSkipped,
      });
    }

    let inserted = 0, updated = 0, reconciled = 0;

    for (const e of incoming) {
      const existing = existingByExternalId.get(e.external_id);

      if (!existing) {
        // Re-derive from the plan computed above (not by re-filtering live
        // state) so the write phase matches exactly what the dry run - or
        // this same run's own plan - already decided. Renaming the old
        // row's external_id first means the INSERT...ON CONFLICT below
        // finds and updates that same row instead of creating a duplicate,
        // preserving its internal id (and every cached match pointing at it).
        const planned = plan.nameReconciled.find(p => p.name === e.name && p.new_external_id === e.external_id);
        if (planned) {
          await sql`UPDATE experts SET external_id = ${e.external_id} WHERE id = ${planned.internal_id}`;
          reconciled++;
        }
      }

      const [result] = await sql`
        INSERT INTO experts (
          provider_id, external_id, name, bio, description_long, highlights, photo_url,
          position, company, topics, notable_categories, services, languages, location_country,
          price_from, price_currency, booking_url, profile_url, active, raw_data, synced_at
        ) VALUES (
          ${e.provider_id}, ${e.external_id}, ${e.name}, ${e.bio}, ${e.description_long}, ${e.highlights},
          ${e.photo_url}, ${e.position}, ${e.company}, ${e.topics}, ${e.notable_categories}, ${e.services},
          ${e.languages}, ${e.location_country}, ${e.price_from}, ${e.price_currency},
          ${e.booking_url}, ${e.profile_url}, true, ${JSON.stringify(e.raw_data)}, NOW()
        )
        ON CONFLICT (provider_id, external_id) DO UPDATE SET
          name = EXCLUDED.name, bio = EXCLUDED.bio, description_long = EXCLUDED.description_long,
          highlights = EXCLUDED.highlights, photo_url = EXCLUDED.photo_url, position = EXCLUDED.position,
          company = EXCLUDED.company, topics = EXCLUDED.topics, notable_categories = EXCLUDED.notable_categories,
          services = EXCLUDED.services, languages = EXCLUDED.languages, location_country = EXCLUDED.location_country,
          price_from = EXCLUDED.price_from, price_currency = EXCLUDED.price_currency,
          booking_url = EXCLUDED.booking_url, profile_url = EXCLUDED.profile_url,
          active = true, raw_data = EXCLUDED.raw_data, synced_at = NOW()
        RETURNING (xmax = 0) AS is_insert
      `;
      if (result?.is_insert) inserted++; else updated++;
    }

    let deleted = 0;
    if (toRemove.length > 0) {
      const ids = toRemove.map(r => r.id);
      const deleted_result = await sql`DELETE FROM experts WHERE id = ANY(${ids}) RETURNING id`;
      deleted = deleted_result.length;
    }

    if (inserted > 0 || deleted > 0 || reconciled > 0) {
      await sql`UPDATE providers SET last_synced_at = NOW() WHERE id = ${provider.id}`;
    }

    return res.status(200).json({
      success: true,
      total_fetched: rawExperts.length,
      inserted, updated, reconciled, deleted,
    });
  } catch (err) {
    console.error('Sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}

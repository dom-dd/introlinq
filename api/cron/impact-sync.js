import { neon } from '@neondatabase/serverless';
import { notifyBooking, slackPing } from '../_bookingNotify.js';

/*
 * Reconciles Impact.com conversions ("actions") into IntroLinq bookings.
 *
 * Preply pays through Impact and Impact never calls us, so we pull. Every
 * outbound Preply click carries subId1=<publisher slug> and subId2=<click_id>
 * (api/dashboard.js, action=out); Impact echoes both back on the action, which
 * tells us which publisher to credit.
 *
 * An action's life on Impact: PENDING (Preply still reviewing / inside the
 * locking window) -> APPROVED (will pay out) or REVERSED (won't). We only
 * write a booking and tell the publisher once it is APPROVED - paying on
 * PENDING would mean telling someone they earned money that can still vanish.
 * A new PENDING action only pings Slack, so the team can see conversions land.
 *
 * impact_actions is the memory that makes every run idempotent: what we have
 * already alerted on and what we have already booked, per action.
 *
 * Runs daily from vercel.json. Manual run / rehearsal:
 *   GET /api/cron/impact-sync?dry=1&days=45   (Authorization: Bearer CRON_SECRET)
 * dry=1 fetches and reports what it WOULD do without writing or notifying.
 */

const IMPACT_HOST = 'https://api.impact.com';
const FIRST_RUN_DAYS = 45;      // Impact caps the last-update window at 45 days
const DEFAULT_LOOKBACK_DAYS = 7; // overlap so one failed run never loses a state change
const MAX_PAGES = 20;

async function ensureTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS impact_actions (
    action_id TEXT PRIMARY KEY,
    state TEXT,
    publisher TEXT,
    click_id TEXT,
    payout NUMERIC,
    amount NUMERIC,
    currency TEXT,
    event_date TIMESTAMPTZ,
    locking_date TIMESTAMPTZ,
    raw JSONB,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    pending_alerted BOOLEAN DEFAULT false,
    unattributed_alerted BOOLEAN DEFAULT false,
    reversal_alerted BOOLEAN DEFAULT false,
    booked BOOLEAN DEFAULT false
  )`;
}

async function fetchActions({ sid, token, startIso, endIso, fetchImpl }) {
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  let url = `${IMPACT_HOST}/Mediapartners/${encodeURIComponent(sid)}/Actions?StartDate=${encodeURIComponent(startIso)}&EndDate=${encodeURIComponent(endIso)}`;
  const actions = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const r = await fetchImpl(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Impact API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const body = await r.json();
    actions.push(...(body.Actions || []));
    const next = body['@nextpageuri'];
    url = next ? (String(next).startsWith('http') ? next : IMPACT_HOST + next) : null;
  }
  return actions;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const dateOrNull = (v) => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };
const money = (n, c) => `${c} ${num(n).toFixed(2)}`;

export async function runImpactSync({ sql, sid, token, days, dry = false, fetchImpl = fetch }) {
  await ensureTable(sql);

  const [{ n: seen }] = await sql`SELECT COUNT(*)::int AS n FROM impact_actions`;
  const lookback = days || (seen === 0 ? FIRST_RUN_DAYS : DEFAULT_LOOKBACK_DAYS);
  const end = new Date();
  const start = new Date(end.getTime() - lookback * 86400000);
  const actions = await fetchActions({ sid, token, startIso: start.toISOString(), endIso: end.toISOString(), fetchImpl });

  const publisherCache = new Map();
  async function getPublisher(slug) {
    if (!slug) return null;
    if (!publisherCache.has(slug)) {
      const [p] = await sql`SELECT slug, name, payment_email, COALESCE(revenue_share, 0.70) AS revenue_share FROM publishers WHERE slug = ${slug} AND active = true LIMIT 1`.catch(() => [null]);
      publisherCache.set(slug, p || null);
    }
    return publisherCache.get(slug);
  }

  const summary = { window_days: lookback, fetched: actions.length, dry, new_actions: 0, pending_alerts: 0, booked: 0, unattributed: 0, reversed_after_booking: 0, plan: [] };

  for (const a of actions) {
    const id = String(a.Id);
    const state = String(a.State || '').toUpperCase();
    const slug = String(a.SubId1 || '').trim() || null;
    const clickId = String(a.SubId2 || '').trim() || null;
    const payout = num(a.Payout);
    const currency = a.Currency || 'GBP';
    const provider = /preply/i.test(a.CampaignName || '') ? 'preply' : 'impact';
    const providerName = provider === 'preply' ? 'Preply' : (a.CampaignName || 'Impact');

    const [prev] = await sql`SELECT * FROM impact_actions WHERE action_id = ${id}`;
    if (!prev) summary.new_actions++;
    const flags = {
      pending: prev?.pending_alerted || false,
      unattributed: prev?.unattributed_alerted || false,
      reversal: prev?.reversal_alerted || false,
      booked: prev?.booked || false,
    };
    const pub = await getPublisher(slug);
    const step = { action_id: id, state, publisher: slug, payout: money(payout, currency), do: [] };

    // 1. Can't tell whose booking this is (no subId1, or a slug that isn't an active publisher).
    if (!pub && !flags.unattributed) {
      step.do.push('alert: unattributed');
      summary.unattributed++;
      if (!dry) {
        await slackPing(`⚠️ Impact ${providerName} conversion ${id} (${state}, ${money(payout, currency)}) has no matching publisher - subId1 was ${slug ? `"${slug}"` : 'empty'}. It needs attributing by hand; nobody will be paid for it automatically.`);
        flags.unattributed = true;
      }
    }

    if (pub) {
      // 2. New conversion still under review: visibility only, no booking.
      if (state === 'PENDING' && !flags.pending) {
        step.do.push('alert: pending');
        summary.pending_alerts++;
        if (!dry) {
          await slackPing(`⏳ New ${providerName} conversion pending on Impact - ${pub.name} (${pub.slug}) · ${money(payout, currency)}${a.LockingDate ? ` · locks ${String(a.LockingDate).slice(0, 10)}` : ''}. No payout until Impact approves it.`);
          flags.pending = true;
        }
      }

      // 3. Approved: it will really pay out, so book it and tell the publisher.
      if (state === 'APPROVED' && !flags.booked) {
        step.do.push('book + notify publisher');
        summary.booked++;
        if (!dry) {
          let expertName = 'a Preply tutor';
          let articleUrl = null, articleTitle = null;
          if (clickId) {
            const [c] = await sql`SELECT expert_name, article_url, article_title FROM click_logs WHERE click_id = ${clickId} LIMIT 1`.catch(() => [null]);
            if (c) { expertName = c.expert_name || expertName; articleUrl = c.article_url; articleTitle = c.article_title; }
          }
          const share = Number(pub.revenue_share);
          const publisherPayout = Math.round(payout * share * 100) / 100;
          const margin = Math.round((payout - publisherPayout) * 100) / 100;
          const inserted = await sql`
            INSERT INTO bookings (entry_type, provider, publisher, expert_name, booking_id, booking_amount, booking_currency, commission_amount, commission_currency, revenue_share, publisher_payout, introlinq_margin, raw_payload, booked_at)
            VALUES ('impact', ${provider}, ${pub.slug}, ${expertName}, ${'impact-' + id}, ${payout}, ${currency}, ${payout}, ${currency}, ${share}, ${publisherPayout}, ${margin}, ${JSON.stringify(a)}, ${dateOrNull(a.EventDate) || new Date()})
            ON CONFLICT (booking_id) DO NOTHING
            RETURNING id`;
          if (inserted.length > 0) {
            await notifyBooking({ publisher: { ...pub, revenue_share: share }, providerName, expertName, bookingAmount: payout, payout: publisherPayout, currency, articleUrl, articleTitle });
          }
          flags.booked = true;
        }
      }

      // 4. Reversed after we already paid it into the ledger: a human has to look.
      if (state === 'REVERSED' && flags.booked && !flags.reversal) {
        step.do.push('alert: reversed after booking');
        summary.reversed_after_booking++;
        if (!dry) {
          await slackPing(`🚨 Impact ${providerName} conversion ${id} was REVERSED after it was booked for ${pub.name} (${money(payout, currency)}). Check the bookings ledger before the next payout.`);
          flags.reversal = true;
        }
      }
    }

    if (step.do.length) summary.plan.push(step);

    if (!dry) {
      await sql`
        INSERT INTO impact_actions (action_id, state, publisher, click_id, payout, amount, currency, event_date, locking_date, raw, last_seen_at, pending_alerted, unattributed_alerted, reversal_alerted, booked)
        VALUES (${id}, ${state}, ${slug}, ${clickId}, ${payout}, ${num(a.Amount)}, ${currency}, ${dateOrNull(a.EventDate)}, ${dateOrNull(a.LockingDate)}, ${JSON.stringify(a)}, NOW(), ${flags.pending}, ${flags.unattributed}, ${flags.reversal}, ${flags.booked})
        ON CONFLICT (action_id) DO UPDATE SET
          state = EXCLUDED.state, publisher = EXCLUDED.publisher, click_id = EXCLUDED.click_id,
          payout = EXCLUDED.payout, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
          event_date = EXCLUDED.event_date, locking_date = EXCLUDED.locking_date, raw = EXCLUDED.raw,
          last_seen_at = NOW(), pending_alerted = EXCLUDED.pending_alerted,
          unattributed_alerted = EXCLUDED.unattributed_alerted, reversal_alerted = EXCLUDED.reversal_alerted,
          booked = EXCLUDED.booked`;
    }
  }

  return summary;
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  if (!sid || !token) {
    return res.status(200).json({ skipped: 'IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN not set' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const dry = ['1', 'true'].includes(String(req.query?.dry || ''));
  const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 0, 0), FIRST_RUN_DAYS) || undefined;

  try {
    const summary = await runImpactSync({ sql, sid, token, days, dry });
    return res.status(200).json(summary);
  } catch (err) {
    console.error('impact-sync failed:', err);
    await slackPing(`🚨 Impact sync failed: ${String(err.message || err).slice(0, 300)}`);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

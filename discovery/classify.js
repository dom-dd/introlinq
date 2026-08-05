// Classifies each candidate as a "publisher" (independent blog/content site -
// good widget partner) or "vendor" (company selling a product/service whose
// blog is marketing content - potentially a better fit as a listed expert
// than a publisher partner), plus a one-word service keyword for vendors.
//
// Uses only the title/snippet already stored from discovery (no extra
// crawling), batched across many candidates per API call to keep cost low.
//
// Usage: node discovery/classify.js

import { sql } from './lib/db.js';
import { enrichPendingPublishers } from './enrich.js';
import { CATEGORIES } from './lib/categories.js';

const BATCH_SIZE = 15;
// Apollo credits are real money per lead. This caps the auto-cascade below so
// a large classify run (or a large pre-existing backlog) can't spend an
// unbounded number of credits in one go - re-run classify.js again to pick up
// any publisher leads left over past this cap.
const ENRICH_LIMIT = 500;
const VALID_LEAD_TYPES = new Set(['publisher', 'vendor', 'competitor', 'unclear']);
const VALID_TEAM_SIZES = new Set(['solo', 'small-team', 'large-team', 'unclear']);
// Matches admin/index.html's outreach OUTREACH_STATUS_LABELS keys - these
// three are the only ones this classifier ever suggests. 'important' is
// explicitly a human-only call (Dom's own judgment on "needs a deliberate
// approach later"), never auto-applied. Not to be confused with CATEGORIES
// above (the content-topic taxonomy - Music, Finance, etc.) - different
// concept, deliberately different name to avoid confusing the two.
const VALID_SPECIAL_STATUSES = new Set(['partner', 'openintro_partner', 'products_partner']);

async function ensureColumns() {
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS lead_type TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS service_keyword TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS team_size TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS company_name TEXT`;
  await sql`ALTER TABLE candidate_publishers ADD COLUMN IF NOT EXISTS category TEXT`;
}

async function classifyBatch(rows) {
  const list = rows.map((r, i) =>
    `${i + 1}. domain: ${r.domain} | title: "${(r.title || '').slice(0, 150)}" | snippet: "${(r.snippet || '').slice(0, 200)}"`
  ).join('\n');

  const prompt = `You are classifying leads for a blog outreach campaign for IntroLinq, a platform that lets blog readers book 1:1 calls with vetted experts - not just startup/business experts, the network spans many categories (business, finance, health, music, art, real estate, and more - see the category list below).

For each website below, classify it as a lead:
- "publisher": an independent blog, magazine, or content site whose main purpose is publishing articles for readers - NOT a large company's blog/insights section that exists to build authority or SEO for their own separate product or brand, even when an individual article reads like generic educational content with no obvious pitch in it. A large, well-known company is very unlikely to add a third-party widget promoting outside experts to their pages regardless of how independent one article sounds - team size and overall site identity matter more here than any single article's wording. Good candidate to embed IntroLinq's widget as a publisher partner.
- "vendor": a company selling a specific product or service (SaaS tool, agency, consultancy, software) where the blog exists primarily to market that product/service. Not a great publisher partner, but the company's founder/team could be a good EXPERT to list on IntroLinq instead.
- "competitor": the company's core PRODUCT (not just its content/blog topics) is built around connecting founders with outside experts, mentors, advisors, coaches, or investors - whether that's booking/matching (e.g. Clarity.fm, GrowthMentor, MentorCruise), investor/VC discovery and matching (e.g. OpenVC), or managing/reporting on those relationships (e.g. Visible.vc, an investor-updates tool). These overlap with what IntroLinq does. Do NOT classify accelerators (e.g. Y Combinator), VC funds themselves, or general startup media/publications as competitors just because they discuss mentorship, advisors, or funding in their articles - only flag this when the company's actual PRODUCT is the connection/matching/relationship-management tool itself, not when it's merely content about those topics.
- "unclear": genuinely can't tell from the title/snippet given.

Note: many "write for us" pages could theoretically be paid guest-post/backlink-selling operations rather than real publications - but that distinction needs actual page content (pricing, Domain Authority mentions) that isn't reliably visible in a short search snippet. Do NOT guess at this from title/snippet alone - classify as "publisher" unless you have strong specific evidence otherwise.

If "vendor", also give a "service_keyword": ONE short word or hyphenated term for what they sell (e.g. SEO, CRM, automation, accounting-software, marketing-agency, web-hosting, recruiting, legal-services, insurance, email-marketing). Use null otherwise.

Also estimate "team_size" from the title/snippet wording:
- "solo": phrasing suggests one person writing (first-person "I/my", a personal name as the brand, freelancer/consultant voice)
- "small-team": phrasing suggests a small team or boutique operation (a few named people, small agency, small company blog)
- "large-team": phrasing suggests a media brand, large company, or large editorial team
- "unclear": genuinely can't tell from the title/snippet alone
This is a rough guess from limited text, not a confident read - best-effort only.

Also give a "company_name": the clean, human-readable brand or company name for this site - not the article/page title. Titles often follow an "Article headline | Brand Name" or "Article headline - Brand Name" pattern; pull the brand name from that suffix when present. When there's no such suffix, infer a reasonable name from the domain itself (e.g. "smallbizhub.com" -> "SmallBizHub" or "Small Biz Hub", whichever reads more naturally), capitalized properly, no taglines or slogans. Always provide your best guess - never null.

Finally, assess whether this lead fits one of three special outreach categories - these are separate from lead_type above, and get flagged for a different kind of follow-up:

- "partner": the company IS what "competitor" above describes - its core product is an expert/advisor marketplace connecting people with MULTIPLE outside experts they can book, in any field (Clarity.fm, GrowthMentor, MentorCruise-style). Unlike lead_type, this isn't "avoid" - it's "IntroLinq could list their experts too, on a commission or pay-per-click basis." A lead classified "competitor" above is very often also "partner" here.
- "openintro_partner": an ORGANIZATION - not necessarily a software product - that represents or aggregates MULTIPLE experts/speakers as part of its identity: a large event/conference (web-summit style), a community, an incubator, an accelerator, or a speaking agency. These would benefit from a branded booking page (OpenIntro already runs pages like this for existing partners, e.g. open-intro.com/partner/pomona-partners) where people book that organization's people directly.
- "products_partner": the company IS what "vendor" above describes - it sells a specific PRODUCT (CRM, SaaS tool, office space, software - not a service/agency). No fit for IntroLinq's expert-matching model today, but a plausible future pay-per-click or monthly-fee partner for product recommendations embedded in blog content ("You need an office space" -> their site). Dropbox is a good example of the type.

Give "suggested_category": one of "partner", "openintro_partner", "products_partner", or null. Only pick one of the three when you have real, specific evidence in the title/snippet that it fits - if you're unsure or it's a plain "publisher"/"unclear" lead with no such evidence, use null rather than guessing.

Also give a "category": which ONE of these topic categories the site's content is actually about - this is a completely different thing from suggested_category above (that's about outreach type; this is about subject matter): ${CATEGORIES.map((c) => `"${c}"`).join(', ')}. Pick "Other" if the content doesn't fit any of the rest, and your best single guess if it spans more than one - never null, always pick one.

Sites:
${list}

"lead_type" must be EXACTLY one of these four words, nothing else: publisher, vendor, competitor, unclear. Never put a team_size value like "solo" in the lead_type field.

Return ONLY valid JSON, no other text, in the same order as listed:
{"results":[{"domain":"...","lead_type":"publisher|vendor|competitor|unclear","service_keyword":"..."|null,"team_size":"solo|small-team|large-team|unclear","company_name":"...","suggested_category":"partner|openintro_partner|products_partner"|null,"category":"..."}]}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '{"results":[]}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : { results: [] };
  }
  return parsed.results || [];
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to discovery/.env.local');
  }

  await ensureColumns();

  const rows = await sql`
    SELECT id, domain, title, snippet, status FROM candidate_publishers
    WHERE lead_type IS NULL
    ORDER BY id ASC
  `;
  console.log(`Classifying ${rows.length} candidates in batches of ${BATCH_SIZE}...`);

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const byDomain = Object.fromEntries(batch.map((r) => [r.domain, r]));

    try {
      const results = await classifyBatch(batch);
      for (const res of results) {
        const row = byDomain[res.domain];
        if (!row) continue;

        let leadType = res.lead_type;
        let teamSize = res.team_size;
        // Guard against the model writing a team_size word into lead_type
        // (seen with very obviously personal blogs, e.g. lead_type: "solo").
        if (!VALID_LEAD_TYPES.has(leadType)) {
          console.warn(`  WARN: invalid lead_type "${leadType}" for ${res.domain}, correcting`);
          if (VALID_TEAM_SIZES.has(leadType)) {
            teamSize = teamSize && VALID_TEAM_SIZES.has(teamSize) ? teamSize : leadType;
            leadType = 'publisher';
          } else {
            leadType = 'unclear';
          }
        }
        if (!VALID_TEAM_SIZES.has(teamSize)) teamSize = 'unclear';
        const suggestedStatus = VALID_SPECIAL_STATUSES.has(res.suggested_category) ? res.suggested_category : null;
        const topicCategory = CATEGORIES.includes(res.category) ? res.category : null;

        // A manually-created lead (see admin's "Create a lead") can have
        // lead_type IS NULL (so it shows up in this query) while already
        // carrying a real status Dom picked on purpose - only apply the
        // suggested category when status is still the untouched table
        // default, never overwrite anything else.
        const newStatus = (suggestedStatus && row.status === 'discovered') ? suggestedStatus : row.status;

        await sql`
          UPDATE candidate_publishers
          SET lead_type = ${leadType}, service_keyword = ${res.service_keyword || null}, team_size = ${teamSize},
              company_name = ${(res.company_name || '').trim() || null},
              category = ${topicCategory},
              status = ${newStatus}
          WHERE id = ${row.id}
        `;
        done++;
      }
      console.log(`  batch ${Math.floor(i / BATCH_SIZE) + 1}: classified ${results.length}/${batch.length}`);
    } catch (err) {
      console.error(`  batch ${Math.floor(i / BATCH_SIZE) + 1} FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${done}/${rows.length} candidates classified.`);

  console.log('\nCascading into Apollo enrichment for publisher leads...');
  const { found, notFound, noEmail, processed } = await enrichPendingPublishers({ limit: ENRICH_LIMIT });
  if (processed === 0) {
    console.log('Nothing pending enrichment.');
  } else {
    console.log(`Enrichment done. ${found} found, ${noEmail} matched but no email, ${notFound} no person found.`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

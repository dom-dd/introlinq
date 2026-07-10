# Business Publisher Discovery

Finds business blogs/publishers to reach out to about IntroLinq. Lives in its
own folder, writes to its own database tables (`candidate_publishers`,
`discovery_queries`) in the same Neon Postgres database the main app uses.
Runs as a standalone script - never touches Vercel, never affects the live
widget/API.

## Setup

1. `cp discovery/.env.local.example discovery/.env.local`
2. Fill in `DATABASE_URL` (same one the main app uses - check Vercel env vars),
   `SERPAPI_KEY` (from https://serpapi.com/manage-api-key), `ANTHROPIC_API_KEY`
   (for classify.js), and `APOLLO_API_KEY` (from https://developer.apollo.io,
   for enrich.js)
3. From the repo root: `npm install` (adds `dotenv`, already in root `package.json`)

## Run

```
node discovery/discover.js --target 500
```

Generates search queries (niche topic x intent combinations, e.g. "SaaS
marketing write for us", "franchise business guest post"), runs them through
SerpAPI, extracts candidate domains from the organic results, and stores new
ones in `candidate_publishers`. Stops once `target` unique domains have been
collected, or once every generated query has been used.

Broad head terms like "business blog" or "business articles" get dominated
by Google's highest-authority results - CNN, Forbes, Bloomberg, government
resource pages, "50 best blogs" roundup listicles - none of which are
independent blogs you can pitch. Two things counter that (see
`discovery/lib/queries.js` and `discovery/lib/serpapi.js`):

- **Niche topics, not broad ones** - ~50 specific subjects (SaaS marketing,
  franchise business, proptech, etc.) instead of single broad words, so big
  media doesn't dominate the search results
- **Intent priority** - "write for us" / "guest post" / "submit article"
  queries run first, since they inherently surface sites soliciting outside
  contributors (i.e. real, reachable blogs). Broader intents like "articles"
  or "resources" run last and are more likely to surface institutional pages
- **Filtering** - a blacklist of major news domains, publishing platforms
  (medium.com, sites.google.com, etc.), `.gov`/`.edu`/`.ac.uk`-style
  institutional TLDs, and a listicle-title detector ("50 Best Business
  Blogs", "Top 12 Guest Post Sites") all run before a domain is stored

Try a small target first (e.g. `--target 50`) to confirm your SerpAPI key
works and check the SERP account isn't over quota before committing to a
larger run.

## Resuming

All progress lives in Postgres. If a run is interrupted (Ctrl+C, crash,
closed terminal), just run the same command again - queries already marked
`done` are skipped, and `ON CONFLICT DO NOTHING` means a domain already
in `candidate_publishers` is never touched twice.

## Scaling up

To go from hundreds to hundreds of thousands of candidates without changing
the architecture:

- Extend `TOPICS`/`PRIORITY_INTENTS`/`SECONDARY_INTENTS` in
  `discovery/lib/queries.js`, or add a third dimension (e.g. modifiers like
  "2025") to multiply combinations
- Just increase `--target` - the query pool auto-expands and the loop keeps
  pulling pending queries until the target is hit or the pool runs out
- Later discovery sources (Common Crawl, RSS directories, sitemaps) can be
  added as new files in `discovery/lib/` that produce the same
  `{ domain, homepage_url, title, snippet }` shape `insertCandidates`
  expects - `discover.js` doesn't need to change

## Classifying leads

```
node discovery/classify.js
```

Uses Claude (Haiku) to read each candidate's title/snippet and classify it
as `publisher` (good widget partner), `vendor` (better fit as a listed
expert than a partner), `competitor` (booking/mentor-matching platforms -
kept in the table for visibility, not deleted), or `unclear`. Also assigns
a rough `team_size` (`solo` / `small-team` / `large-team` / `unclear`),
which `enrich.js` uses to pick which job title to search for.

Well-known brands (e.g. Y Combinator) are occasionally misclassified as
`competitor` because the model draws on background knowledge about the
brand rather than judging from the snippet alone - spot-check famous names
manually.

## Finding contacts (Apollo)

```
node discovery/enrich.js --dry-run       # preview matches, no credits spent
node discovery/enrich.js --limit 20      # enrich a small batch first
node discovery/enrich.js --limit 500     # scale up once you trust it
```

Only enriches `lead_type: 'publisher'` leads - vendor/competitor/unclear are
skipped, since the outreach pitch (embed the widget) only applies to
publishers. For each one, searches Apollo for a person at that domain
matching a role-appropriate title based on `team_size` (see `titlesForRow`
in `discovery/lib/apollo.js`):

- `team_size: solo` -> Founder/Owner/Editor/Writer
- `team_size: large-team` -> Editor in Chief/Content Lead/Editor
- small-team/unclear -> Editor/Content Manager/Founder/CEO

People Search itself is free. Only the follow-up email-reveal call spends
an Apollo credit, and only runs when a person was actually found - so
`--dry-run` lets you sanity-check title/domain matches before spending
anything. Resumable like the rest of the pipeline: only rows with
`contact_status IS NULL` are processed, so re-running picks up where you
left off.

`competitor` and `unclear` leads are skipped - not worth enrichment credits.

## What's NOT built yet

Crawling each site for deeper metadata, traffic/priority scoring, or
syncing to a Google Sheet. Those come next if/when needed.

## Schema

`candidate_publishers` - one row per unique domain found
- `status`: `discovered` (default) - later phases will add `crawled`,
  `classified`, `contacted`, `rejected`, `promoted`
- `priority_score` / `estimated_monthly_visits`: placeholder columns for
  when a traffic-data source (SimilarWeb, Ahrefs, etc.) is wired in later

Added by `classify.js`: `lead_type`, `service_keyword`, `team_size`.

Added by `enrich.js`: `contact_first_name`, `contact_last_name`,
`contact_email`, `contact_title`, `contact_status` (`found` / `no_email` /
`not_found` / `error`).

`discovery_queries` - tracks every generated search query and its status
(`pending` / `done` / `failed`), so runs are resumable and queries are never
re-run needlessly.

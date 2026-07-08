# Business Publisher Discovery

Finds business blogs/publishers to reach out to about IntroLinq. Lives in its
own folder, writes to its own database tables (`candidate_publishers`,
`discovery_queries`) in the same Neon Postgres database the main app uses.
Runs as a standalone script - never touches Vercel, never affects the live
widget/API.

## Setup

1. `cp discovery/.env.local.example discovery/.env.local`
2. Fill in `DATABASE_URL` (same one the main app uses - check Vercel env vars)
   and `SERPAPI_KEY` (from https://serpapi.com/manage-api-key)
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

## What's NOT built yet

This is discovery only - finding and storing candidate domains. Not yet
built: crawling each site for metadata, contact discovery (emails, names,
roles), AI classification, traffic/priority scoring, or syncing to a Google
Sheet. Those come next once this step is proven out.

## Schema

`candidate_publishers` - one row per unique domain found
- `status`: `discovered` (default) - later phases will add `crawled`,
  `classified`, `contacted`, `rejected`, `promoted`
- `priority_score` / `estimated_monthly_visits`: placeholder columns for
  when a traffic-data source (SimilarWeb, Ahrefs, etc.) is wired in later

`discovery_queries` - tracks every generated search query and its status
(`pending` / `done` / `failed`), so runs are resumable and queries are never
re-run needlessly.

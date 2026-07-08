// Search query generation for discovering business blogs/publishers.
// Combines topics x intents into search queries rather than hardcoding a
// fixed list. To scale up later (10k -> 100k -> 1M candidates), extend
// these arrays or add a third dimension (e.g. modifiers) - the rest of the
// pipeline doesn't need to change.
//
// Broad head terms like "business blog" or "business news" get dominated by
// Google's highest-authority results - CNN, Forbes, Bloomberg, government
// resource pages, "50 best blogs" roundup listicles - none of which are
// independent blogs you can actually pitch. Two things counter that:
//   1. Niche, long-tail topics instead of single broad words - specific
//      subjects don't have the same big-media competition for search rank.
//   2. Intent priority - "write for us" / "guest post" queries inherently
//      surface sites soliciting outside contributors (i.e. real, reachable
//      blogs), so those run before broader intents like "articles"/"news".

export const TOPICS = [
  'business', 'startup', 'finance', 'marketing', 'leadership', 'accounting',
  'consulting', 'manufacturing', 'small business', 'legal', 'technology',
  'entrepreneurship', 'sales', 'e-commerce', 'HR', 'operations', 'logistics',
  'real estate', 'venture capital', 'product management', 'branding',
  'SaaS', 'SaaS marketing', 'B2B sales', 'B2B marketing', 'digital marketing agency',
  'freelancing', 'business coaching', 'executive coaching', 'bookkeeping',
  'tax planning', 'supply chain', 'procurement', 'project management',
  'recruiting', 'talent acquisition', 'workplace culture', 'remote work',
  'fintech', 'proptech', 'edtech', 'insurtech', 'healthtech',
  'restaurant management', 'retail management', 'hospitality management',
  'nonprofit management', 'franchise business', 'career development',
  'personal finance for entrepreneurs', 'customer success', 'growth marketing',
  'e-commerce logistics', 'supply chain management', 'manufacturing operations',
  'construction business', 'agency management', 'small business finance'
];

// Tier A: reliably surfaces independent blogs actively seeking outside
// contributors - the actual reachable leads. Run first.
export const PRIORITY_INTENTS = [
  'write for us', 'guest post', 'submit article', 'guest author', 'contribute', 'guest blogger'
];
// Tier B: broader and useful, but more likely to surface big media brands
// or institutional resource pages. Run after Tier A is exhausted.
export const SECONDARY_INTENTS = [
  'blog', 'insights', 'guides', 'tips', 'articles', 'resources'
];

export function generateQueries({ topics = TOPICS, priorityIntents = PRIORITY_INTENTS, secondaryIntents = SECONDARY_INTENTS } = {}) {
  const queries = [];
  for (const intent of priorityIntents) {
    for (const topic of topics) {
      queries.push(`${topic} ${intent}`);
    }
  }
  for (const intent of secondaryIntents) {
    for (const topic of topics) {
      queries.push(`${topic} ${intent}`);
    }
  }
  return queries;
}

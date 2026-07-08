// Search query generation for discovering business blogs/publishers.
// Combines topics x intents into search queries rather than hardcoding a
// fixed list. To scale up later (10k -> 100k -> 1M candidates), extend
// these arrays or add a third dimension (e.g. modifiers) - the rest of the
// pipeline doesn't need to change.
//
// Broad head terms like "business blog" or "business news" get dominated by
// Google's highest-authority results - CNN, Forbes, Bloomberg, government
// resource pages, "50 best blogs" roundup listicles - none of which are
// independent blogs you can actually pitch. Countered by using niche,
// long-tail topics instead of single broad words.
//
// Two distinct discovery tracks, interleaved so a run samples both:
//   - "write for us" style: surfaces sites that explicitly solicit outside
//     contributors - reliably reachable, but this selects for openness to
//     guest content, not for being small/independent. Some of these turn
//     out to be content-marketing operations running guest-post programs.
//   - plain "blog" style: a broader net that has a better chance of
//     surfacing solo/small-team bloggers who write everything themselves
//     and never bothered with a "submit an article" page. Noisier - relies
//     more on the domain blacklist and classify.js to filter out junk.

// Deliberately narrow to the startup/founder journey - matching what
// IntroLinq's expert network actually covers - rather than generic business
// categories. A wide net ("finance", "business coaching", "legal") pulled in
// unrelated industries (payday loan companies via "finance") and even direct
// competitors (mentor/coaching marketplaces via "business coaching").
export const TOPICS = [
  'startup', 'startup founder', 'first-time founder', 'entrepreneurship',
  'venture capital', 'fundraising', 'seed funding', 'series A funding',
  'startup growth', 'product-market fit', 'go-to-market strategy',
  'SaaS startup', 'B2B SaaS', 'tech startup', 'bootstrapping',
  'startup leadership', 'startup hiring', 'startup team building',
  'startup marketing', 'growth marketing', 'startup sales',
  'customer acquisition', 'startup branding', 'startup operations',
  'solopreneur', 'indie hacker', 'startup culture', 'remote startup team',
  'startup finance', 'cap table', 'startup pitch deck', 'startup exit',
  'scaling a startup', 'founder wellbeing', 'startup community',
  'small business growth', 'small business owner'
];

// Track A: reliably surfaces reachable blogs open to outside contributors.
export const GUEST_POST_INTENTS = [
  'write for us', 'guest post', 'submit article', 'guest author', 'contribute', 'guest blogger'
];
// Track B: direct "is this a blog" signal - better chance of surfacing
// solo/small-team blogs, at the cost of more noise.
export const DIRECT_BLOG_INTENTS = ['blog'];
// Track C: broadest and most noise-prone - runs only after A and B are
// exhausted (rarely reached at small --target values).
export const SECONDARY_INTENTS = ['insights', 'guides', 'tips', 'articles', 'resources'];

export function generateQueries({
  topics = TOPICS,
  guestPostIntents = GUEST_POST_INTENTS,
  directBlogIntents = DIRECT_BLOG_INTENTS,
  secondaryIntents = SECONDARY_INTENTS
} = {}) {
  const guestPost = [];
  for (const intent of guestPostIntents) {
    for (const topic of topics) guestPost.push(`${topic} ${intent}`);
  }
  const directBlog = [];
  for (const intent of directBlogIntents) {
    for (const topic of topics) directBlog.push(`${topic} ${intent}`);
  }
  const secondary = [];
  for (const intent of secondaryIntents) {
    for (const topic of topics) secondary.push(`${topic} ${intent}`);
  }

  // Interleave A and B so even a small --target run samples both tracks
  // instead of exhausting "write for us" before ever trying plain "blog".
  const interleaved = [];
  const maxLen = Math.max(guestPost.length, directBlog.length);
  for (let i = 0; i < maxLen; i++) {
    if (guestPost[i]) interleaved.push(guestPost[i]);
    if (directBlog[i]) interleaved.push(directBlog[i]);
  }

  return [...interleaved, ...secondary];
}

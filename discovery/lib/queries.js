// Search query generation for discovering blogs/publishers across every
// category IntroLinq's expert network can actually match against (see
// lib/categories.js) - not just startup/business. Combines topics x intents
// into search queries rather than hardcoding a fixed list. To scale up
// later (10k -> 100k -> 1M candidates), extend these arrays or add a third
// dimension (e.g. modifiers) - the rest of the pipeline doesn't need to
// change.
//
// Broad head terms like "business blog" or "art blog" get dominated by
// Google's highest-authority results - CNN, Forbes, major magazines,
// "50 best blogs" roundup listicles - none of which are independent blogs
// you can actually pitch. Countered by using niche, long-tail topics
// instead of single broad words, same reasoning per category.
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

import { CATEGORIES } from './categories.js';

// Each category's topics are long-tail on purpose (see file header). A wide
// net of single broad words ("finance", "business coaching") previously
// pulled in unrelated industries (payday loan companies via "finance") and
// even direct competitors (mentor/coaching marketplaces via "business
// coaching") - the same trap applies to every category here, not just
// business.
export const TOPICS_BY_CATEGORY = {
  'Business & Entrepreneurship': [
    'startup', 'startup founder', 'first-time founder', 'entrepreneurship',
    'venture capital', 'fundraising', 'seed funding', 'series A funding',
    'startup growth', 'product-market fit', 'go-to-market strategy',
    'SaaS startup', 'B2B SaaS', 'tech startup', 'bootstrapping',
    'startup leadership', 'startup hiring', 'startup team building',
    'startup sales', 'customer acquisition', 'startup branding', 'startup operations',
    'solopreneur', 'indie hacker', 'startup culture', 'remote startup team',
    'startup finance', 'cap table', 'startup pitch deck', 'startup exit',
    'scaling a startup', 'founder wellbeing', 'startup community',
    'small business growth', 'small business owner',
  ],
  'Marketing & Sales': [
    'content marketing', 'email marketing tips', 'social media marketing',
    'SEO strategy', 'marketing automation', 'sales funnel', 'lead generation',
    'affiliate marketing', 'influencer marketing', 'copywriting tips',
    'brand strategy', 'marketing analytics', 'growth marketing', 'startup marketing',
    'conversion rate optimization', 'community marketing',
  ],
  'Finance & Investing': [
    'personal finance blog', 'investing for beginners', 'stock market tips',
    'retirement planning', 'budgeting tips', 'passive income ideas',
    'real estate investing', 'cryptocurrency investing', 'financial independence',
    'debt payoff journey', 'saving money tips', 'tax planning tips',
    'dividend investing', 'frugal living',
  ],
  'Technology & Product': [
    'software development blog', 'web development tips', 'product design blog',
    'UX design tips', 'AI tools review', 'no-code tools', 'app development blog',
    'tech reviews blog', 'programming tutorials', 'open source projects',
    'developer productivity', 'indie software maker',
  ],
  'Legal': [
    'small business law blog', 'contract law tips', 'intellectual property blog',
    'employment law blog', 'legal advice blog', 'startup legal tips',
  ],
  'Health & Medicine': [
    'health tips blog', 'nutrition advice blog', 'mental health blog',
    'wellness tips blog', 'medical advice blog', 'healthy living blog',
    'chronic illness blog', 'holistic health blog', 'gut health blog',
  ],
  'Fitness & Wellness': [
    'fitness tips blog', 'workout routines blog', 'yoga blog', 'running tips blog',
    'strength training blog', 'weight loss journey blog', 'mindfulness practice blog',
    'home workout blog', 'marathon training blog',
  ],
  'Music': [
    'music production tips', 'songwriting advice blog', 'music industry blog',
    'indie music blog', 'music gear reviews', 'music theory blog', 'DJ tips blog',
    'music career advice', 'home studio recording blog',
  ],
  'Art & Design': [
    'graphic design tips blog', 'illustration blog', 'art tutorials blog',
    'design inspiration blog', 'creative process blog', 'digital art blog',
    'interior design blog', 'photography tips blog', 'freelance design blog',
  ],
  'Media & Entertainment': [
    'film review blog', 'tv show reviews blog', 'pop culture blog',
    'entertainment news blog', 'streaming reviews blog', 'gaming blog',
    'anime blog', 'book review blog',
  ],
  'Education & Coaching': [
    'online teaching tips', 'life coaching blog', 'career coaching advice',
    'study tips blog', 'homeschooling blog', 'e-learning tips blog',
    'tutoring advice blog', 'executive coaching blog',
  ],
  'Real Estate': [
    'real estate investing tips', 'home buying advice blog', 'property management blog',
    'real estate agent blog', 'real estate market trends', 'first-time homebuyer blog',
  ],
  Other: [
    'travel blog tips', 'food blog recipes', 'parenting advice blog',
    'personal style blog', 'home improvement DIY blog', 'pet care blog',
    'sports commentary blog', 'sustainable living blog', 'productivity tips blog',
    'minimalism blog', 'digital nomad blog', 'wedding planning blog',
  ],
};

// Flattened list of every topic across every category - generateQueries
// defaults to this so a normal run samples all of them, not just business.
export const TOPICS = Object.values(TOPICS_BY_CATEGORY).flat();

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

// generateQueries() interleaves guest-post and direct-blog tracks but
// doesn't group by category - a run can end up heavy on whichever category
// happens to sort first. This instead interleaves CATEGORIES round-robin
// (one query from each category in turn), so even a small --target run
// samples breadth across topics rather than exhausting Business first.
export function generateQueriesByCategory(categories = CATEGORIES) {
  const perCategory = categories.map((cat) =>
    generateQueries({ topics: TOPICS_BY_CATEGORY[cat] || [] })
  );
  const maxLen = Math.max(...perCategory.map((q) => q.length));
  const result = [];
  for (let i = 0; i < maxLen; i++) {
    for (const queries of perCategory) {
      if (queries[i]) result.push(queries[i]);
    }
  }
  return result;
}

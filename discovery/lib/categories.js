// Keep this in sync with api/suggest-expert.js's CATEGORIES - a blog's
// category should map to the same taxonomy OpenIntro's expert roster is
// organized by, since that's what actually determines whether a match is
// possible. Duplicated rather than imported since discovery/ and api/ are
// separate deployment contexts (Vercel only bundles api/).
export const CATEGORIES = [
  'Business & Entrepreneurship', 'Marketing & Sales', 'Finance & Investing',
  'Technology & Product', 'Legal', 'Health & Medicine', 'Fitness & Wellness',
  'Music', 'Art & Design', 'Media & Entertainment', 'Education & Coaching',
  'Real Estate', 'Other',
];

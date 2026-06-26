import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { article } = req.body;
  if (!article || article.trim().length < 50) {
    return res.status(400).json({ error: 'Article text is too short' });
  }

  try {
    const sql = neon(process.env.DATABASE_URL);
    const experts = await sql`
      SELECT id, name, bio, description_long, photo_url, position, company,
             topics, services, languages, price_from, price_currency,
             booking_url, location_country
      FROM experts
      WHERE active = true
      ORDER BY id
    `;

    if (experts.length === 0) {
      return res.status(200).json({ matches: [] });
    }

    const expertsList = experts.map(e => {
      const role = [e.position, e.company].filter(Boolean).join(' at ');
      const langs = (e.languages || []).join(', ');
      const desc = e.description_long || e.bio || '';
      const services = (e.services || []).slice(0, 3).join('; ');
      return `ID:${e.id} | ${e.name}${role ? ` (${role})` : ''} | Languages: ${langs} | From £${e.price_from}/session | About: ${desc.slice(0, 150)} | Services: ${services}`;
    }).join('\n\n');

    const prompt = `You are the matching engine for IntroLinq, a platform that connects blog READERS with experts they can book a call with.

Your job: find moments in the article where a READER — someone trying to learn, decide, or act — would genuinely benefit from a personal consultation with one of the available experts.

Rules:
- The match must be about the READER's need, not the article subject's actions. Do NOT highlight company announcements, press releases, quoted plans, statistics, or things a company says it will do.
- Only match phrases where a reader is facing a real decision, challenge, or knowledge gap that an expert could help with in a 1:1 call.
- Each "phrase" must be an exact substring from the article (copy it character-for-character)
- Phrases should be 2-6 words
- Maximum 3 matches. Return 0 if the article has no genuine reader need moments (e.g. pure news/press releases)
- Each expert can only be used once
- Detect the article language. If not English, strongly prioritise experts who speak that language
- Return only valid JSON, no other text

Bad match examples (DO NOT do this):
- Highlighting "investir massivement dans l'intelligence artificielle" from a company's plan
- Highlighting a CEO quote about their own strategy
- Highlighting funding round amounts or investor names

Good match examples:
- A reader learning about retirement who wonders how to start investing
- A founder reading about fundraising who doesn't know how to approach VCs
- A blogger reading about AI who needs help implementing it in their business

Available experts:
${expertsList}

Article:
${article.slice(0, 4000)}

Return exactly this JSON structure:
{"matches":[{"phrase":"exact phrase from article","expert_id":1,"reason":"One sentence speaking directly to the reader in second person — e.g. 'If you are looking to implement AI in your business, Pascal can help you navigate the strategy and pitfalls.'"}]}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(500).json({ error: 'AI matching failed' });
    }

    const aiResult = await response.json();
    const text = aiResult.content?.[0]?.text || '{"matches":[]}';

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { matches: [] };
    }

    const expertMap = Object.fromEntries(experts.map(e => [e.id, e]));
    const enriched = (parsed.matches || [])
      .filter(m => m.phrase && expertMap[m.expert_id])
      .map(m => ({
        phrase: m.phrase,
        reason: m.reason,
        expert: expertMap[m.expert_id]
      }));

    return res.status(200).json({ matches: enriched });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

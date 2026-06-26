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
      SELECT id, name, bio, photo_url, topics, price_from, price_currency, booking_url, location_country
      FROM experts
      WHERE active = true
      ORDER BY id
    `;

    if (experts.length === 0) {
      return res.status(200).json({ matches: [] });
    }

    const expertsList = experts.map(e =>
      `ID:${e.id} | ${e.name} | Specialises in: ${e.topics.join(', ')} | From £${e.price_from}/session`
    ).join('\n');

    const prompt = `You are the matching engine for IntroLinq, a platform that matches blog readers with relevant experts they can book a call with.

Given an article and a list of available experts, identify up to 4 specific phrases in the article where a reader would genuinely benefit from talking to one of these experts.

Rules:
- Each "phrase" must be an exact substring copied character-for-character from the article
- Phrases should be 2-6 words, targeting moments of uncertainty, complexity, or decision-making in the text
- Only match when there is a clear, specific fit - do not force matches
- Each expert can only be used once
- Return only valid JSON, no other text

Available experts:
${expertsList}

Article:
${article.slice(0, 4000)}

Return exactly this JSON structure:
{"matches":[{"phrase":"exact phrase from article","expert_id":1,"reason":"One sentence explaining why this expert is the right person for a reader at this point in the article"}]}`;

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

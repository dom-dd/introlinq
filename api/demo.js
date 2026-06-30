export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });

  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : 'https://' + url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Please enter a valid URL (e.g. https://yourblog.com/article)' });
  }

  let html;
  try {
    const r = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IntroLinq/1.0; +https://introlinq.com)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    if (!r.ok) return res.status(400).json({ error: `Could not load that page (${r.status})` });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('html')) return res.status(400).json({ error: 'URL must point to an HTML article page' });
    html = await r.text();
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(400).json({ error: 'That page took too long to load — try pasting the text instead' });
    }
    return res.status(400).json({ error: 'Could not reach that URL — try pasting the article text instead' });
  }

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/&amp;/g,'&').replace(/&#039;/g,"'").replace(/&quot;/g,'"').trim() : '';

  // Try to pull out main content block first (avoids nav/footer noise)
  let content = html;
  const mainMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    html.match(/class="[^"]*(?:post-content|entry-content|article-body|article-content|content-body|story-body)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section|article)>/i);
  if (mainMatch) content = mainMatch[1];

  const text = content
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length < 150) {
    return res.status(400).json({ error: "Couldn't extract enough text from that page — try pasting the article directly" });
  }

  return res.status(200).json({ title, text: text.slice(0, 5000) });
}

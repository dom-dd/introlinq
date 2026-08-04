import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

let tableReady = false;

async function ensureTables(sql) {
  if (tableReady) return;
  await sql`CREATE TABLE IF NOT EXISTS chat_conversations (
    id SERIAL PRIMARY KEY,
    visitor_token TEXT UNIQUE NOT NULL,
    visitor_name TEXT NOT NULL,
    visitor_email TEXT NOT NULL,
    publisher_slug TEXT,
    page_url TEXT,
    slack_channel TEXT,
    slack_thread_ts TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_message_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`.catch(() => {});
  await sql`CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES chat_conversations(id),
    sender TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_conversations (slack_channel, slack_thread_ts)`;
  tableReady = true;
}

function getSessionToken(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/il_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Server-side identity always wins over whatever the widget sends - a
// logged-in publisher's name/email is never taken from the client.
async function getSessionPublisher(sql, req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const [row] = await sql`
    SELECT p.slug, p.name, p.email
    FROM sessions s JOIN publishers p ON p.slug = s.publisher_slug
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `;
  return row || null;
}

async function slackPost({ channel, text, thread_ts }) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ channel, text, thread_ts }),
  });
  return res.json();
}

export default async function handler(req, res) {
  const sql = neon(process.env.DATABASE_URL);
  await ensureTables(sql);

  const { action } = req.query;

  // POST ?action=start { name, email, message, page_url } - opens a new
  // conversation, posts the first message into a fresh Slack thread.
  if (req.method === 'POST' && action === 'start') {
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_CHAT_CHANNEL_ID) {
      return res.status(500).json({ error: 'Chat is not configured yet' });
    }

    const { name, email, message, page_url } = req.body || {};
    const trimmedMessage = (message || '').trim().slice(0, 4000);
    if (!trimmedMessage) return res.status(400).json({ error: 'Message required' });

    const publisher = await getSessionPublisher(sql, req);
    const visitorName = publisher?.name || (name || '').trim().slice(0, 200);
    const visitorEmail = (publisher?.email || (email || '').trim().toLowerCase()).slice(0, 200);
    if (!visitorName || !visitorEmail) return res.status(400).json({ error: 'Name and email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(visitorEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const visitorToken = crypto.randomBytes(24).toString('hex');
    const slackText = `🗨️ *New chat* — ${visitorName} (${visitorEmail})${publisher ? ` · publisher: ${publisher.slug}` : ''}${page_url ? `\n${page_url}` : ''}\n\n${trimmedMessage}`;
    const slackRes = await slackPost({ channel: process.env.SLACK_CHAT_CHANNEL_ID, text: slackText });
    if (!slackRes.ok) console.error('Slack post failed', slackRes.error);

    const [conv] = await sql`
      INSERT INTO chat_conversations (visitor_token, visitor_name, visitor_email, publisher_slug, page_url, slack_channel, slack_thread_ts)
      VALUES (${visitorToken}, ${visitorName}, ${visitorEmail}, ${publisher?.slug || null}, ${page_url || null}, ${process.env.SLACK_CHAT_CHANNEL_ID}, ${slackRes.ts || null})
      RETURNING id
    `;
    await sql`INSERT INTO chat_messages (conversation_id, sender, body) VALUES (${conv.id}, 'visitor', ${trimmedMessage})`;

    return res.status(200).json({ conversationId: conv.id, visitorToken, name: visitorName, email: visitorEmail });
  }

  // POST ?action=message { conversationId, visitorToken, message } - a
  // follow-up from the visitor, posted as a threaded reply in Slack.
  if (req.method === 'POST' && action === 'message') {
    const { conversationId, visitorToken, message } = req.body || {};
    const trimmedMessage = (message || '').trim().slice(0, 4000);
    if (!conversationId || !visitorToken || !trimmedMessage) return res.status(400).json({ error: 'Missing fields' });

    const [conv] = await sql`SELECT * FROM chat_conversations WHERE id = ${conversationId} AND visitor_token = ${visitorToken}`;
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    await sql`INSERT INTO chat_messages (conversation_id, sender, body) VALUES (${conv.id}, 'visitor', ${trimmedMessage})`;
    await sql`UPDATE chat_conversations SET last_message_at = NOW() WHERE id = ${conv.id}`;

    if (conv.slack_thread_ts && process.env.SLACK_BOT_TOKEN) {
      await slackPost({ channel: conv.slack_channel, text: trimmedMessage, thread_ts: conv.slack_thread_ts });
    }

    return res.status(200).json({ ok: true });
  }

  // GET ?action=poll&conversationId=&visitorToken=&since= - the widget polls
  // this every few seconds while open; `since` filters to just-new messages.
  if (req.method === 'GET' && action === 'poll') {
    const { conversationId, visitorToken, since } = req.query;
    if (!conversationId || !visitorToken) return res.status(400).json({ error: 'Missing fields' });

    const [conv] = await sql`SELECT id, status FROM chat_conversations WHERE id = ${conversationId} AND visitor_token = ${visitorToken}`;
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const sinceDate = since ? new Date(since) : new Date(0);
    const messages = await sql`
      SELECT id, sender, body, created_at FROM chat_messages
      WHERE conversation_id = ${conv.id} AND created_at > ${sinceDate}
      ORDER BY created_at ASC
    `;
    return res.status(200).json({ messages, status: conv.status });
  }

  // POST ?action=slack-events&key=... - Slack Events API request URL. `key`
  // is a shared secret in the URL itself (same pattern as the booking
  // webhook's x-introlinq-secret) since Slack won't let us set a custom
  // header on its callback.
  if (req.method === 'POST' && action === 'slack-events') {
    if (!process.env.SLACK_CHAT_EVENTS_SECRET || req.query.key !== process.env.SLACK_CHAT_EVENTS_SECRET) {
      return res.status(401).end();
    }

    const body = req.body || {};
    if (body.type === 'url_verification') {
      return res.status(200).json({ challenge: body.challenge });
    }

    const event = body.event;
    // bot_id excludes our own posts (avoids a reply loop); thread_ts present
    // and distinct from ts means this is a reply within a thread, not a new
    // top-level message in the channel.
    if (event?.type === 'message' && !event.bot_id && !event.subtype && event.thread_ts && event.thread_ts !== event.ts) {
      const [conv] = await sql`
        SELECT * FROM chat_conversations
        WHERE slack_channel = ${event.channel} AND slack_thread_ts = ${event.thread_ts}
      `;
      if (conv) {
        // Replying with "!close" (optionally followed by a closing note) ends
        // the conversation from the widget's side - any other reply reopens
        // it, so there's no separate "reopen" step to remember. Not "/close"
        // - Slack's client intercepts any leading "/" as a slash-command
        // attempt and refuses to send it at all inside a thread.
        const closeMatch = /^!close\b\s*(.*)/is.exec((event.text || '').trim());
        const finalText = closeMatch ? (closeMatch[1].trim() || "This conversation has ended - feel free to start a new one anytime.") : (event.text || '');
        await sql`INSERT INTO chat_messages (conversation_id, sender, body) VALUES (${conv.id}, 'agent', ${finalText})`;
        await sql`UPDATE chat_conversations SET status = ${closeMatch ? 'closed' : 'open'}, last_message_at = NOW() WHERE id = ${conv.id}`;
      }
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(404).end();
}

/*
 * Tells people a booking was recorded: the publisher (Resend email, if they
 * have a payment_email), the team (Resend email + Slack). Mirrors what the
 * OpenIntro webhook in api/dashboard.js does after it inserts a booking, so a
 * booking looks the same to a publisher whichever route it arrived by.
 *
 * Used by the Impact reconciliation cron and the admin manual-entry path.
 * Every call is awaited by the caller on purpose - a serverless function can
 * be frozen the moment its response is sent, so fire-and-forget never lands.
 * Failures are swallowed: a mail or Slack outage must never undo a booking.
 */

const PROVIDER_LABELS = { openintro: 'OpenIntro', 'open-intro': 'OpenIntro', preply: 'Preply' };
export function providerLabel(slug) {
  return PROVIDER_LABELS[slug] || String(slug || '').split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || 'a partner';
}

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'IntroLinq <notifications@introlinq.com>', to, subject, text }),
    });
  } catch (err) {
    console.error('Booking email failed:', err);
  }
}

export async function slackPing(text) {
  if (!process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL) return;
  try {
    await fetch(process.env.SLACK_NOTIFICATIONS_WEBHOOK_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Slack ping failed:', err);
  }
}

/**
 * @param {object} p
 * @param {{slug:string,name:string,payment_email?:string|null,revenue_share:number}} p.publisher
 * @param {string} p.providerName   e.g. "Preply"
 * @param {string} p.expertName
 * @param {number} p.bookingAmount  commission basis, in `currency`
 * @param {number} p.payout         the publisher's share
 * @param {string} p.currency
 * @param {string|null} [p.articleUrl]
 * @param {string|null} [p.articleTitle]
 */
export async function notifyBooking({ publisher, providerName, expertName, bookingAmount, payout, currency, articleUrl = null, articleTitle = null }) {
  const margin = Math.round((bookingAmount - payout) * 100) / 100;
  const pct = Math.round(Number(publisher.revenue_share) * 100);
  const articleLine = articleTitle
    ? `\n\nThe booking came from your article: ${articleTitle}${articleUrl ? `\n${articleUrl}` : ''}`
    : '';

  await sendEmail(
    publisher.payment_email,
    `IntroLinq - You earned ${currency} ${payout.toFixed(2)} - new booking on your site`,
    `Hi ${publisher.name},\n\nA reader on your site just booked a session with ${expertName} via ${providerName}.\n\nBooking value: ${currency} ${Number(bookingAmount).toFixed(2)}\nYour commission (${pct}%): ${currency} ${payout.toFixed(2)}${articleLine}\n\nThis will be included in your next payout.\n\nBest,\nThe IntroLinq team`,
  );

  await sendEmail(
    process.env.COMPANY_NOTIFICATION_EMAIL,
    `IntroLinq - New booking - ${currency} ${Number(bookingAmount).toFixed(2)} via ${publisher.name}`,
    `Provider: ${providerName}\nPublisher: ${publisher.name} (${publisher.slug})\nExpert: ${expertName}\n\nBooking amount: ${currency} ${Number(bookingAmount).toFixed(2)}\nPublisher payout (${pct}%): ${currency} ${payout.toFixed(2)}\nIntroLinq margin: ${currency} ${margin.toFixed(2)}${articleTitle ? `\n\nArticle: ${articleTitle}${articleUrl ? `\n${articleUrl}` : ''}` : ''}`,
  );

  await slackPing(`💰 *New booking* - ${expertName} · ${currency} ${Number(bookingAmount).toFixed(2)} · ${publisher.name} · Payout: ${currency} ${payout.toFixed(2)}${articleTitle ? ` · _${articleTitle}_` : ''}`);
}

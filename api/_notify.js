// Shared helper for emailing the team (not publishers) about real signup/
// activation events - new account created, and first-time activation across
// every mode (AI widget, carousel, board, manual link). Sits alongside the
// existing Slack notifications (SLACK_NOTIFICATIONS_WEBHOOK_URL in auth.js/
// match.js/dashboard.js), which stay as-is; this just adds an email on top
// for the two people who want a direct notification rather than checking
// Slack. Added 2026-09-04.

const TEAM_EMAILS = ['dom@introlinq.com', 'monika@introlinq.app'];

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fire-and-forget by design (callers never await the rejection path) - same
// reasoning as the Slack calls next to it: this must never fail or delay
// the request/response it's attached to.
export async function notifyTeam(subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'IntroLinq <hello@introlinq.com>',
        to: TEAM_EMAILS,
        subject,
        html,
      }),
    });
  } catch {}
}

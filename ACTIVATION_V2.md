# ACTIVATION_V2 — cross-mode activation model

Replaces the widget-only "is this publisher live?" signal (`first_widget_fire_at`)
with one that also counts the **carousel**, the **Expert Board**, and **manual
newsletter links**. Fixes: non-widget publishers showing as "Pending install"
forever, getting the activation-reminder nag sequence while already active, and
seeing an all-zeros dashboard funnel.

## Kill switch

Everything user-visible is gated on the **`ACTIVATION_V2`** env var.

- **Off (unset)** — identical to today. Reminder cron, removed-check cron, admin
  panel and publisher dashboard all read `first_widget_fire_at` exactly as before.
  The `board_view` endpoint is a no-op. New columns aren't read.
- **On** — new behaviour (below).

To roll back in production: **delete the `ACTIVATION_V2` env var in Vercel** (no
redeploy needed). Optionally run `node backfill-activation-columns.mjs --revert`
to null the new columns, and `git revert` the branch to remove the code.

## New columns on `publishers`

| column | meaning |
| --- | --- |
| `activated_at` | first time the publisher did anything real (any mode). `NULL` ⇒ still gets reminders. |
| `last_activity_at` | most recent activity of any kind. Drives the admin "live in last 3 days" count. |
| `last_script_activity_at` | most recent **script embed** signal (widget / carousel / board render or click) — *not* manual-link clicks. Drives removed-detection. |

`match.js` writes all three on every widget fire (unconditional — safe, self-healing).
`dashboard.js` `stampActivity()` writes them for carousel/board/manual events (gated on `ACTIVATION_V2`).

Manual-link clicks only set `activated_at` once there's a non-bot click from an
**earlier calendar day**, so a batch of signup-day self-tests doesn't silence the
reminder sequence.

## Deploy steps

1. Merge branch (behaviour unchanged — env var not set yet).
2. `node backfill-activation-columns.mjs` (dry run), then `--apply`.
3. Set `ACTIVATION_V2=1` in Vercel → redeploy / it takes effect on next cold start.
4. Verify admin Publishers tab: manual/board publishers (aks-e-gray, techbeach)
   move out of "Pending Install"; their reminder tooltip shows "cancelled".

## What changes when ON

- **`api/cron/activation-reminders.js`** — stop condition becomes `activated_at IS NULL`
  instead of `first_widget_fire_at IS NULL`.
- **`api/cron/widget-removed-check.js`** — silence check keys off
  `last_script_activity_at` (covers carousel/board removal); manual-only publishers
  (`last_script_activity_at IS NULL`) are never flagged. Email copy: "widget" → "IntroLinq embed".
- **`expertboard.js`** — fires `POST /api/dashboard?action=board_view` once per render
  (mirrors `carousel.js`). Endpoint no-ops unless `ACTIVATION_V2`.
- **`api/dashboard.js`** — `check_live` also checks the pages the carousel/board
  actually rendered on, not just `match_cache` + homepage. Stats response gains
  `modes[]`, `manual_only`, `activation_v2`.
- **`admin/index.html`** — status icon / sub-tab bucket / reminder tooltip treat a
  publisher with non-widget activity as active, not pending. Mode badges on the row.
- **`dashboard/index.html`** — `manual_only` publishers get a Clicks / Bookings /
  Earnings layout instead of the view→hover→click funnel, with an explanatory note.
  Header shows the detected mode(s).

## Deferred (not in this PR)

- Merging carousel/board views into the widget funnel CTR math.
- Platform-aware reminder skip (needs a trustworthy `platform` value).
- A softer one-shot "you could add the widget" nudge for capable platforms.

# Cadence (public, multi-household)

The shareable version of Cadence, a budget app that plans one paycheck at a
time. Static HTML/CSS/JS (ES modules, no build step) served by GitHub Pages
from `main` at https://mabry-z.github.io/cadence-app/, with its own Supabase
project **cadence** (ref `mjswvkyzlibzzjjzijir`). Mobile-first (max width
430px), dark "glass" design with a light mode.

It started as a copy of the owner's private app (`mabry-z/family-budget`,
Supabase project "Family Budget"). **Never change that repo, that Supabase
project, or its Gmail scripts from here.** The owner's household moves over
to this app later, in a separate phase.

## Files

- `index.html` — markup and empty containers; everything is rendered by JS.
- `manifest.json`, `icons/` — home-screen name and icon (the C monogram).
- `css/cadence.css` — colour tokens for dark (`:root`) and light
  (`:root[data-theme="light"]`), the Cadence design, then additions. Use
  tokens only — no colour literals outside those two blocks (card badge
  colours are data).
- `js/config.js` — Supabase URL/publishable key, colour palettes, card
  presets, category suggestions. Nothing household-specific.
- `js/supabase.js` — client. `js/data.js` — every Supabase read/write/RPC
  (amounts come back as `amount`, in cents).
- `js/budget.js` — pure budget math and money (cents ↔ text, rounding).
- `js/paydays.js` — pure dates, federal holidays, pay schedules.
- `js/merchants.js` — pure store-name grouping and suggestions.
- `js/auth.js` — sign in/up (invite code), reset/change password.
- `js/theme.js` — light/dark, per phone (localStorage).
- `js/app.js` — start-up, state, periods, tabs, Settings wiring.
- `js/ui/*.js` — one module per screen/sheet: `onboarding` (first-launch
  setup and joining), `sign-in`, `overview`, `bills`, `insights`,
  `summary`, `expense-sheet`, `settings-sheet`, `card-sheet`,
  `schedule-form`, `household`, `payday-sheet`, `stores-sheet`,
  `appearance`, plus `rows.js` and `dom.js` helpers.
- `supabase/migrations/NNN_*.sql` — the schema (next number: **002**).
- `dev/serve.ps1` — local static server (http://localhost:8001).
  `dev/*.local.*` is git-ignored (for test account details).

## Data model (Supabase, schema `public`)

- Sign-up is **invite-only**: `hook_before_user_created` (Auth → Hooks →
  Before User Created) refuses an account without a usable code in
  `user_metadata.invite_code`. `invites.kind` is `join` (made by any member,
  `create_join_code()`) or `household` (start a new one; app admins only,
  `create_household_code()`, `app_admins` table). Codes: 6 characters, one
  use, expire (7 / 30 days).
- `households` (+ `round_whole`, `pay_schedule` jsonb, `starting_cents`,
  `carry_start`, `setup_done`) and `household_members` (role owner|member,
  `display_name`, dot `color`; one household per person).
- Every budget table has `household_id` defaulting to
  `current_household_id()` and the RLS policy "household members". The
  anon key can only call `check_invite()`. Writes that need rules go
  through security-definer functions that filter by the caller's household.
- **Money is cents** (`bigint`). `round_whole` (default on) rounds what's
  typed to whole dollars, half up, and shows whole dollars.
- `pay_periods` — identified by `start_date` (scheduled payday) and ending at
  `next_start`; `starts_on` is the confirmed real payday. No overlaps
  (exclusion constraint). Created by `ensure_period(start, next)` from the
  household's defaults when first opened. The app works out schedule dates
  (`js/paydays.js`); `set_pay_schedule()` re-plans from the current period.
- `pay_schedule`: `{kind: semimonthly, days:[1,15]}` | `{kind: monthly,
  day}` | `{kind: biweekly|weekly, anchor: 'YYYY-MM-DD'}`. Day 31 = last.
- `categories` (exactly one `is_remainder` = **Extra** per household),
  `period_categories` (per-period amounts + `emptied`).
- `bill_templates` (recurring bills with `due_day`) → `fixed_costs` rows in
  whichever period the due date falls (`bill_due_dates()`,
  `sync_template_bills()`; same rule as `billDueIn()` in paydays.js).
- `cards` — each household's own (name, kind, badge, colour, archived).
  `expenses.card_id` may be null.
- `expenses` — `period_id`, `category_id`, `card_id`, `amount_cents`,
  `from_savings`, `created_by`, `source` ('manual'; room for imports later).
- `hidden_merchants`, `period_extra_carry` (view), `household_info()`,
  `save_settings()`, `start_period()`, `delete_my_account()`.

## Rules the app must keep

- **Extra is never stored**: paycheck − this period's bills − other
  categories' (effective) budgets + carry-in. Carry-over (negative too) runs
  from `carry_start`, or the household's first period.
- Settings saved on the current or a future period change the defaults, that
  period and every later existing period — never earlier ones. On a past
  period only that period changes. Recurring bills are edited as a list of
  templates; a past period edits its own bill rows.
- Removing a category with expenses in the affected periods is blocked.
- Payday on a weekend or federal holiday is expected the business day before;
  the app asks "Has your … pay arrived?" from 3 days before.
- Savings purchases never count (shown in Recent activity, Summary, cards).
- Insights counts by pay period and only expenses; numbers come from
  `buildBudget`, so they match the Overview.
- Manual entry only. Email import is not built; don't assume it exists.

## Workflow (the owner's preferences)

- **Plan first** for anything sizeable; show UI mock-ups (light + dark)
  before building; wait for approval.
- Claude may apply migrations to **this** project (cadence) directly; write
  them to `supabase/migrations/` too and keep them safe to re-run.
- Test with throwaway accounts (made with SQL; details in a git-ignored `dev/*.local.*` file), never
  with real people's data.
- Commit and push only when asked, with
  `git -c user.name="mabry-z" -c user.email="333444250+mabry-z@users.noreply.github.com" commit ...`
  (GitHub's private noreply address — keep personal emails out of this public repo).
- This PC has no Python or Node. Local server:
  `powershell -ExecutionPolicy Bypass -File dev/serve.ps1` (port 8001).
- Explain things in plain language; the owner isn't a developer.

## Later

- Move the owner's household over from Family Budget (copy script; ×100 for
  cents; cards from the old fixed list; `carry_start` = 2026-09-16).
- Custom email sending (SMTP) so password resets reach everyone.
- Optional email import (per-household forwarding address → server function).
- Privacy policy; App Store wrapper.

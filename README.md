# RowLog — Rowing Training Logger

A multi-user rowing training app backed by Supabase. Features training load tracking (CTL/ATL/TSB), erg PB boards, sleep logging, morning check-ins, social connections, and a read-only coach view.

## Setup

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project, and note your **Project URL** and **anon public key** from `Settings → API`.

### 2. Run the database schema

In your Supabase project, go to **SQL Editor** and paste the entire contents of `schema.sql`. Click **Run**.

This creates all tables, RLS policies, the storage bucket for avatars, and the `get_profile_by_share_token` security-definer function used by the coach view.

### 3. Enable Email authentication

In Supabase, go to **Authentication → Providers** and ensure **Email** is enabled. You can disable "Confirm email" for development to skip the confirmation step.

### 4. Create the avatars storage bucket

The `schema.sql` script creates the bucket automatically. If you need to do it manually: go to **Storage**, click **New bucket**, name it `avatars`, and set it to **Public**.

### 5. Add your Supabase credentials

Edit `js/supabase.js` and replace the placeholder values:

```js
const SUPABASE_URL = 'https://your-project-ref.supabase.co'
const SUPABASE_ANON_KEY = 'your-anon-key-here'
```

The anon key is safe to use client-side. Supabase Row Level Security (RLS) ensures users can only read and write their own data. The anon key grants no special privileges beyond what RLS allows.

### 6. Deploy

This is a fully static site — no build step, no Node.js. Deploy to any static host:

**Vercel:**
```bash
npx vercel deploy
```

**Netlify:**
Drag the `rowing-logger` folder into the Netlify drop zone at [app.netlify.com](https://app.netlify.com).

**GitHub Pages:**
Push to a GitHub repo and enable Pages in the repository settings. Note that GitHub Pages serves from the repo root or `/docs`, so you may need to adjust the base path in `index.html`.

**Local development:**
```bash
npx serve .
# or
python3 -m http.server 3000
```

Open `http://localhost:3000` — the redirect in `index.html` will send you to the login page.

### 7. Data migration from localStorage

If you have existing data from the old standalone `rowlog.html`, the app detects it automatically on first login and shows a green banner on the Dashboard. Click **Import Now** to migrate all sessions, races, and check-ins to Supabase. The localStorage data is not deleted — you can dismiss the banner once migration is complete.

---

## File structure

```
rowing-logger/
  index.html          ← redirects to /pages/login.html
  schema.sql          ← paste into Supabase SQL Editor
  README.md
  .env.example        ← reference for environment variables
  css/
    styles.css        ← all styles (extracted from rowlog.html + additions)
  js/
    supabase.js       ← Supabase client (add your URL and anon key here)
    auth.js           ← authentication: login, register, session check, sign out
    app.js            ← main app: all pages, charts, data layer
    social.js         ← social features: feed, connections, profile, coach view
  pages/
    login.html        ← sign-in page
    register.html     ← registration page
    app.html          ← main app shell (sidebar + page containers)
    profile.html      ← user profile and settings page
    coach.html        ← public read-only coach view (no auth required)
  rowlog.html         ← original standalone app (still works with localStorage)
```

---

## Architecture notes

### Module system
All JS files use native ES modules (`type="module"`) with ESM CDN imports. No npm, no build step, no bundler required.

```html
<script type="module" src="../js/app.js"></script>
```

The Supabase client is imported from the ESM CDN:
```js
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
```

### Data shape
The original app stored data as `{date, sessions:[], sleep:{}}` per day in localStorage. Supabase stores one row per session in the `sessions` table. The conversion is handled by:
- `dbRowsToLocalFormat(sessionRows, sleepRows)` — groups rows by date, merges sleep data
- `localFormatToDbRows(day, userId)` — flattens back to individual rows for upsert

This means all the existing calculation functions (TSS, CTL/ATL/TSB, PBs, etc.) work identically — they receive the same data shape they always did.

### Security
- RLS policies restrict all table access to the row owner (`auth.uid() = user_id`)
- Public profiles (`is_public = true`) are readable by any authenticated user
- Sessions, sleep, and check-ins of a user are readable by accepted connections
- The coach view uses a `SECURITY DEFINER` RPC function to look up a profile by its `share_token` UUID without bypassing RLS for other data

### Realtime
`social.js:initRealtime()` subscribes to:
- `feed_events` inserts — updates the Feed page live
- `connections` changes targeting the current user — updates the notification badge

---

## Features

| Feature | Description |
|---------|-------------|
| Training log | Up to 3 sessions per day; S&C with exercise logger |
| TSS / CTL / ATL / TSB | TrainingPeaks-style fitness curve with 42-day and 7-day EWMAs |
| Morning check-in | Fatigue, mood, soreness, stress sliders + readiness score |
| Sleep tracking | Bedtime, wake time, hours, quality; 28-night chart |
| PB board | Auto-detected from erg sessions with piece types |
| Erg progression | Split trend charts per piece type |
| Calendar | Month heatmap with training load intensity |
| Races | Upcoming countdowns + past results |
| Social feed | Activity feed from accepted connections |
| Coach view | Shareable read-only URL; no login required for coach |
| Data migration | One-click import from localStorage |

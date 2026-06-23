# WiggenApp — Project Reference

## What it is
Personal health & training dashboard. Live at **https://snxz-y.github.io/WiggenApp/**. GitHub repo: `snxz-y/WiggenApp`. Single-page app (`index.html`) with four tabs: Activities, Health, Nutrition, Reviews. Dark theme, lime (`#c8f53a`) + purple (`#7c6dfa`) accents.

## Owner context
Jørgen, 28, 171cm, ~76kg, goal 65kg. Shift nurse in Trondheim, Norway. Quit Zyn June 5 2026. Dairy allergy. Garmin Epix Pro Gen 2. HR zones: Z1 104-124, Z2 125-145, Z3 146-165, Z4 166-186, Z5 187+. Nutrition targets: 1600 kcal, 150g protein, 145g carbs, 51g fat.

## File locations (Windows PC)
All scripts in `C:\Users\Jørgen\Documents\files\`:
- `index.html` — the site
- `garmin_sync.py` — daily Garmin→GitHub sync, auto-refreshes OAuth token
- `garmin_backfill.py` — one-off historical data backfill
- `sync_log.txt` — sync output log

Garmin MCP tokens: `C:\Users\Jørgen\.garmin-mcp\` (oauth1, oauth2, profile)

## Data files in GitHub repo
- `activities.json` — workouts
- `health.json` — daily Garmin metrics (complete from June 14; body-comp only before)
- `nutrition.json` — macros from Kaloridagboken
- `reviews.json` — saved weekly reviews

## Automation
- **Garmin sync (runs on the Home Assistant box):** As of 22 June 2026 the sync runs on the always-on HA box (HA OS, `192.168.10.103:8123`) via the **Advanced SSH & Web Terminal** add-on (slug `a0d7b954_ssh`). Files live in `/config/garmin/`: `garmin_sync.py`, `ha_garmin.py` (wrapper — sets `USERPROFILE` so `TOKEN_DIR=./.garmin-mcp`, and sets `GH_PAT`), and the `.garmin-mcp/` token files (`oauth1_token.json`, `oauth2_token.json`, `profile.json`). `requests` is pip-installed in the add-on. It runs in **local mode** (reads/refreshes the cached OAuth2 token on disk), so the OAuth1→OAuth2 exchange only happens when the token nears expiry — avoiding Garmin 429 at 15-min frequency.
  - **Schedule:** busybox cron in the add-on, `*/15 6-23 * * *` plus `0 0 * * *` = every 15 min 06:00–24:00 Norway local time (the box clock is local). Crontab stored at `/config/garmin/crontab`; log at `/config/garmin/sync.log`.
  - **Reboot persistence:** the add-on's **init_commands** reload the crontab and start crond on every boot (`crontab /config/garmin/crontab`, `crond -b -L /config/garmin/cron-daemon.log`) — verified surviving an add-on restart.
  - **Cloud job DISABLED:** the old GitHub Actions workflow `.github/workflows/garmin-sync.yml` (`cron: '*/15 4-22 * * *'`) was set to `disabled_manually` on 22 June 2026 so it no longer competes with the box. To re-enable: GitHub → Actions → "Garmin Sync" → Enable workflow. `garmin_sync.py` is committed to the repo (the HA box runs that same file). The cloud job, if re-enabled, reads the GitHub token from env (`GH_PAT` secret) and Garmin creds from `GARMIN_OAUTH1_TOKEN`/`GARMIN_OAUTH1_SECRET`/`GARMIN_DISPLAY_NAME` secrets; no tokens are hardcoded in the committed file. There is **no** local Windows Task Scheduler task (the old `GarminSync_*` tasks were removed).
  - **Activities are upserted, not skipped:** `sync_activities` re-processes the last ~2 days every run. It inserts new activities, repairs partial/foreign-schema entries (e.g. ones hand-added via Garmin MCP that lack `distanceM`), and refreshes metrics Garmin computes minutes after a run (power, running dynamics, HR zones, VO2max, load). Do **not** hand-write activity entries with a custom schema — let the sync own `activities.json`.
- **On-demand sync:** removed. The in-app "Sync Garmin" button (and its `triggerGarminSync()` handler) was deleted on 22 June 2026 because the HA box now auto-syncs every 15 min, and the old button dispatched the now-disabled `garmin-sync.yml` workflow. For a manual sync, run `python3 /config/garmin/ha_garmin.py` on the HA box (e.g. via the SSH add-on web terminal). The Worker's `/sync-garmin` endpoint still exists but is no longer called by the app.
- **Nutrition:** Health Auto Export iPhone app → Cloudflare Worker → GitHub. Syncs every 6h. Widget on home screen keeps it reliable.
- **Cloudflare Worker:** `https://nutrition-reciever.margidowiggen.workers.dev` — handles `/` (nutrition), `/save-review`, `/generate-review`, `/sync-garmin` (dispatches the Actions workflow). Secrets: `GITHUB_TOKEN`, `ANTHROPIC_KEY`.

## Reviews
Reviews tab calls the Worker's `/generate-review` which calls Claude API (claude-sonnet-4-6). Costs ~$0.01-0.03 per review. Past reviews show as collapsible accordions.

## Key behaviors
- Dates display DD/MM/YYYY everywhere via custom date picker (pill-shaped button, opens dark calendar popup). Defaults to today minus 1 day.
- Health & Nutrition tabs: single date picker, no Apply button (applies on select).
- Macro split shows two donuts: Goal (left) vs Actual (right).
- Training readiness feedback codes translated to plain English.

## Push command (standard)
```powershell
$token="<GITHUB_TOKEN>"
$repo="snxz-y/WiggenApp"
$h=@{Authorization="token $token";Accept="application/vnd.github.v3+json";"Content-Type"="application/json";"User-Agent"="wt"}
$d=(Get-Item -LiteralPath "C:\Users\Jørgen\Documents\files").FullName
$bytes=[System.IO.File]::ReadAllBytes("$d\index.html")
$c=[Convert]::ToBase64String($bytes)
$sha=(Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/index.html" -Headers $h -Method GET).sha
$b=@{message="update";content=$c;sha=$sha}
Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/contents/index.html" -Headers $h -Method PUT -Body($b|ConvertTo-Json -Depth 3)|Out-Null
```

## Getting run feedback remotely
If PC is on + Claude Desktop running, use **Cowork** from iPhone: fetch latest run via Garmin MCP and trigger the sync to update WiggenApp on demand — no waiting for the scheduled 23:00 sync. Without the MCP (plain Claude app), read `https://raw.githubusercontent.com/snxz-y/WiggenApp/main/activities.json` — but only AFTER a sync has pushed the run.

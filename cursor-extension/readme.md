# Cursor Usage Tracker

Track the credit you burn on **every Cursor prompt** and see it on your own website.

```
 Your laptop (Cursor)                          Your website
 ┌──────────────────────────────┐   HTTPS     ┌──────────────────────────┐
 │ Cursor Usage Tracker ext.    │ ──────────▶ │ server.js  /api/ingest   │
 │  • reads local chat history  │  every 5min │  store.json              │
 │    (prompt text, tokens,     │             │  dashboard  /            │
 │     model, time)             │             │   • cost per prompt      │
 │  • reads your cursor.com     │             │   • daily burn           │
 │    usage events (official    │             │   • by model             │
 │    tokens + cost)            │             │   • search, CSV export   │
 └──────────────────────────────┘             └──────────────────────────┘
```

## What's in this folder

| Folder | What it is |
|---|---|
| `extension/` | The Cursor extension source. `cursor-usage-tracker-1.0.0.vsix` is the ready-to-install file. |
| `server/` | The website: a tiny Node.js server (no dependencies) + the dashboard page. |

---

## Step 1 — Put the website online

Requires Node.js 18 or newer on the server.

```bash
cd server
TRACKER_API_KEY="pick-a-long-random-secret" PORT=8787 node server.js
```

**Windows PowerShell** (for trying it on your laptop first):
```powershell
cd server
$env:TRACKER_API_KEY="pick-a-long-random-secret"; node server.js
```

Open `http://localhost:8787`, enter the same secret, and you'll see the (empty) dashboard.

**To host it permanently**, any Node host works — a VPS with `pm2`, Render, Railway, Fly.io, etc.:
- Start command: `node server.js`
- Environment variables: `TRACKER_API_KEY` (required), `PORT` (host usually sets it), `DATA_DIR` (optional — point it at a persistent disk so data survives redeploys)
- Use **HTTPS** — your prompts travel over this connection.

If you already have a website, you can instead mount it under a subpath with your reverse proxy (e.g. nginx `location /cursor/ { proxy_pass http://127.0.0.1:8787/; }`).

## Step 2 — Install the extension in Cursor

1. In Cursor: **Ctrl+Shift+P** (Mac: **Cmd+Shift+P**) → **Extensions: Install from VSIX…**
2. Pick `extension/cursor-usage-tracker-1.0.0.vsix`, then reload when asked.
3. **Ctrl+Shift+P** → **Cursor Tracker: Set dashboard URL and API key**
   - URL: your website, e.g. `https://usage.yoursite.com` (or `http://localhost:8787` while testing)
   - Key: the same `TRACKER_API_KEY`

The first sync sends your last 30 days. After that it syncs every 5 minutes. The status bar shows "N prompts today" — click it to open the dashboard.

## Using it with the RMW dashboard (v1.4.0+)

With the RMW dashboard you don't need the website in this folder, and only an admin can connect a computer:

1. An admin opens **RMW Data → Cursor → People & devices**, picks the person and clicks **Create setup code**. The code looks like `CUR-7K3P-92QX`, works **once** and expires after **15 minutes**.
2. On that person's computer, in the Cursor IDE window: **Ctrl+Shift+P → Cursor Tracker: Connect to dashboard**. Enter the dashboard address and the code.
3. The extension swaps the code for a token that works **only from this computer**. The token is kept in the operating system's credential store, not in `settings.json`.

To switch a computer to another person, the admin creates a new code for them. Running Connect without a valid code changes nothing. In the same panel, **Disconnect** turns a computer off straight away.

## Track Claude Code too (v1.5.0+)

Claude Code (in a terminal and in VS Code) can report its own usage, with each request's model, tokens and cost, and the prompt. The extension switches that on for the person this computer is connected for:

1. Connect the computer to the dashboard first (above). Right after connecting, the extension offers to track Claude Code.
   Later, use **Ctrl+Shift+P → Cursor Tracker: Connect Claude Code on this computer**.
2. Restart open Claude Code sessions: in a terminal, exit and run `claude` again. In VS Code, run **Developer: Reload Window**.

Usage shows up on the dashboard within seconds of the next prompt.

What it changes: the `env` block of `~/.claude/settings.json` (Windows: `%USERPROFILE%\.claude\settings.json`), which Claude Code reads in the terminal and in VS Code alike. Everything else in that file is kept, and the previous version is saved as `settings.json.bak`. If the file isn't valid JSON, nothing is changed. If Claude Code already sends telemetry somewhere else, you're asked before it's replaced.

- **Same person, always.** Claude Code's token is issued by the dashboard for this computer's connection. When an admin disconnects the computer, or connects it for someone else, Claude Code stops reporting as the old person. After reconnecting, the extension gets a new token for the new person by itself.
- **Prompt text** follows the `sendPromptText` setting. Turn it off to send only tokens, models and cost.
- **To stop:** **Cursor Tracker: Stop tracking Claude Code on this computer** removes only the keys the extension added.
- **VS Code without Cursor** works too: install this extension in VS Code, connect with a setup code, then connect Claude Code.
- The cost shown is the amount Claude Code reports at API prices. On a Pro, Max or Team plan nobody is billed that per request; it shows each person's share of the plan. Usage from before a computer is connected isn't sent.

## Tokens and cost: upload Cursor's usage CSV

Cursor 3 no longer stores token counts on the laptop, and it encrypts the login the extension used to read usage from cursor.com.
So the extension records **who** prompted and **when**, and the tokens come from Cursor's own usage export:

1. On cursor.com go to **Dashboard → Usage → Export CSV**.
2. On your dashboard click **Upload Cursor CSV** and pick the file.

Each row in the file is matched to the prompt that was running at that moment, per person. Usage nobody was prompting for shows up as **Unassigned**, so the rows in **By person** add up to the account total.
Uploading the same file twice, or overlapping files, doesn't double count. Prompts newer than your last upload show "—" until you upload a fresh export.

## How cost is worked out

For each prompt you type, the extension records the prompt and every AI response that followed it.
Cursor's official per-request usage events (pulled from your cursor.com account) are matched to the prompt whose
response window they fall in.

| What you'll see | Meaning |
|---|---|
| Cost with no tag | The value Cursor itself reported for those requests |
| Cost with **est.** | Cursor didn't report a cost (or the event hadn't arrived yet), so it's tokens × the prices in `server/pricing.json` |
| "Billed beyond plan" | `chargedCents` — the part that went beyond your included monthly usage |
| Yellow "couldn't be tied to a prompt" note | Usage with no typed prompt (Tab, Cmd-K, background agents) |

Cursor's usage events can arrive a few minutes to a few hours late. Each sync re-sends the last 3 days, so estimated rows switch to Cursor-reported values once the events arrive.

Edit `server/pricing.json` any time to change the estimate prices — no restart needed.

## More than one person or computer

Install the extension on each computer and give each one a different name in **Set dashboard URL and API key**. Use the same website and the same API key on all of them.
The dashboard then shows a **By person** table, a person filter, and **Download report**. The report is a CSV with each person's prompts, tokens, credit, share and billed-beyond-plan amount, plus a day-by-day breakdown.

How attribution works:
1. **Prompts and their token counts** come from each computer's own Cursor history, so they're always credited to the right person.
2. **Cursor's official usage events** are account-wide and don't say which computer made a request. Each event goes to whoever had a prompt running at that moment.
3. **When both people had a prompt running at the same moment:**
   - If only one of them was using that request's model, it's theirs.
   - Otherwise it's split between them in proportion to each person's own token counts, and those prompts are marked **split**.

## Extension settings

Settings → search "Cursor Tracker":

| Setting | Default | |
|---|---|---|
| `sendPromptText` | on | Turn off to send only tokens/models/cost, never prompt text |
| `maxPromptChars` | 4000 | Long prompts are cut to this length |
| `syncIntervalMinutes` | 5 | |
| `lookbackDays` | 3 | Days re-sent each sync |
| `fetchAccountUsage` | on | Pull official usage from cursor.com. Turn off to use only local data + estimates |
| `databasePath` | auto | Only if Cursor's data lives somewhere unusual |

Commands: **Sync now**, **Open dashboard**, **Re-send last 30 days**, **Show log** (for troubleshooting).

## Important to know

- **Unofficial data sources.** Cursor has no official usage API for personal plans. The extension reads Cursor's local database and the same internal endpoint your cursor.com dashboard uses. If Cursor changes either, the extension may stop working until it's updated — check **Cursor Tracker: Show log**.
- **Your session stays on your laptop.** Your Cursor login token is only ever sent to cursor.com, never to your website.
- **Prompt text is sent to your server.** It may contain company code or secrets. Use HTTPS, keep `TRACKER_API_KEY` private, or turn `sendPromptText` off. Check your company's policy before sending work prompts to a personal server.
- **Current billing period.** cursor.com only returns usage for the current billing period. Older prompts still show, but with estimated costs.

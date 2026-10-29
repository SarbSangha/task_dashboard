# Cursor capture contract

Cursor (cursor.com) is a desktop AI code editor, so it is the one provider **not** captured by
the browser extension. Two sources feed it:

| What | Source | Endpoint |
|---|---|---|
| Who prompted, when, what, which chat/model | Cursor Usage Tracker extension, reading Cursor's local `state.vscdb` | `POST /api/providers/cursor/capture/prompts` |
| Tokens and cost per request | Cursor's usage export, uploaded by an admin | `POST /api/providers/cursor/usage/upload` |

## Identity: admin-issued, computer-bound tracker token

Nobody opens Cursor through the dashboard launcher, so there is no launch ticket. Only an admin
can connect a computer, in **RMW Data → Cursor → People & devices**:

1. The admin picks a person → `POST /setup-codes {"user_id": 7}` → a one-time code such as
   `CUR-7K3P-92QX`, valid 15 minutes (only its sha256 is stored).
2. On that person's computer, **Cursor Tracker: Connect to dashboard** sends
   `POST /connect {"code": "...", "device": {"id": "<vscode machineId>", ...}}`. The code is claimed
   with a conditional UPDATE (works once), and the response is an opaque token `cut_...` for that
   person. The server keeps only its sha256, in `cursor_devices` with the device id. The
   extension keeps the token in VS Code SecretStorage (the OS credential store), not settings.json.
3. Every `/capture/prompts` call sends `Authorization: Bearer <token>`, and its `device.id` must
   equal the one the token was issued to, so a token copied to another computer is refused.

Connecting a computer again revokes its previous token (one computer = one person). An admin's
**Disconnect** (`POST /devices/{id}/disconnect`) revokes it immediately, and a deleted user's
computers stop working. `GET /devices` shows each computer's person, Cursor login and last sync.

## Extension → `/capture/prompts`

```json
{
  "extension_version": "1.4.0",
  "device":  {"id": "<vscode machineId>", "name": "CT-SARBJEET", "os": "win32"},
  "account": {"email": "<cursorAuth/cachedEmail>", "plan": "<cursorAuth/stripeMembershipType>"},
  "prompts": [{
    "id": "<composerId>:<bubbleId>", "ts": 1793251538187, "endTs": 1793251540869,
    "conversationId": "<composerId>", "conversationName": "General chat",
    "text": "hi", "textTruncated": false, "mode": "agent", "models": ["grok-4.6"],
    "inputTokens": 0, "outputTokens": 0, "responses": 2
  }]
}
```

Read from `cursorDiskKV`: `composerData:<id>` (chat name, message order) and `bubbleId:<composerId>:<bubbleId>`
(`type` 1 = the person's prompt, 2 = AI response/tool step; `createdAt`; `modelInfo.modelName`, which
Cursor 3 stores on the **prompt** bubble). Each sync re-sends the last few days; rows upsert on
`(owner_user_id, prompt_uid)`.

**Cursor 3 writes `tokenCount: {inputTokens: 0, outputTokens: 0}` for every bubble**, and stores
`cursorAuth/accessToken` encrypted (`cursor…:v1:` + Windows DPAPI), so neither local tokens nor the
cursor.com usage API is available to the extension. That's why tokens come from the CSV.

## Usage CSV → `/usage/upload`

cursor.com → Dashboard → Usage → Export CSV. Raw `text/csv` body; `?account_email=` names the Cursor
login it was exported from. Confirmed header (2026-10-29):

```
Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost
"2026-10-29T05:44:08.933Z","","","free","cursor-grok-4.6-medium","No","0","46637","98304","2557","147498","0.16"
```

Columns are found by name (`csv_import.py`). Rows dedupe on `(cursor_account_email, event_uid)`, so
overlapping or repeated uploads never double count. `Cost` of "Included"/blank is stored as unknown.

## Matching (read time, `matching.py`)

The export has no person or computer. Each row goes to the prompt that was running at that moment
on the same Cursor login: one person running → theirs; several → whoever was on that model; still
several → split by agent steps, marked shared. Cursor bills **one request per prompt** but logs it up
to ~15s *before* the prompt appears locally (observed 10s and 14s on 2026-10-29), so a request that
lands while the previous prompt already has its request goes to the same person's next prompt. Rows
nobody claimed are **Unassigned**, so people + Unassigned = the CSV's total.

## Known gaps

- No Task/Client mapping: there's no way to gate a prompt inside the IDE.
- The extension only runs while a Cursor **IDE** window is open; Cursor 3's Agents window doesn't load
  third-party extensions.
- Tokens/cost lag until the next CSV upload; cards show "Waiting for CSV" meanwhile.

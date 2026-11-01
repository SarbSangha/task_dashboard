# Figma AI credit capture

What the browser extension sends and where each figure comes from. Checked live on
2026-10-30 (Starter plan, the agent in Figma Design).

## Figma's own endpoints (read in the page by `content-figma-network.js`)

| What | Request | Used for |
|---|---|---|
| A prompt | `POST /api/cortex/assistant/chat`. Body: `message.clientId`, `message.createdAtMs`, `message.content[].text`, `thread.threadId`, `thread.fileKey`, `userMessageOrigin`. The reply is a `text/event-stream` with `usage-info`, `prompt-outcome` and other events, plus an `x-cortex-request-uuid` header. | The prompt's id, text, file and thread |
| One prompt's cost | `GET /api/files/{fileKey}/ai_credits/plan_user_action_credit_usage?user_action_uuid={clientId}` returns `meta.total_credit_usage` and `meta.total_credit_cost`. | `credits_used` and `credit_cost` |
| Account balance | `GET /api/plans/{planId}/ai_credits/plan_user_usage_summary` returns `usage_summary.metering_period` and `usage_buckets[type=seat].balances[0]` (`total`/`consumed`/`remaining`), plus `daily_usage`. | `figma_balance_snapshots` |

`user_action_uuid` is `message.clientId`. In the live check:
- Prompts priced at 24, 8 and 4 credits returned a total of 36 from the batch `POST` of the same uuids.
- The account's monthly `consumed` went up by exactly the new prompts: 122, then 134, then 138.
- The same prompt ("hi") cost 8 the first time and 4 later, so each cost is read from Figma, never estimated.

The person's identity comes from `window.INITIAL_OPTIONS`, which supplies `user_data.id`, `user_data.email`, `plan_id`, `plan_tier` and `editing_file.key/name`. `user_data` also holds Figma's own tokens; those are never read.

## Extension to backend

`POST /api/providers/figma/capture/events` accepts `{events: [...]}`. Each event carries the tab's dashboard launch `usage_ticket` / `extension_ticket`. The Figma login is a shared company account, so the ticket is what identifies the person.

There are two event types:

- **`prompt`**: `client_event_id` is the uuid, with `:costed` appended once credits are known. The payload has:
  - `userActionUuid`, `requestUuid`, `threadId`, `fileKey`, `fileName`, `origin`, `promptText`, `promptLength`
  - `promptedAtMs`, `finishedAtMs`, `outcome`, `credits`, `creditCost`
  - `toolCalls`, `workMs`, `figmaUserId`, `figmaEmail`, `planId`, `planTier`, `pageUrl`

  The backend upserts on `userActionUuid`. A prompt that first arrives without credits is filled in when they arrive, and nothing else ever changes.
- **`balance`**: the account's bucket at a moment. An unchanged balance is not stored twice.

The extension asks for a prompt's cost 1.5s, 3s, 6s, 12s, 25s and 50s after the reply ends, and stops as soon as Figma returns a number above 0. A 0 is trusted only on the last try. If the tab closes first, the prompt is sent without credits and stays `pending`.

## Credit report

`FigmaPrompt` is a subscription tool source in `utils/credit_report/facts.py`. The account's fee is shared across its prompts in proportion to `credits_used`, the same way Freepik's fee is shared across `credits_charged`.

## Known gaps

- No Task/Client picker. A prompt is sent from Figma's own chat box, and its cost is only known after the reply.
- AI used outside a dashboard-launched browser tab is not captured: the desktop app, another browser, or Figma Make's own page. The account card shows these credits as "not captured", meaning Figma's monthly `consumed` minus the captured prompts.

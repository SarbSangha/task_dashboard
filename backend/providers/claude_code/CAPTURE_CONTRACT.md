# Claude Code capture contract

Claude Code (the terminal CLI and the VS Code extension) is a desktop agent, so it isn't captured by
the browser extension. It reports its own usage through OpenTelemetry instead: with telemetry switched on,
Claude Code posts an event for every prompt and every model call, as OTLP/HTTP JSON, to the endpoint in its
settings. This provider is that endpoint.

| What | Source | Endpoint |
|---|---|---|
| Who prompted, when, what | Claude Code `user_prompt` event | `POST /api/providers/claude-code/otlp/v1/logs` |
| Model, tokens, cost per model call | Claude Code `api_request` event | same |

Nothing is matched by timing (unlike Cursor's CSV): every `api_request` carries its own tokens and
`cost_usd`, and `prompt.id` ties it to the prompt that caused it.

## Identity: the Cursor connection's computer, a second token

There is no separate setup. A computer is first connected for a person the Cursor way (admin setup code →
**Cursor Tracker: Connect to dashboard**, see `providers/cursor/CAPTURE_CONTRACT.md`). Then
**Cursor Tracker: Connect Claude Code on this computer** (extension 1.5.0+):

1. The extension calls `POST /connect` with its Cursor tracker token and `device.id`, exactly as it
   authenticates `/capture/prompts`. The response is a `cct_...` token for **that computer's person**,
   plus `otlpPath`. The server keeps only its sha256 in `claude_code_tokens`, linked to the `cursor_devices` row.
2. The extension writes Claude Code's `env` settings into `~/.claude/settings.json` (or
   `$CLAUDE_CONFIG_DIR/settings.json`), keeping everything else in the file and a `.bak` copy:

   ```json
   "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
   "OTEL_LOGS_EXPORTER": "otlp",
   "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
   "OTEL_EXPORTER_OTLP_ENDPOINT": "https://<dashboard>/api/providers/claude-code/otlp",
   "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer cct_...",
   "OTEL_LOGS_EXPORT_INTERVAL": "5000",
   "OTEL_LOG_USER_PROMPTS": "1"
   ```

   Claude Code appends `/v1/logs`. `OTEL_LOG_USER_PROMPTS` follows the extension's `sendPromptText` setting.
   This file is shared by the CLI and the VS Code extension, so both are covered.

The `cct_` token has to sit in plain text there (Claude Code reads exporter headers from its settings), which is
why it's a separate credential from the Cursor tracker token kept in the OS credential store. It can only
**add Claude Code events for its own person**; it reads nothing. It's accepted only while:

- it is the computer's latest Claude Code token (`/connect` again replaces it; the extension's
  **Stop tracking Claude Code** calls `POST /disconnect`),
- the computer's Cursor connection is active (an admin's **Disconnect**, or reconnecting the computer for
  someone else, stops it too), and
- the person still exists and is active.

The person never comes from anything Claude Code sends (`OTEL_RESOURCE_ATTRIBUTES` is ignored). `user.email`
(the Claude login) is stored only for display.

## Claude Code → `/otlp/v1/logs`

`application/json` (gzip allowed). Protobuf gets `415 Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. `/v1/metrics` and
`/v1/traces` are accepted and dropped. Attributes read (names from code.claude.com/docs/en/monitoring-usage):

| Event | Attributes |
|---|---|
| all | `event.name`, `event.timestamp` (else `timeUnixNano`), `session.id`, `prompt.id`, `terminal.type`, `user.email`; resource `service.version` |
| `user_prompt` | `prompt_text` (2.1.287+) or `prompt` — `<REDACTED>` unless `OTEL_LOG_USER_PROMPTS=1`; `prompt_length`; `command_name` |
| `api_request` | `request_id`, `model`, `cost_usd` (else `cost_usd_micros`), `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `duration_ms` |

Other events (`tool_result`, `api_error`, ...) are ignored. Prompts upsert on `(owner_user_id, prompt.id)` and
requests on `(owner_user_id, request_id)`, so exporter retries never double count. Without `prompt.id` (older
Claude Code) the prompt key is `<session.id>:<epoch ms>`, and the view gives a request to the latest earlier prompt in
its session.

## Read side: `GET /view?from_ms=&to_ms=`

One row per prompt with its requests' summed tokens/cost, per-person totals, and the period total. Requests without a
prompt form one row per session (`hasPrompt: false`): Claude Code makes small background model calls with no
`prompt.id` (seen on 2.1.312: a Haiku call just before the first prompt of `claude -p`), and a prompt can fall just
before the period. So the total is always the sum of every request's `cost_usd`. The session fallback above only
applies to prompts that had no `prompt.id` themselves, so background calls are never folded into a typed prompt.
`terminal.type` is `non-interactive` for `claude -p`/scripts.
`GET /connections` lists the computers reporting Claude Code.

## Known gaps

- `cost_usd` is Claude Code's own estimate at API list prices. On a Pro/Max/Team subscription nobody is billed that
  per request; it measures each person's share of the plan.
- Tracking starts when a computer is connected; earlier usage isn't sent.
- Claude Code only sends while it's running, and drops a batch the server rejects. A batch larger than the reverse
  proxy's body limit (nginx defaults to 1 MB, e.g. a huge pasted prompt) is lost - raise `client_max_body_size` for
  this path if that happens.
- `terminal.type` is `vscode` both for the VS Code extension and for `claude` run in VS Code's integrated terminal,
  so the "VS Code" label covers both.
- An organization's managed Claude Code settings override user settings; if they set an OTEL endpoint, this one is
  dropped.
- A computer without Cursor or VS Code (terminal-only Claude Code) can't run the extension; it needs VS Code
  installed once to connect.

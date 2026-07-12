# Network Discovery Walkthrough Guide (Phase 2B, step 1)

For whoever has a logged-in ChatGPT account and 15-20 minutes. Goal: capture
real network traffic for the actions below so `NETWORK_ENDPOINTS.md` can be
written from *observed* behavior, not assumptions - see
`EXTENSION_CAPTURE_DESIGN.md` Section 1.

## Fastest method: one HAR export

1. Open `chatgpt.com` in Chrome, log in, open DevTools (F12) -> **Network** tab.
2. Check **Preserve log** and **Disable cache** (the latter stops cached
   responses from hiding requests that would otherwise re-fire). Optionally
   filter to **Fetch/XHR** (hides static asset noise) - but for the
   streaming-response step below, also check the unfiltered view at least
   once, since some browsers file `EventSource`/`fetch`-stream traffic
   slightly differently than XHR.
3. Clear the log, then perform **all** of the actions in the checklist
   below, in order, in one session (don't clear the log between them).
4. Right-click anywhere in the Network panel -> **Save all as HAR with
   content** (important: "with content", not the plain HAR - we need
   response bodies, not just headers).
5. Send me the `.har` file (or, if you'd rather not share the whole session,
   open it in a text editor and copy just the request/response blocks for
   each action below - HAR is just JSON).

**Optional but genuinely helpful**: keep a running two-column note (Action,
Approximate Time) as you go - e.g. "Send prompt — 10:02:40", "Rename —
10:03:30". A HAR's requests are sorted by timestamp, so a rough clock next
to each action makes matching "this specific request" to "that specific
action" much faster than guessing from payload content alone.

**Feel free to redact/replace your actual prompt text** with a placeholder
like `"test prompt 1"` if you don't want real conversation content in the
file - the field *names* and *shapes* are what matter, not the content.

## Checklist - perform each of these once

| # | Action | What I need to see in the capture |
|---|---|---|
| 1 | Start a **brand new conversation** (no prior messages) and send one prompt | The request that creates a conversation + returns its id for the first time |
| 2 | Watch the **assistant's response stream in** | The full sequence of chunks from "typing starts" to "done" - this is the one I most need the raw shape of |
| 3 | **Rename** the conversation (via the sidebar menu or title click) | The rename request/response |
| 4 | **Edit** a previous message you sent, then let it regenerate | The edit request (should differ from a fresh prompt - likely references the message being replaced) |
| 5 | Use **Regenerate** on an assistant response (no edit, just regenerate) | How this differs from #4 - which message it references |
| 6 | **Archive** the conversation, then **unarchive** it | Both requests |
| 7 | **Delete** a (test) conversation | The delete request |
| 8 | **Pin** a conversation, if that feature is visible to you | The pin request, if one exists |
| 9 | Ask ChatGPT to **generate an image** | How the generated image shows up in the network log - a distinct request, or embedded in the response stream? |
| 10 | If you have access to code interpreter / canvas / any artifact-producing feature, trigger one | Same question as #9 for that output type |
| 11 | **Upload a file** as a prompt attachment | The upload request (separate from the prompt send, or bundled into it?) |
| 12 | **Download** something ChatGPT generated (an image, a code file, etc.) | Is this a normal file download (easy to observe) or something else? |
| 13 | Switch between **two existing conversations** using the sidebar (open an existing one, not a new one) | Confirms whether this is a client-side route change only, or triggers a network call to fetch that conversation's history |
| 14 | **Switch models** mid-conversation (e.g. GPT-5 <-> GPT-4.1) and send a prompt after switching | Whether the model choice shows up as a distinct field in the prompt request, and whether switching alone (no prompt) fires anything |

## What to note per action (if not just sending the HAR)

For each numbered action, jot down:
- **Endpoint** (path, e.g. `/backend-api/conversation`)
- **Method** (GET/POST/PATCH/DELETE)
- **Request body** shape (field names - redact actual prompt text if you want)
- **Response body** shape - for the streaming one (#2 - the most important),
  note whether it's `Content-Type: text/event-stream` and what a few raw
  `data:` lines look like, since that's the exact thing
  `content-chatgpt-network.js` needs to parse
- **Can capture?** - your gut read on whether this looks cleanly
  interceptable via `fetch`/`XHR`/`EventSource` override, or whether it seems
  to need DOM observation instead

## What happens after

I'll turn whatever you send (HAR file or notes) into `NETWORK_ENDPOINTS.md`
(Endpoint / Method / Purpose / Request / Response / Can Capture columns, per
your original request), then design `content-chatgpt-network.js`'s actual
interception regexes against it - only then does Phase 2B move into writing
extension code.

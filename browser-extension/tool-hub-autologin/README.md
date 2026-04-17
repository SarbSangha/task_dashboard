# RMW Tool Hub Auto Login Extension

This Chrome extension is the company auto-fill layer for complex login pages such as ChatGPT/OpenAI, Freepik, and Kling AI.

## What It Does

- Runs on `chatgpt.com`, `chat.openai.com`, `auth.openai.com`, `freepik.com`, and Kling AI domains such as `kling.ai`.
- Syncs the dashboard session token automatically when the dashboard is open in another tab.
- Requests the assigned tool credential from the Tool Hub backend only after a login field is detected.
- Requires a dashboard-triggered launch each time before the extension can request a tool credential.
- Does not authorize direct revisits outside the dashboard flow.
- For supported sites like Freepik, the extension can clear the stored website session so users must launch again from the dashboard.
- Pushes the logged-out landing page into the login flow when needed, then fills the email and password fields in the user's real browser tab.
- Does not store the password in Chrome storage.
- Does not create or transfer an OpenAI session cookie. OpenAI may still require CAPTCHA, 2FA, or device checks.

## Backend Requirements

The dashboard user must be logged in, and the tool must be configured in Tool Hub:

- Tool slug: `chatgpt`, `freepik`, or `kling-ai` if the extension is using slug matching.
- Launch mode: `Extension auto-fill`.
- Credential: company or user-specific username/password.

The extension calls:

```text
POST /api/it-tools/extension/credential
```

## Local Chrome Install

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this folder:

```text
browser-extension/tool-hub-autologin
```

## Configure

Click the extension icon and set:

```text
Backend API URL: https://dashboard.ritzmediaworld.in
```

If cookie authentication does not work in your environment, the extension will try to sync the dashboard session token automatically while the dashboard is open. You can still paste the token manually into `Session token optional` if needed.

The dashboard stores that token under:

```text
rmw_session_token_v1
```

## Expected User Flow

1. User opens the dashboard.
2. User clicks the supported tool card.
3. The tool opens in a new tab.
4. The extension moves the logged-out landing page to the login step if needed.
5. Extension requests the assigned credential from the backend.
6. Extension fills email/password and clicks the login button when possible.
7. Direct revisits outside the dashboard are not authorized. Users must start from the dashboard again.

If the website shows CAPTCHA, 2FA, passkey, or device verification, the user must complete that step manually.

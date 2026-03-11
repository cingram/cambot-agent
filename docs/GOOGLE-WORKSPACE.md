# Google Workspace MCP Integration

Google Workspace (Gmail, Calendar, Tasks, Drive, Docs, Sheets) is available to agents via the [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) server.

---

## Architecture

```
+----------------- HOST (Node.js) --------------------+
|                                                      |
|  workspace-mcp-service.ts                            |
|       |                                              |
|       v                                              |
|  uvx workspace-mcp (Python)                          |
|  listening on http://127.0.0.1:{port}/mcp            |
|                                                      |
+---------------------------|---------------------------+
                            | host.docker.internal
+---------------------------|---------------------------+
|  CONTAINER (Docker)       |                           |
|                           v                           |
|  Claude Agent SDK ---> mcp-servers.json               |
|    type: "http"                                       |
|    url: http://host.docker.internal:{port}/mcp        |
|                                                       |
|  Agent uses tools like:                               |
|    mcp__google-workspace__search_gmail_messages        |
|    mcp__google-workspace__list_calendar_events         |
|    mcp__google-workspace__search_drive_files           |
+-------------------------------------------------------+
```

**Key design decisions:**

- Python/uv run on the **host only** -- no Python in the container image
- The MCP server is a **persistent process** managed by `workspace-mcp-service.ts` (auto-restart, health checks, graceful shutdown)
- Containers reach the host via Docker's `host.docker.internal` DNS
- OAuth tokens live on the host at `~/.google_workspace_mcp/credentials/`

---

## Setup

### 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com
2. Create a new project or select an existing one
3. Note the project ID

### 2. Enable APIs

In the Google Cloud Console, go to **APIs & Services > Library** and enable:

- Gmail API
- Google Calendar API
- Google Tasks API
- Google Drive API
- Google Docs API
- Google Sheets API

Enable only what you need -- each adds OAuth scopes that the consent screen shows.

### 3. Create OAuth credentials

1. Go to **APIs & Services > Credentials**
2. Click **+ CREATE CREDENTIALS > OAuth client ID**
3. If prompted, configure the consent screen:
   - Choose **External** (or Internal for Workspace orgs)
   - App name: anything (e.g., "CamBot")
   - User support email: your email
   - Authorized domains: leave empty for desktop app
   - Developer contact: your email
4. Application type: **Web application** (workspace-mcp uses a redirect-based flow with PKCE)
5. Add **Authorized redirect URI**: `http://localhost:8000/oauth2callback`
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

### 4. Configure `.env`

Add these to your `.env` file in the cambot-agent root:

```env
GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-your-secret
USER_GOOGLE_EMAIL=your-email@gmail.com
WORKSPACE_MCP_PORT=8000        # optional, default 8000
```

### 5. First-time OAuth consent

Run the service once to trigger the browser consent flow:

```bash
OAUTHLIB_INSECURE_TRANSPORT=1 uvx --from "git+https://github.com/taylorwilsdon/google_workspace_mcp" workspace-mcp --transport streamable-http --single-user
```

A browser window opens. Sign in with your Google account and grant access. The token is saved to:

```
~/.google_workspace_mcp/credentials/<your-email>.json
```

Once you see `Uvicorn running on http://127.0.0.1:8000`, press Ctrl+C. The refresh token persists -- you won't need to re-authorize unless you revoke access.

### 6. Verify

Start the service again and test:

```bash
# Start workspace-mcp
OAUTHLIB_INSECURE_TRANSPORT=1 \
GOOGLE_OAUTH_CLIENT_ID=... \
GOOGLE_OAUTH_CLIENT_SECRET=... \
USER_GOOGLE_EMAIL=... \
uvx --from "git+https://github.com/taylorwilsdon/google_workspace_mcp" workspace-mcp --transport streamable-http --single-user

# In another terminal, test the MCP endpoint
curl -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

You should get a response with `"name":"google_workspace"` in `serverInfo`.

---

## How It Works

### Host side

`src/integrations/registry.ts` defines the `mcp:google-workspace` integration. On startup, `workspace-mcp-service.ts` spawns the Python process:

```
uvx --from git+https://github.com/taylorwilsdon/google_workspace_mcp \
  workspace-mcp --transport streamable-http --single-user
```

Environment variables passed to the process:

| Variable | Source | Purpose |
|----------|--------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | `.env` | OAuth client |
| `GOOGLE_OAUTH_CLIENT_SECRET` | `.env` | OAuth client |
| `USER_GOOGLE_EMAIL` | `.env` | Account to authenticate |
| `WORKSPACE_MCP_PORT` | `.env` (default 8000) | HTTP listen port |
| `WORKSPACE_MCP_HOST` | Hardcoded `127.0.0.1` | Bind address |
| `OAUTHLIB_INSECURE_TRANSPORT` | Hardcoded `1` | Allow HTTP (not HTTPS) locally |

The service has auto-restart (3 retries, exponential backoff) and health checks via HTTP GET.

### MCP server template

`container/mcp-servers.json` is the template for all MCP servers available to agents:

```json
{
  "google-workspace": {
    "type": "http",
    "url": "http://host.docker.internal:${WORKSPACE_MCP_PORT}/mcp"
  }
}
```

### Variable substitution (two-stage)

MCP config variables are substituted in two stages:

1. **Host-side** (`src/container/runner.ts`): Before writing `mcp-servers.json` to the group's session directory, the host substitutes `${WORKSPACE_MCP_PORT}` with the actual port from `.env`. This is the only host-side variable.

2. **Container-side** (`agent-runner/src/mcp-config.ts`): At runtime, the agent-runner substitutes `${SCRIPT_DIR}`, `${CHAT_JID}`, `${GROUP_FOLDER}`, and `${IS_MAIN}` for the stdio-based MCP servers (cambot-agent, workflow-builder).

### Container side

The Claude Agent SDK connects to the MCP server via HTTP:

```typescript
mcpServers: {
  "google-workspace": {
    type: "http",
    url: "http://host.docker.internal:8000/mcp"
  }
}
```

The SDK handles MCP protocol negotiation. The agent sees tools prefixed with `mcp__google-workspace__*`.

---

## Available Tools

The workspace-mcp server provides tools for all enabled Google services:

| Service | Example Tools |
|---------|--------------|
| Gmail | `search_gmail_messages`, `get_gmail_message`, `send_gmail_message`, `list_gmail_labels` |
| Calendar | `list_calendar_events`, `create_calendar_event`, `update_calendar_event` |
| Tasks | `list_task_lists`, `list_tasks`, `create_task`, `complete_task` |
| Drive | `search_drive_files`, `get_drive_file_content`, `list_drive_files` |
| Docs | `get_doc_content`, `create_doc` |
| Sheets | `get_spreadsheet`, `create_spreadsheet`, `update_spreadsheet_values` |

All tools require `user_google_email` as a parameter. The system prompt tells the agent to use the configured email automatically.

---

## Token Storage

OAuth tokens are stored at:

```
~/.google_workspace_mcp/credentials/<email>.json
```

This file contains:
- `token` -- short-lived access token (auto-refreshed)
- `refresh_token` -- long-lived, used to get new access tokens
- `scopes` -- all authorized Google API scopes
- `expiry` -- when the current access token expires

The refresh token does not expire unless:
- You revoke access at https://myaccount.google.com/permissions
- The OAuth client is deleted from Google Cloud Console
- The token goes unused for 6 months (Google policy for external apps)

---

## Troubleshooting

### Service won't start

```bash
# Check if uvx is available
which uvx

# Check if port is already in use
lsof -i :8000  # macOS/Linux
netstat -ano | findstr :8000  # Windows
```

### OAuth token expired / invalid

```bash
# Delete the token and re-authorize
rm ~/.google_workspace_mcp/credentials/<email>.json

# Re-run the consent flow
OAUTHLIB_INSECURE_TRANSPORT=1 uvx --from "git+https://github.com/taylorwilsdon/google_workspace_mcp" workspace-mcp --transport streamable-http --single-user
```

### Container can't reach host

Docker's `host.docker.internal` should resolve to the host. If it doesn't:

```bash
# Test from inside a container
docker run --rm alpine ping host.docker.internal
```

On Linux, you may need `--add-host=host.docker.internal:host-gateway` in the Docker run command. Check `src/container/runner.ts` for the `--add-host` flag.

### Agent doesn't see Google tools

1. Check that `WORKSPACE_MCP_PORT` is set in `.env`
2. Check that `container/mcp-servers.json` has the `google-workspace` entry
3. Check container logs for MCP connection errors:
   ```bash
   cat data/sessions/<group>/agent-runner-src/*.log
   ```

### Scopes missing

If the agent can access Gmail but not Calendar, the token may have been authorized with limited scopes. Delete the token and re-authorize -- workspace-mcp requests all scopes on consent.

---

## Adding / Removing the Integration

### Adding

1. Set the 3 required env vars in `.env`
2. Run first-time OAuth consent (see Setup step 5)
3. Restart cambot-agent -- the integration auto-detects from env vars

### Removing

1. Remove `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `USER_GOOGLE_EMAIL` from `.env`
2. Optionally delete `~/.google_workspace_mcp/`
3. Optionally revoke access at https://myaccount.google.com/permissions
4. Restart cambot-agent

The `google-workspace` entry in `mcp-servers.json` is harmless when the service isn't running -- the SDK will fail to connect and the agent simply won't have those tools.

---

## Switching Google Accounts

Each Google account gets its own credential file at `~/.google_workspace_mcp/credentials/<email>.json`. The active account is controlled by `USER_GOOGLE_EMAIL` in `.env`.

### Adding a new account

1. Update `.env`:
   ```env
   USER_GOOGLE_EMAIL=new-account@gmail.com
   ```
2. Restart cambot-agent. workspace-mcp will detect no credential file for the new account and open a browser for OAuth consent.
3. **Important:** When the browser opens, make sure you select the correct Google account. If multiple accounts are signed into Chrome, the account chooser appears — pick the one matching `USER_GOOGLE_EMAIL`. Selecting the wrong account will save tokens for the wrong account.
4. Grant all requested permissions. The token is saved to `~/.google_workspace_mcp/credentials/new-account@gmail.com.json`.

### Switching between existing accounts

```bash
# Edit .env
USER_GOOGLE_EMAIL=desired-account@gmail.com

# Restart the server
# workspace-mcp reads the credential file matching the configured email
```

Both credential files can coexist in `~/.google_workspace_mcp/credentials/`. workspace-mcp only loads the one matching `USER_GOOGLE_EMAIL`.

### Manual OAuth script

If workspace-mcp's auto-open browser flow doesn't work (e.g., it picks the wrong Chrome profile), use the manual auth script:

```bash
# Stop cambot-agent first (frees port 8000)
uv run --with google-auth scripts/google-auth.py
```

This opens a browser on a separate port with `login_hint` set to the target email, then saves the token in workspace-mcp's expected format.

### Common pitfalls

- **Never copy one account's credential file to another.** Each account needs its own OAuth flow to get a unique refresh token. A copied file will authenticate as the original account.
- **Wrong account selected during OAuth.** If Chrome auto-selects the wrong account, click "Use another account" on the account chooser. The `ensureGoogleAuth` startup check does not include `login_hint`, so Google may default to the first signed-in account.
- **Old credential file interference.** If OAuth keeps failing, check that there isn't a stale credential file with the wrong account's refresh token. Delete it and re-authorize:
  ```bash
  rm ~/.google_workspace_mcp/credentials/<email>.json
  # Restart server to trigger fresh OAuth
  ```
- **Verify token ownership.** To confirm which account a token belongs to:
  ```bash
  python3 -c "
  import json, pathlib, urllib.request, urllib.parse
  p = pathlib.Path.home() / '.google_workspace_mcp' / 'credentials' / '<email>.json'
  d = json.loads(p.read_text())
  data = urllib.parse.urlencode({'client_id': d['client_id'], 'client_secret': d['client_secret'], 'refresh_token': d['refresh_token'], 'grant_type': 'refresh_token'}).encode()
  resp = json.loads(urllib.request.urlopen(urllib.request.Request('https://oauth2.googleapis.com/token', data=data, method='POST')).read())
  info = json.loads(urllib.request.urlopen(urllib.request.Request('https://www.googleapis.com/oauth2/v3/userinfo', headers={'Authorization': f'Bearer {resp[\"access_token\"]}'})).read())
  print(f'Token belongs to: {info[\"email\"]}')
  "
  ```

---

## Related Files

| File | Purpose |
|------|---------|
| `src/utils/workspace-mcp-service.ts` | Host-side process manager (spawn, health check, restart) |
| `src/integrations/registry.ts` | Integration definition with requirement checks |
| `container/mcp-servers.json` | MCP server template (includes google-workspace entry) |
| `agent-runner/src/mcp-config.ts` | Container-side config loader with variable substitution |
| `src/container/runner.ts` | Host-side variable substitution before mounting into container |
| `groups/global/CLAUDE.md` | Agent instructions mentioning Google Workspace tools |
| `src/channels/email.ts` | Email channel (uses workspace-mcp for Gmail polling) |

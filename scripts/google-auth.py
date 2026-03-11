#!/usr/bin/env python3
"""
Google OAuth for workspace-mcp — Web Application client flow.

Does NOT use InstalledAppFlow (which adds PKCE incompatible with Web clients).
Runs its own callback server and exchanges the code manually.

Usage:
    1. Stop cambot-agent server (frees port 8000)
    2. uv run --with google-auth scripts/google-auth.py
    3. Sign in with the target account in the browser
    4. Restart cambot-agent server

Options:
    --email EMAIL   Target email (default: camingram810@gmail.com)
"""

import argparse
import json
import sys
import webbrowser
from datetime import datetime, timezone, timedelta
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs
import urllib.request

CALLBACK_PORT = 8085
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}/"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

# Full scope list matching workspace-mcp — comment out any that cause issues
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    # Gmail
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.labels",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    # Calendar
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    # Tasks
    "https://www.googleapis.com/auth/tasks",
    "https://www.googleapis.com/auth/tasks.readonly",
    # Drive
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.file",
    # Docs
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/documents.readonly",
    # Sheets
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    # Slides
    "https://www.googleapis.com/auth/presentations",
    "https://www.googleapis.com/auth/presentations.readonly",
    # Contacts
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/contacts.readonly",
    # Forms
    "https://www.googleapis.com/auth/forms.body",
    "https://www.googleapis.com/auth/forms.body.readonly",
    "https://www.googleapis.com/auth/forms.responses.readonly",
    # Chat
    "https://www.googleapis.com/auth/chat.spaces",
    "https://www.googleapis.com/auth/chat.spaces.readonly",
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/chat.messages.readonly",
    # Apps Script
    "https://www.googleapis.com/auth/script.projects",
    "https://www.googleapis.com/auth/script.projects.readonly",
    "https://www.googleapis.com/auth/script.deployments",
    "https://www.googleapis.com/auth/script.deployments.readonly",
    "https://www.googleapis.com/auth/script.metrics",
    "https://www.googleapis.com/auth/script.processes",
    # Search
    "https://www.googleapis.com/auth/cse",
]


auth_code = None


class CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global auth_code
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/oauth2callback"):
            params = parse_qs(parsed.query)
            if "code" in params:
                auth_code = params["code"][0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<h1>Success!</h1><p>You can close this tab and return to the terminal.</p>")
            else:
                error = params.get("error", ["unknown"])[0]
                self.send_response(400)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(f"<h1>Error: {error}</h1>".encode())
        else:
            # Ignore favicon and other browser requests
            self.send_response(204)
            self.end_headers()

    def log_message(self, *args):
        pass


def main():
    global auth_code

    parser = argparse.ArgumentParser(description="Google OAuth for workspace-mcp")
    parser.add_argument("--email", default="camingram810@gmail.com", help="Target Google account email")
    args = parser.parse_args()

    target_email = args.email
    token_path = Path.home() / ".google_workspace_mcp" / "credentials" / f"{target_email}.json"

    env_path = Path(__file__).parent.parent / ".env"
    env_vars = {}
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env_vars[k.strip()] = v.strip()

    client_id = env_vars["GOOGLE_OAUTH_CLIENT_ID"]
    client_secret = env_vars["GOOGLE_OAUTH_CLIENT_SECRET"]

    print(f"Google OAuth for workspace-mcp")
    print(f"Account: {target_email}")
    print(f"Callback: {REDIRECT_URI}")
    print(f"Scopes: {len(SCOPES)}")
    print()

    # Start callback server with a timeout so Ctrl+C works
    try:
        server = HTTPServer(("localhost", CALLBACK_PORT), CallbackHandler)
        server.timeout = 1  # 1s poll so KeyboardInterrupt is catchable
    except OSError:
        print(f"ERROR: Port {CALLBACK_PORT} is in use.")
        sys.exit(1)

    # Build auth URL — plain OAuth 2.0, no PKCE
    auth_url = "https://accounts.google.com/o/oauth2/auth?" + urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "login_hint": target_email,
    })

    print("Opening browser...")
    webbrowser.open(auth_url)
    print("Waiting for authorization (Ctrl+C to cancel)...\n")

    try:
        while auth_code is None:
            server.handle_request()
    except KeyboardInterrupt:
        print("\nCancelled.")
        server.server_close()
        sys.exit(1)

    server.server_close()
    print(f"Authorization code received. Exchanging for tokens...")

    # Exchange code for tokens (with timeout)
    data = urlencode({
        "code": auth_code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(TOKEN_ENDPOINT, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            tokens = json.loads(resp.read())
    except Exception as e:
        print(f"ERROR exchanging code for tokens: {e}")
        sys.exit(1)

    if "error" in tokens:
        print(f"ERROR: {tokens}")
        sys.exit(1)

    # Save in workspace-mcp format
    token_path.parent.mkdir(parents=True, exist_ok=True)
    saved = {
        "token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token"),
        "token_uri": TOKEN_ENDPOINT,
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": SCOPES,
    }
    if "expires_in" in tokens:
        saved["expiry"] = (datetime.now(timezone.utc) + timedelta(seconds=tokens["expires_in"])).isoformat()

    token_path.write_text(json.dumps(saved, indent=2))

    print(f"\nToken saved to {token_path}")
    print(f"Refresh token: {'yes' if saved.get('refresh_token') else 'NO'}")
    print("\nRestart cambot-agent server now.")


if __name__ == "__main__":
    main()

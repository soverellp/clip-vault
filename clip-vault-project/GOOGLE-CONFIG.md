# GOOGLE-CONFIG (kept for later; server mode only)

> **TL;DR** Google sign-in is NOT used by the current plan (static mode, [DECISIONS.md](DECISIONS.md) D25). This file records the Google Cloud setup the user already made, so server mode (D27) can be switched on later without redoing it. Public values only. There is NO client secret and none is needed.

Recorded 2026-11-17 (decision D28).

## What exists (as told by the user; I could not look inside the Google console)
| Item | Value | Verified? |
|---|---|---|
| Google Cloud project | `clip-vault` | user-reported |
| OAuth consent screen | user type External, publishing status Testing | user-reported |
| Test user | `soverellp@gmail.com` | user-reported; which OTHER consent-screen fields the user entered (app name, support email, logo, scopes): UNVERIFIED |
| OAuth client type | Web application | user-reported |
| OAuth web client id | `930218503634-5jhe7tdihak0s31hfpqps0vpbeg644eq.apps.googleusercontent.com` | public value, not a secret |
| Authorized JavaScript origin | `https://soverellp-clip-vault-site.hf.space` | user-reported |
| Authorized redirect URIs | none (Google Identity Services needs none) | by design |
| Client secret | none created, none stored, none needed | by design |

The client id is public by design: it appears in the page and in the Space variable `GOOGLE_CLIENT_ID` (server mode). It grants nothing by itself.

## Where it is used
- Server mode only: `site/hfspace` (`auth.py` verifies the Google ID token and a nonce). See [ARCHITECTURE.md](ARCHITECTURE.md) "Server mode" and [API-CONTRACT.md](API-CONTRACT.md).
- Static mode (current plan) does not load Google scripts and does not need this client.
- Server mode also needs a host that runs Python: a paid HF Space (D23) or a Cloudflare Worker port (D31). Until then this stays parked.

## Limits to remember
- Testing mode: only listed test users can sign in and consent may expire after about 7 days. Publish to Production to lift that (an External app with only basic sign-in scopes needs no verification review; UNVERIFIED for this account).
- If the Space origin changes (a different host), add the new origin to Authorized JavaScript origins.

## Recreate (about 10 minutes, the user does the clicks)
1. console.cloud.google.com > create or select the project `clip-vault`.
2. APIs and Services > OAuth consent screen: External, app name "Clip Vault", add your address as a test user.
3. Credentials > Create credentials > OAuth client ID > Web application; Authorized JavaScript origin = the Space URL; leave redirect URIs empty; do NOT download a client secret.
4. Copy the client id (public) into the Space variable `GOOGLE_CLIENT_ID`.

## Delete (about 3 minutes)
1. Credentials > the web client > Delete (sign-in stops at once).
2. Optional: IAM and Admin > Settings > Shut down the project `clip-vault`.
3. Note it in [CHANGELOG.md](CHANGELOG.md). Details also in [../migration-setup/REVOKE-AND-SECURITY.md](../migration-setup/REVOKE-AND-SECURITY.md).

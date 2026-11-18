"""Google sign-in: the ONLY module that talks to Google. verify_google_credential() is the single entry point."""
import hmac
import threading
import time

import requests
from google.auth.transport import requests as g_requests
from google.oauth2 import id_token

GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
GOOGLE_TIMEOUT = (3, 5)  # (connect, read) seconds for the certs fetch
VERIFY_DEADLINE = 8.0  # hard limit for one verification (seconds)
CLOCK_SKEW = 10
CERT_TTL = 600
GOOGLE_CONCURRENCY = 8
google_sem = threading.BoundedSemaphore(GOOGLE_CONCURRENCY)


class CredentialError(Exception):
    """Raised for any reason a Google credential is not acceptable. The message is a fixed word, never upstream text."""


class _Transport(g_requests.Request):
    """google-auth transport with a hard timeout and a small in-memory cache of Google's public certificates."""

    def __init__(self):
        super().__init__(requests.Session())
        self._cache = {}

    def __call__(self, url, method="GET", body=None, headers=None, timeout=None, **kwargs):
        hit = self._cache.get(url)
        if method == "GET" and hit and time.monotonic() - hit[0] < CERT_TTL:
            return hit[1]
        resp = super().__call__(url, method=method, body=body, headers=headers, timeout=GOOGLE_TIMEOUT, **kwargs)
        if method == "GET" and getattr(resp, "status", 0) == 200:
            self._cache[url] = (time.monotonic(), resp)
        return resp


_transport = _Transport()


def check_claims(claims, client_id: str, nonce: str, now: float = None) -> dict:
    """Pure app-side validation of already signature-checked claims. Raises CredentialError."""
    now = time.time() if now is None else now
    if not isinstance(claims, dict) or not client_id or not nonce:
        raise CredentialError("claims")
    aud = claims.get("aud")
    if not (aud == client_id or (isinstance(aud, list) and client_id in aud)):
        raise CredentialError("aud")
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise CredentialError("iss")
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp + CLOCK_SKEW < now:
        raise CredentialError("exp")
    if claims.get("email_verified") is not True:
        raise CredentialError("email_verified")
    email, sub, n = claims.get("email"), claims.get("sub"), claims.get("nonce")
    if not isinstance(email, str) or not email or len(email) > 254 or not isinstance(sub, str) or not sub or len(sub) > 128:
        raise CredentialError("identity")
    if not isinstance(n, str) or not hmac.compare_digest(n.encode(), nonce.encode()):
        raise CredentialError("nonce")
    return claims


def verify_google_credential(credential: str, nonce: str) -> dict:
    """Verify a Google ID token (signature, audience, issuer, expiry via google-auth) and return its claims.

    The ONE function that calls Google; tests replace it. Blocking: call it in a worker thread. Raises CredentialError.
    """
    from common import _env
    client_id = _env("GOOGLE_CLIENT_ID")
    try:
        claims = id_token.verify_oauth2_token(credential, _transport, audience=client_id, clock_skew_in_seconds=CLOCK_SKEW)
    except Exception:
        raise CredentialError("verify") from None
    return check_claims(claims, client_id, nonce)

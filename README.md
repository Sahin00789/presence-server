# presence-server

Fastify + TypeScript backend for the Presence staff attendance, shift and payroll platform.

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
docker compose up -d   # postgres + redis
npm run db:migrate
npm run dev
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Watch-mode dev server |
| `npm run build` | Compile to `dist/` |
| `npm test` | Vitest suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` / `db:migrate` / `db:studio` | Drizzle migrations |
| `npm run db:clean` | Truncate all tables (requires `DATABASE_URL`) |

## Secrets

Nothing sensitive is committed. `GOOGLE_WEB_CLIENT_SECRET`, SMTP and Cloudinary
credentials belong in `.env` only (`.env` is gitignored); `.env.example` holds
placeholders.

## Google Sign-In (Android → this API)

Android never talks to Google's token endpoint with a secret — the secret stays
on the server. There are two supported flows; both end at the same endpoint:

```
POST /api/v1/auth/google/exchange
Content-Type: application/json
```

### 1. ID token flow (recommended)

The app signs in locally with Credential Manager / GoogleSignIn using the **web**
client ID as `serverClientId`, then posts the returned ID token:

```json
{
  "idToken": "<google-id-token>",
  "deviceName": "Pixel 8",
  "deviceType": "android",
  "osName": "Android 15"
}
```

The server verifies the token with Google, checks issuer, email verification and
that `aud` matches `GOOGLE_WEB_CLIENT_ID` or any ID in `GOOGLE_EXTRA_CLIENT_IDS`,
then issues app JWTs.

Response:

```json
{
  "accessToken": "…",
  "expiresIn": 900,
  "refreshToken": "…",
  "user": {
    "id": "…",
    "email": "user@example.com",
    "fullName": "…",
    "role": "OWNER",
    "organizationId": "…",
    "organizationName": "…"
  }
}
```

### 2. Server auth code flow

If the app uses `GoogleSignInOptions.requestServerAuthCode(webClientId)`, post the
code instead. **Do not send `redirectUri`** — Android server auth codes are not
bound to one, and Google answers `redirect_uri_mismatch` if you do:

```json
{
  "code": "<server-auth-code>",
  "codeVerifier": "<optional PKCE verifier, 43-128 chars>",
  "deviceName": "Pixel 8"
}
```

The server exchanges the code using `GOOGLE_WEB_CLIENT_ID` +
`GOOGLE_WEB_CLIENT_SECRET` and verifies the returned ID token. For browser
redirect flows, pass `redirectUri` (it must match `GOOGLE_REDIRECT_URI`) and the
`codeVerifier` if PKCE was used. If no secret is configured the endpoint answers
`400 CODE_EXCHANGE_NOT_CONFIGURED`, so a secret-less (Android-only) deployment
still boots and can serve the `idToken` flow.

### Google Cloud console checklist

1. OAuth consent screen configured; app in *Testing* with test users, or published.
2. **Web application** client → its ID is `GOOGLE_WEB_CLIENT_ID`, the secret goes in `.env`.
   Use this ID as the Android `serverClientId`; ID tokens then carry it as `aud`.
3. **Android** client → package name + signing SHA-1 (debug and release). Android /
   *installed* clients have **no client secret**, so they can only use the `idToken`
   flow — put their ID in `GOOGLE_EXTRA_CLIENT_IDS` (comma separated) so tokens
   minted for them are accepted too.
4. Browser flow only: add `<host>/api/v1/auth/google/callback` as an authorized
   redirect URI.


## Auth security model

- Access tokens: 15 min JWTs signed with `ACCESS_TOKEN_SECRET`; every request re-checks the
  session row, user and role in PostgreSQL, so logout, role changes and deactivations take
  effect immediately.
- Refresh tokens: opaque `rt_` + 384-bit random secrets, stored only as HMAC-SHA256
  (peppered with `REFRESH_TOKEN_SECRET`), rotated on every use with a 30 s replay grace window;
  reuse outside that window revokes the session.
- One active device per user: a new login revokes all prior sessions (`REPLACED_BY_NEW_LOGIN`).
- OTP codes: 6 digits, hashed at rest, 10 min TTL, single use, burned after 5 wrong guesses
  (`429 OTP_ATTEMPTS_EXCEEDED`).
- Rate limits (per IP unless authenticated): OTP request 5/min, OTP verify 10/min,
  Google exchange 10/min, owner registration 5/min, refresh 30/min.
- Google ID tokens are verified with Google, and the `iss`, `email_verified` and `aud`
  (against `GOOGLE_WEB_CLIENT_ID` + `GOOGLE_EXTRA_CLIENT_IDS`) claims are enforced.

### Errors

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MISSING_GOOGLE_CREDENTIAL` | 400 | Neither `idToken` nor `code` was sent |
| `INVALID_ID_TOKEN` / `INVALID_AUDIENCE` / `INVALID_ISSUER` | 401 | Token rejected by this server |
| `EMAIL_NOT_VERIFIED` | 401 | Google account email is not verified |
| `GOOGLE_AUTH_FAILED` | 401 | Code exchange failed (expired code, wrong client, stale redirect URI) |
| `NOT_REGISTERED` | 403 | Google account has no Presence account — owner must register first |
| `NO_MEMBERSHIP` / `ACCOUNT_DEACTIVATED` | 403 | Account exists but cannot sign in |

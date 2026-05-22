# Auth & Login System — Design Spec

**Date:** 2026-05-22
**Status:** Approved

## Overview

Add a real authentication system to the app. Currently anyone with the URL can access all pages. After this change, users must login with email + password. Sessions last 7 days via JWT stored in an httpOnly cookie.

## Requirements

- Each `AppUser` has their own password, set by the admin in Setup > Users
- Login with email + password
- Session lasts 7 days, no auto-logout unless expired or manual logout
- All pages/routes protected except `/login` and `POST /api/auth/login`

## Architecture

### JWT Cookie Session
- On successful login: create JWT containing `{ userId, email, name, role, permissions }`, store in httpOnly cookie `auth_token`, 7-day expiry
- `AUTH_SECRET` env var is the signing secret
- Cookie flags: `httpOnly: true`, `sameSite: strict`, `secure: true` in production
- Library: `jose` (already available in Next.js ecosystem) for JWT sign/verify

### Password Hashing
- Library: `bcryptjs`
- Salt rounds: 10
- Field: `passwordHash String?` on `AppUser` (nullable — users without a password cannot login)

## Data Layer

### Schema Change
Add to `AppUser` model in `prisma/schema.prisma`:
```prisma
passwordHash String?
```

Run `prisma migrate dev --name add_user_password_hash` after change.

## Components & Files

### New Files
| File | Purpose |
|------|---------|
| `src/middleware.ts` | Intercepts all requests, verifies JWT, redirects to /login if invalid |
| `src/app/login/page.tsx` | Login form (email + password) |
| `src/app/api/auth/login/route.ts` | POST — verify credentials, set cookie |
| `src/app/api/auth/logout/route.ts` | POST — clear cookie |
| `src/app/api/auth/me/route.ts` | GET — return current user from JWT |

### Modified Files
| File | Change |
|------|--------|
| `src/components/RoleGate.tsx` | Replace localStorage reads with fetch to `/api/auth/me` |
| `src/app/setup/users/page.tsx` | Add "Set Password" button per user |
| `src/app/api/users/[id]/route.ts` | Add PATCH handler for setting passwordHash |
| `.env` / `.env.example` | Add `AUTH_SECRET` |

## Flow Details

### Middleware (`src/middleware.ts`)
```
Every request →
  if path is /login or /api/auth/login → allow
  else → verify JWT from cookie auth_token
    valid → allow, pass user info via request header
    invalid/missing → redirect to /login
```

Matcher config: `['/((?!_next/static|_next/image|favicon.ico).*)']`

### Login Page (`/login`)
- Fields: Email, Password
- On submit: POST to `/api/auth/login`
- On success: redirect to `/`
- On error: show "Email hoặc password không đúng"
- No "forgot password" — admin resets via Setup > Users

### POST /api/auth/login
1. Find `AppUser` by email where `status = ACTIVE`
2. If not found or `passwordHash` is null → return 401
3. `bcrypt.compare(password, user.passwordHash)` → if false → return 401
4. Sign JWT with `{ userId, email, name, role, permissions }`, 7d expiry
5. Set `auth_token` cookie
6. Return `{ ok: true }`

### GET /api/auth/me
1. Read `auth_token` cookie
2. Verify JWT
3. Return `{ userId, email, name, role, permissions }`
4. If invalid → return 401

### POST /api/auth/logout
1. Clear `auth_token` cookie
2. Return `{ ok: true }`

### RoleGate Changes
- On mount: fetch `/api/auth/me` instead of reading localStorage
- If 401 (not logged in): middleware will have already redirected, this is a fallback
- Remove all localStorage.getItem/setItem for auth state
- Keep `RoleSwitcher` removed or replaced with logout button + current user display

### Setup > Users — Set Password
- Each user row gets a "Set Password" button
- Opens a modal: input field for new password (plain text entry, no confirm field)
- On submit: `PATCH /api/users/[id]` with `{ password: string }`
- API hashes with bcrypt and saves `passwordHash`

## Sidebar Changes
- Show current user name + role at bottom of sidebar
- Add "Logout" button that calls `POST /api/auth/logout` then redirects to `/login`

## Environment Variables
```
AUTH_SECRET=<random 32+ char string>
```

Generate with: `openssl rand -base64 32`

## Error States
| Scenario | Behavior |
|----------|---------|
| Wrong email/password | Generic error "Email hoặc password không đúng" (no hint which is wrong) |
| User status INACTIVE | Same generic error |
| No passwordHash set | Same generic error |
| JWT expired | Redirect to /login |
| JWT tampered | Redirect to /login |

## Out of Scope
- Forgot password / email reset
- Remember me toggle
- 2FA
- OAuth / social login

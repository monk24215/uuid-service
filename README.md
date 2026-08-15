# Keyed — CSV → UUID assignment tool

Passwordless web app: users sign in via a one-time email link (Resend),
upload a CSV (≤5000 rows) containing an email column, and export the same
CSV with a unique RFC 4122 v4 UUID appended to every row. Free role allows
5 uploads; limits are role-based and expandable.

## Stack
- Node.js + Express
- PostgreSQL (uses core `gen_random_uuid()`, no extensions required)
- Resend for transactional email (magic links)

## Environment variables
| Variable         | Required | Notes                                            |
|------------------|----------|--------------------------------------------------|
| `DATABASE_URL`   | yes      | Provided by Railway Postgres plugin              |
| `RESEND_API_KEY` | yes      | From resend.com                                  |
| `FROM_EMAIL`     | yes      | A verified Resend sender, e.g. no-reply@you.com  |
| `APP_URL`        | yes      | Public app URL, e.g. https://keyed.up.railway.app|
| `SESSION_SECRET` | yes      | Long random string (openssl rand -hex 32)        |
| `PORT`           | no       | Railway sets this automatically                  |

## Local development
```
npm install
# set the env vars above (a local Postgres works fine)
npm start
```

## Deploy on Railway
1. Push this repo to GitHub.
2. Create a project, add the **PostgreSQL** plugin.
3. Deploy this repo as a service.
4. Set env vars (reference `${{Postgres.DATABASE_URL}}` for the DB).
5. Generate a domain; set `APP_URL` to it.

The schema is created automatically on first boot.

## Phase two (roles)
The `roles` table carries `max_uploads`, `max_rows_per_upload`, and
`max_subscribers`. Add a row for a new tier and set a user's `role` to it —
no schema migration needed.

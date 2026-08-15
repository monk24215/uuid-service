import crypto from 'crypto';
import { Resend } from 'resend';
import { pool } from './db.js';

const TOKEN_TTL_MINUTES = 15;

// Read sender/URL at call time (not module load) so env is always current.
function getFromEmail() {
  return process.env.FROM_EMAIL || 'onboarding@resend.dev';
}
function getAppUrl() {
  let url = process.env.APP_URL || 'http://localhost:3000';
  // Guard against APP_URL being set without a scheme (e.g. "example.com"),
  // which would produce a relative, unclickable link in the email.
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, ''); // strip any trailing slash
}

// Tokens are random 32-byte secrets. We email the raw token but store only
// its SHA-256 hash, so a DB leak never exposes a usable login link.
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function findOrCreateUser(email) {
  const normalized = email.trim().toLowerCase();
  const { rows } = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, role, verified_at`,
    [normalized]
  );
  return rows[0];
}

export async function sendMagicLink(email) {
  const user = await findOrCreateUser(email);
  const raw = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);
  // Build the URL with URLSearchParams so the query string is always well-formed
  // (a raw template with a stray byte could corrupt the "?token=" separator).
  const verifyUrl = new URL('/auth/verify', getAppUrl());
  verifyUrl.searchParams.set('token', raw);
  const link = verifyUrl.toString();

  // Test mode: persist token and surface link without sending.
  if (process.env.AUTH_TEST_MODE === '1') {
    await pool.query(
      `INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
      [hashToken(raw), user.id, expiresAt]
    );
    console.log('TEST_MAGIC_LINK', link);
    return { ok: true, testLink: link };
  }

  // Send the email FIRST. Only if it succeeds do we persist the token, so a
  // failed send never leaves an orphaned token row and never half-registers
  // the user. If the send fails we throw, and the caller reports the error.
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: getFromEmail(),
    to: user.email,
    subject: 'Your OneID sign-in link',
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2 style="margin:0 0 8px">Sign in</h2>
        <p style="color:#555;margin:0 0 20px">
          Click below to access your account. This link works once and expires in ${TOKEN_TTL_MINUTES} minutes.
        </p>
        <a href="${link}"
           style="display:inline-block;background:#111;color:#fff;text-decoration:none;
                  padding:12px 20px;border-radius:8px;font-weight:600">
          Open my account
        </a>
        <p style="color:#999;font-size:12px;margin-top:24px">
          If you didn't request this, you can ignore this email.
        </p>
      </div>`,
  });

  // The Resend SDK returns { data, error } and does NOT throw on API failures.
  // If we don't inspect error here, a failed send silently looks successful.
  if (error) {
    console.error('Resend send error:', JSON.stringify(error));
    throw new Error(`Resend send failed: ${error.message || error.name || 'unknown'}`);
  }

  // Send succeeded — now it's safe to persist the token.
  await pool.query(
    `INSERT INTO login_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(raw), user.id, expiresAt]
  );
  console.log('Magic link sent:', data?.id, 'to', user.email);

  return { ok: true, id: data?.id };
}

// Verify consumes the token atomically: it must exist, be unexpired, and unused.
// The UPDATE ... RETURNING marks it used in the same statement, so a link
// cannot be replayed even under concurrent requests.
export async function verifyMagicLink(raw) {
  if (!raw) return null;
  const { rows } = await pool.query(
    `UPDATE login_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [hashToken(raw)]
  );
  if (!rows[0]) return null;

  const { rows: users } = await pool.query(
    'SELECT id, email, role FROM users WHERE id = $1',
    [rows[0].user_id]
  );
  return users[0] || null;
}

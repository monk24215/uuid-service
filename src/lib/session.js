import crypto from 'crypto';

// Stateless sessions: a signed cookie carrying the user id. HMAC prevents
// tampering; no server-side session store required.
const SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${mac}`;
}

function unsign(signed) {
  if (!signed || !signed.includes('.')) return null;
  const idx = signed.lastIndexOf('.');
  const value = signed.slice(0, idx);
  const mac = signed.slice(idx + 1);
  const expected = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

export function setSession(res, userId) {
  const payload = JSON.stringify({ uid: userId, iat: Date.now() });
  const token = sign(Buffer.from(payload).toString('base64url'));
  res.cookie('session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
  });
}

export function clearSession(res) {
  res.clearCookie('session');
}

export function getSession(req) {
  const raw = unsign(req.cookies?.session);
  if (!raw) return null;
  try {
    const { uid, iat } = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (!uid || Date.now() - iat > MAX_AGE_MS) return null;
    return { userId: uid };
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    if (req.accepts('html')) return res.redirect('/');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.userId = session.userId;
  next();
}

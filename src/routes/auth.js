import express from 'express';
import rateLimit from 'express-rate-limit';
import { sendMagicLink, verifyMagicLink } from '../lib/auth.js';
import { setSession, clearSession } from '../lib/session.js';

export const authRouter = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Throttle link requests to blunt abuse / email bombing.
const requestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' },
});

authRouter.post('/request', requestLimiter, async (req, res) => {
  const email = (req.body?.email || '').trim();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    await sendMagicLink(email);
    // Always report success to avoid disclosing which emails are registered.
    res.json({ ok: true });
  } catch (e) {
    console.error('sendMagicLink failed:', e);
    res.status(500).json({ error: 'Could not send the link. Please try again.' });
  }
});

authRouter.get('/verify', async (req, res) => {
  const user = await verifyMagicLink(req.query.token);
  if (!user) {
    return res.status(400).send(renderError('This link is invalid or has expired.'));
  }
  setSession(res, user.id);
  res.redirect('/app');
});

authRouter.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

function renderError(msg) {
  return `<!doctype html><meta charset="utf-8">
    <div style="font-family:system-ui;max-width:420px;margin:80px auto;text-align:center">
      <h2>Sign-in failed</h2>
      <p style="color:#666">${msg}</p>
      <a href="/" style="color:#111">Request a new link</a>
    </div>`;
}

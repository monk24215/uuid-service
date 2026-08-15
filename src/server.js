import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { initSchema } from './lib/db.js';
import { getSession } from './lib/session.js';
import { authRouter } from './routes/auth.js';
import { appRouter } from './routes/app.js';
import { AppError } from './lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static assets (login + app shell).
app.use(express.static(path.join(__dirname, 'public')));

// Landing: redirect to /app if already signed in.
app.get('/', (req, res, next) => {
  if (getSession(req)) return res.redirect('/app');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/app', (req, res) => {
  if (!getSession(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

app.use('/auth', authRouter);
app.use('/api', appRouter);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Central error handler.
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File is too large (15 MB max).' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

const PORT = process.env.PORT || 3000;

// Start listening immediately so the platform health check at /healthz always
// gets an answer, even if the database is still coming up. Then initialize the
// schema with retries in the background rather than crashing the process — on a
// platform where services boot in any order, a brief DB delay shouldn't take
// down the whole deploy.
app.listen(PORT, () => console.log(`Listening on :${PORT}`));

async function initWithRetry(attempt = 1) {
  const MAX_ATTEMPTS = 10;
  try {
    await initSchema();
    console.log('Schema ready.');
  } catch (e) {
    console.error(`Schema init failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, e.message);
    if (attempt < MAX_ATTEMPTS) {
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 15000);
      setTimeout(() => initWithRetry(attempt + 1), delayMs);
    } else {
      console.error('Schema init giving up after max attempts. Fix DATABASE_URL and redeploy.');
    }
  }
}
initWithRetry();

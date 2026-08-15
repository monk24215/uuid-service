import express from 'express';
import multer from 'multer';
import { requireAuth } from '../lib/session.js';
import { pool, getUserLimits, countUploads } from '../lib/db.js';
import { processUpload, exportUpload, AppError } from '../lib/csv.js';

export const appRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB ceiling
  fileFilter: (req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) ||
      ['text/csv', 'application/vnd.ms-excel', 'application/octet-stream'].includes(file.mimetype);
    cb(ok ? null : new AppError('Please upload a .csv file.', 400), ok);
  },
});

appRouter.use(requireAuth);

// Account summary + usage.
appRouter.get('/me', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [req.userId]
    );
    const limits = await getUserLimits(req.userId);
    const used = await countUploads(req.userId);
    res.json({ user: rows[0], limits, usage: { uploads: used } });
  } catch (e) { next(e); }
});

// List uploads for the logged-in user.
appRouter.get('/uploads', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, filename, row_count, email_column, created_at
         FROM uploads WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ uploads: rows });
  } catch (e) { next(e); }
});

// Upload + process a CSV.
appRouter.post('/uploads', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError('No file received.', 400);
    const result = await processUpload(req.userId, req.file.buffer, req.file.originalname);
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// Export a single upload as CSV with UUIDs appended.
appRouter.get('/uploads/:id/export', async (req, res, next) => {
  try {
    const { csv, filename } = await exportUpload(req.userId, req.params.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (e) { next(e); }
});

// Delete an upload (frees a slot).
appRouter.delete('/uploads/:id', async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM uploads WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!rowCount) throw new AppError('Upload not found.', 404);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

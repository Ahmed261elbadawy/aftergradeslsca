require('dotenv').config();

// Safety net: never let an unhandled rejection kill the whole serverless
// process (it would fail every route, not just the one that errored).
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection', err);
});

const express = require('express');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const db = require('./lib/db');
const storage = require('./lib/storage');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

// --- Upload handling (buffered in memory, then handed to lib/storage) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /png|jpe?g|webp|pdf/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

// --- App setup ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'aftergrad-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// --- Public form ---
app.get('/', (req, res) => {
  db.recordView().catch((err) => console.error('failed to record view', err));
  res.render('form', { error: null });
});

app.post('/submit', upload.single('screenshot'), async (req, res, next) => {
  try {
    const { name, email, phone, paid_to, guest_of, social_media } = req.body;

    if (!name || !email || !phone || !paid_to || !social_media || !req.file) {
      return res.render('form', { error: 'Please fill in all required fields and upload your payment screenshot.' });
    }

    const screenshotUrl = await storage.saveFile(req.file);

    await db.insert({
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      guestOf: (guest_of || '').trim() || null,
      socialMedia: (social_media || '').trim() || null,
      screenshotUrl,
      paidTo: paid_to
    });

    res.render('success');
  } catch (err) {
    next(err);
  }
});

// --- Admin auth ---
app.get('/admin/login', (req, res) => {
  res.render('admin_login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin_login', { error: 'Incorrect password.' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// --- Admin dashboard ---
app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const [submissions, viewStats] = await Promise.all([db.list(), db.viewStats()]);
    res.render('admin', { submissions, viewStats });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/:id/status', requireAdmin, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).send('Invalid status');
    await db.updateStatus(req.params.id, status);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

app.post('/admin/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    const url = await db.getScreenshotUrl(req.params.id);
    await db.remove(req.params.id);
    await storage.deleteFile(url);
    res.redirect('/admin');
  } catch (err) {
    next(err);
  }
});

// --- Export to CSV ---
app.get('/admin/export.csv', requireAdmin, async (req, res, next) => {
  try {
    const rows = await db.list();
    const header = ['ID', 'Name', 'Phone', 'Email', 'Coming With (if not ESLSCIAN)', 'Social Media', 'Paid To', 'Status', 'Screenshot', 'Submitted At'];
    const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [header.join(',')];
    for (const r of rows) {
      const screenshotUrl = r.screenshot_url.startsWith('http')
        ? r.screenshot_url
        : `${req.protocol}://${req.get('host')}${r.screenshot_url}`;
      lines.push([
        r.id, r.name, r.phone, r.email, r.guest_of, r.social_media, r.paid_to, r.status,
        screenshotUrl,
        r.created_at
      ].map(escape).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aftergrad_submissions.csv"');
    res.send('﻿' + lines.join('\n'));
  } catch (err) {
    next(err);
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`After Grad app running at http://localhost:${PORT}`);
    console.log(`Admin login at http://localhost:${PORT}/admin/login`);
    console.log(`Storage: ${storage.useBlob ? 'Vercel Blob' : 'local disk'}, DB: ${db.useCloud ? 'Postgres' : 'SQLite'}`);
  });
}

module.exports = app;

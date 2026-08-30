const path = require('path');

const useCloud = !!process.env.POSTGRES_URL;

let impl;

if (useCloud) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
    max: 1
  });

  // Without this, an idle client error (common on serverless Postgres) throws
  // an unhandled 'error' event and crashes the whole function process.
  pool.on('error', (err) => {
    console.error('pg pool error', err);
  });

  let readyResolved = false;
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      guest_of TEXT,
      screenshot_url TEXT NOT NULL,
      paid_to TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).then(() => pool.query(`
    CREATE TABLE IF NOT EXISTS page_views (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)).then(() => { readyResolved = true; })
    .catch((err) => {
      readyResolved = true;
      console.error('failed to ensure tables', err);
    });

  impl = {
    async insert({ name, email, phone, guestOf, screenshotUrl, paidTo }) {
      await ready;
      await pool.query(
        `INSERT INTO submissions (name, email, phone, guest_of, screenshot_url, paid_to)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, email, phone, guestOf, screenshotUrl, paidTo]
      );
    },
    async list() {
      await ready;
      const { rows } = await pool.query('SELECT * FROM submissions ORDER BY created_at DESC');
      return rows;
    },
    async getScreenshotUrl(id) {
      await ready;
      const { rows } = await pool.query('SELECT screenshot_url FROM submissions WHERE id = $1', [id]);
      return rows[0] ? rows[0].screenshot_url : null;
    },
    async updateStatus(id, status) {
      await ready;
      await pool.query('UPDATE submissions SET status = $1 WHERE id = $2', [status, id]);
    },
    async remove(id) {
      await ready;
      await pool.query('DELETE FROM submissions WHERE id = $1', [id]);
    },
    async recordView() {
      await ready;
      await pool.query('INSERT INTO page_views DEFAULT VALUES');
    },
    async viewStats() {
      await ready;
      const { rows } = await pool.query(`
        SELECT
          count(*) FILTER (WHERE created_at > now() - interval '1 day') AS last_day,
          count(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_week
        FROM page_views
      `);
      return { lastDay: Number(rows[0].last_day), lastWeek: Number(rows[0].last_week) };
    }
  };
} else {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, '..', 'data', 'submissions.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      guest_of TEXT,
      screenshot_url TEXT NOT NULL,
      paid_to TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const existingCols = db.prepare("PRAGMA table_info(submissions)").all().map(c => c.name);
  if (!existingCols.includes('guest_of')) db.exec('ALTER TABLE submissions ADD COLUMN guest_of TEXT');
  if (!existingCols.includes('screenshot_url') && existingCols.includes('screenshot_filename')) {
    db.exec("ALTER TABLE submissions ADD COLUMN screenshot_url TEXT");
    db.exec("UPDATE submissions SET screenshot_url = '/uploads/' || screenshot_filename WHERE screenshot_url IS NULL");
  } else if (!existingCols.includes('screenshot_url')) {
    db.exec('ALTER TABLE submissions ADD COLUMN screenshot_url TEXT');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  impl = {
    async insert({ name, email, phone, guestOf, screenshotUrl, paidTo }) {
      db.prepare(`
        INSERT INTO submissions (name, email, phone, guest_of, screenshot_url, paid_to)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(name, email, phone, guestOf, screenshotUrl, paidTo);
    },
    async list() {
      return db.prepare('SELECT * FROM submissions ORDER BY created_at DESC').all();
    },
    async getScreenshotUrl(id) {
      const row = db.prepare('SELECT screenshot_url FROM submissions WHERE id = ?').get(id);
      return row ? row.screenshot_url : null;
    },
    async updateStatus(id, status) {
      db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, id);
    },
    async remove(id) {
      db.prepare('DELETE FROM submissions WHERE id = ?').run(id);
    },
    async recordView() {
      db.prepare("INSERT INTO page_views (created_at) VALUES (datetime('now'))").run();
    },
    async viewStats() {
      const lastDay = db.prepare("SELECT count(*) AS c FROM page_views WHERE created_at > datetime('now', '-1 day')").get().c;
      const lastWeek = db.prepare("SELECT count(*) AS c FROM page_views WHERE created_at > datetime('now', '-7 days')").get().c;
      return { lastDay, lastWeek };
    }
  };
}

module.exports = { ...impl, useCloud };

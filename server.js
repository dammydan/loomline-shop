require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool } = require('pg');
const formData = require('form-data');
const Mailgun = require('mailgun.js');

const env = process.env;
const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
const mg = !env.MAILGUN_API_KEY ? null : new Mailgun(formData).client({
  username: 'api',
  key: env.MAILGUN_API_KEY,
  url: env.MAILGUN_URL || 'https://api.mailgun.net',
});

const app = express();
app.set('trust proxy', 1); // needed on Render/Vercel/etc. so secure cookies work
app.use(express.json());
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: env.BASE_URL?.startsWith('https') },
}));
app.use(passport.initialize());
app.use(passport.session());

// ---------- Google auth ----------
const googleOn = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
if (googleOn) passport.use(new GoogleStrategy({
  clientID: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  callbackURL: env.BASE_URL + '/auth/google/callback',
}, async (_at, _rt, profile, done) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ($1,$2,$3)
       ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING *`,
      [profile.id, profile.emails[0].value, profile.displayName]
    );
    done(null, rows[0]);
  } catch (e) { done(e); }
}));
passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0] || false); }
  catch (e) { done(e); }
});

if (googleOn) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/?login=failed' }),
    (_req, res) => res.redirect('/#checkout'));
} else {
  // TEST LOGIN: only used while the Google keys are missing. Remove once Google works.
  console.warn('Google keys missing: using a TEST login. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable real Google sign-in.');
  app.get('/auth/google', async (req, res, next) => {
    try {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (google_id, email, name) VALUES ('test-user', 'test@example.com', 'Test Customer')
         ON CONFLICT (google_id) DO UPDATE SET name = EXCLUDED.name RETURNING *`);
      req.login(u, err => (err ? next(err) : res.redirect('/#checkout')));
    } catch (e) { next(e); }
  });
}
app.post('/auth/logout', (req, res, next) =>
  req.logout(err => (err ? next(err) : res.json({ ok: true }))));

// ---------- API ----------
const requireLogin = (req, res, next) =>
  req.isAuthenticated() ? next() : res.status(401).json({ error: 'Sign in to check out.' });

app.get('/api/me', (req, res) =>
  res.json(req.user ? { name: req.user.name, email: req.user.email } : null));

app.get('/api/products', async (_req, res, next) => {
  try { res.json((await pool.query('SELECT * FROM products ORDER BY id')).rows); }
  catch (e) { next(e); }
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = k => '₦' + (k / 100).toLocaleString('en-NG');

app.post('/api/checkout', requireLogin, async (req, res, next) => {
  const { fullName, address, items } = req.body || {};
  if (!fullName?.trim() || !address?.trim() || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Add your name, address and at least one item.' });

  const client = await pool.connect();
  try {
    // Prices come from the database, never from the browser.
    const ids = items.map(i => Number(i.productId));
    const { rows: products } = await client.query('SELECT * FROM products WHERE id = ANY($1)', [ids]);
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const lines = items.map(i => {
      const p = byId[Number(i.productId)];
      const qty = Math.floor(Number(i.quantity));
      const size = String(i.size || '').trim();
      const valid = p && qty > 0 && qty <= 50 && p.sizes.split(',').map(x => x.trim()).includes(size);
      if (!valid) throw Object.assign(new Error('Invalid cart item or size.'), { status: 400 });
      return { p, qty, size };
    });
    const total = lines.reduce((s, l) => s + l.p.price_kobo * l.qty, 0);

    await client.query('BEGIN');
    const { rows: [order] } = await client.query(
      'INSERT INTO orders (user_id, full_name, address, total_kobo) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, fullName.trim(), address.trim(), total]);
    for (const l of lines)
      await client.query(
        'INSERT INTO order_items (order_id, product_id, size, quantity, unit_price_kobo) VALUES ($1,$2,$3,$4,$5)',
        [order.id, l.p.id, l.size, l.qty, l.p.price_kobo]);
    await client.query('COMMIT');

    // Email is sent after the order is saved; a mail failure must not lose the order.
    let emailSent = true;
    try {
      const rowsHtml = lines.map(l =>
        `<tr><td>${esc(l.p.name)} (size ${esc(l.size)}) × ${l.qty}</td><td style="text-align:right">${money(l.p.price_kobo * l.qty)}</td></tr>`).join('');
      const message = {
        from: env.MAILGUN_FROM,
        to: [req.user.email],
        subject: `Order #${order.id} confirmed`,
        text: `Hi ${req.user.name}, your order #${order.id} is confirmed.\n\n` +
          lines.map(l => `${l.p.name} (size ${l.size}) x ${l.qty}  ${money(l.p.price_kobo * l.qty)}`).join('\n') +
          `\n\nTotal: ${money(total)}\nShipping to: ${address}`,
        html: `<h2>Thanks, ${esc(req.user.name)}!</h2><p>Order <b>#${order.id}</b> is confirmed.</p>
               <table cellpadding="6" width="100%">${rowsHtml}
               <tr><td><b>Total</b></td><td style="text-align:right"><b>${money(total)}</b></td></tr></table>
               <p>Shipping to: ${esc(address)}</p>`,
      };
      if (mg) await mg.messages.create(env.MAILGUN_DOMAIN, message);
      else {
        console.log('\n--- EMAIL NOT SENT (Mailgun key missing). It would have said: ---');
        console.log('To: ' + message.to[0] + '\nSubject: ' + message.subject + '\n' + message.text + '\n---\n');
        emailSent = false;
      }
    } catch (mailErr) { emailSent = false; console.error('Mailgun error:', mailErr.message); }

    res.json({ orderId: order.id, total_kobo: total, emailSent });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Try again.' });
});

// On Vercel the app is exported and run as a serverless function; locally we start a server.
if (!env.VERCEL) app.listen(env.PORT || 3000, () => console.log('Shop running on ' + (env.BASE_URL || 'http://localhost:3000')));
module.exports = app;

/*
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool } = require('pg');
const formData = require('form-data');
const Mailgun = require('mailgun.js');

const env = process.env;
const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const mg = !env.MAILGUN_API_KEY ? null : new Mailgun(formData).client({
  username: 'api',
  key: env.MAILGUN_API_KEY,
  url: env.MAILGUN_URL || 'https://api.mailgun.net',
});

const app = express();
app.set('trust proxy', 1); // needed on Render/Vercel/etc. so secure cookies work
app.use(express.json());
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: env.BASE_URL?.startsWith('https') },
}));
app.use(passport.initialize());
app.use(passport.session());

// ---------- Google auth ----------
const googleOn = !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
if (googleOn) passport.use(new GoogleStrategy({
  clientID: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  callbackURL: env.BASE_URL + '/auth/google/callback',
}, async (_at, _rt, profile, done) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ($1,$2,$3)
       ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING *`,
      [profile.id, profile.emails[0].value, profile.displayName]
    );
    done(null, rows[0]);
  } catch (e) { done(e); }
}));
passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0] || false); }
  catch (e) { done(e); }
});

if (googleOn) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/?login=failed' }),
    (_req, res) => res.redirect('/#checkout'));
} else {
  // TEST LOGIN: only used while the Google keys are missing. Remove once Google works.
  console.warn('Google keys missing: using a TEST login. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable real Google sign-in.');
  app.get('/auth/google', async (req, res, next) => {
    try {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (google_id, email, name) VALUES ('test-user', 'test@example.com', 'Test Customer')
         ON CONFLICT (google_id) DO UPDATE SET name = EXCLUDED.name RETURNING *`);
      req.login(u, err => (err ? next(err) : res.redirect('/#checkout')));
    } catch (e) { next(e); }
  });
}
app.post('/auth/logout', (req, res, next) =>
  req.logout(err => (err ? next(err) : res.json({ ok: true }))));

// ---------- API ----------
const requireLogin = (req, res, next) =>
  req.isAuthenticated() ? next() : res.status(401).json({ error: 'Sign in to check out.' });

app.get('/api/me', (req, res) =>
  res.json(req.user ? { name: req.user.name, email: req.user.email } : null));

app.get('/api/products', async (_req, res, next) => {
  try { res.json((await pool.query('SELECT * FROM products ORDER BY id')).rows); }
  catch (e) { next(e); }
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = k => '₦' + (k / 100).toLocaleString('en-NG');

app.post('/api/checkout', requireLogin, async (req, res, next) => {
  const { fullName, address, items } = req.body || {};
  if (!fullName?.trim() || !address?.trim() || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Add your name, address and at least one item.' });

  const client = await pool.connect();
  try {
    // Prices come from the database, never from the browser.
    const ids = items.map(i => Number(i.productId));
    const { rows: products } = await client.query('SELECT * FROM products WHERE id = ANY($1)', [ids]);
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const lines = items.map(i => {
      const p = byId[Number(i.productId)];
      const qty = Math.floor(Number(i.quantity));
      const size = String(i.size || '').trim();
      const valid = p && qty > 0 && qty <= 50 && p.sizes.split(',').map(x => x.trim()).includes(size);
      if (!valid) throw Object.assign(new Error('Invalid cart item or size.'), { status: 400 });
      return { p, qty, size };
    });
    const total = lines.reduce((s, l) => s + l.p.price_kobo * l.qty, 0);

    await client.query('BEGIN');
    const { rows: [order] } = await client.query(
      'INSERT INTO orders (user_id, full_name, address, total_kobo) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, fullName.trim(), address.trim(), total]);
    for (const l of lines)
      await client.query(
        'INSERT INTO order_items (order_id, product_id, size, quantity, unit_price_kobo) VALUES ($1,$2,$3,$4,$5)',
        [order.id, l.p.id, l.size, l.qty, l.p.price_kobo]);
    await client.query('COMMIT');

    // Email is sent after the order is saved; a mail failure must not lose the order.
    let emailSent = true;
    try {
      const rowsHtml = lines.map(l =>
        `<tr><td>${esc(l.p.name)} (size ${esc(l.size)}) × ${l.qty}</td><td style="text-align:right">${money(l.p.price_kobo * l.qty)}</td></tr>`).join('');
      const message = {
        from: env.MAILGUN_FROM,
        to: [req.user.email],
        subject: `Order #${order.id} confirmed`,
        text: `Hi ${req.user.name}, your order #${order.id} is confirmed.\n\n` +
          lines.map(l => `${l.p.name} (size ${l.size}) x ${l.qty}  ${money(l.p.price_kobo * l.qty)}`).join('\n') +
          `\n\nTotal: ${money(total)}\nShipping to: ${address}`,
        html: `<h2>Thanks, ${esc(req.user.name)}!</h2><p>Order <b>#${order.id}</b> is confirmed.</p>
               <table cellpadding="6" width="100%">${rowsHtml}
               <tr><td><b>Total</b></td><td style="text-align:right"><b>${money(total)}</b></td></tr></table>
               <p>Shipping to: ${esc(address)}</p>`,
      };
      if (mg) await mg.messages.create(env.MAILGUN_DOMAIN, message);
      else {
        console.log('\n--- EMAIL NOT SENT (Mailgun key missing). It would have said: ---');
        console.log('To: ' + message.to[0] + '\nSubject: ' + message.subject + '\n' + message.text + '\n---\n');
        emailSent = false;
      }
    } catch (mailErr) { emailSent = false; console.error('Mailgun error:', mailErr.message); }

    res.json({ orderId: order.id, total_kobo: total, emailSent });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Try again.' });
});

app.listen(env.PORT || 3000, () => console.log('Shop running on ' + (env.BASE_URL || 'http://localhost:3000')));

*/

/*
require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Pool } = require('pg');
const formData = require('form-data');
const Mailgun = require('mailgun.js');

const env = process.env;
const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const mg = new Mailgun(formData).client({
  username: 'api',
  key: env.MAILGUN_API_KEY,
  url: env.MAILGUN_URL || 'https://api.mailgun.net',
});

const app = express();
app.set('trust proxy', 1); // needed on Render/Vercel/etc. so secure cookies work
app.use(express.json());
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }),
  secret: env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: env.BASE_URL?.startsWith('https') },
}));
app.use(passport.initialize());
app.use(passport.session());

// ---------- Google auth ----------
passport.use(new GoogleStrategy({
  clientID: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  callbackURL: env.BASE_URL + '/auth/google/callback',
}, async (_at, _rt, profile, done) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (google_id, email, name) VALUES ($1,$2,$3)
       ON CONFLICT (google_id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name
       RETURNING *`,
      [profile.id, profile.emails[0].value, profile.displayName]
    );
    done(null, rows[0]);
  } catch (e) { done(e); }
}));
passport.serializeUser((u, done) => done(null, u.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0] || false); }
  catch (e) { done(e); }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?login=failed' }),
  (_req, res) => res.redirect('/#checkout'));
app.post('/auth/logout', (req, res, next) =>
  req.logout(err => (err ? next(err) : res.json({ ok: true }))));

// ---------- API ----------
const requireLogin = (req, res, next) =>
  req.isAuthenticated() ? next() : res.status(401).json({ error: 'Sign in to check out.' });

app.get('/api/me', (req, res) =>
  res.json(req.user ? { name: req.user.name, email: req.user.email } : null));

app.get('/api/products', async (_req, res, next) => {
  try { res.json((await pool.query('SELECT * FROM products ORDER BY id')).rows); }
  catch (e) { next(e); }
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = k => '₦' + (k / 100).toLocaleString('en-NG');

app.post('/api/checkout', requireLogin, async (req, res, next) => {
  const { fullName, address, items } = req.body || {};
  if (!fullName?.trim() || !address?.trim() || !Array.isArray(items) || !items.length)
    return res.status(400).json({ error: 'Add your name, address and at least one item.' });

  const client = await pool.connect();
  try {
    // Prices come from the database, never from the browser.
    const ids = items.map(i => Number(i.productId));
    const { rows: products } = await client.query('SELECT * FROM products WHERE id = ANY($1)', [ids]);
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const lines = items.map(i => {
      const p = byId[Number(i.productId)];
      const qty = Math.floor(Number(i.quantity));
      const size = String(i.size || '').trim();
      const valid = p && qty > 0 && qty <= 50 && p.sizes.split(',').map(x => x.trim()).includes(size);
      if (!valid) throw Object.assign(new Error('Invalid cart item or size.'), { status: 400 });
      return { p, qty, size };
    });
    const total = lines.reduce((s, l) => s + l.p.price_kobo * l.qty, 0);

    await client.query('BEGIN');
    const { rows: [order] } = await client.query(
      'INSERT INTO orders (user_id, full_name, address, total_kobo) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, fullName.trim(), address.trim(), total]);
    for (const l of lines)
      await client.query(
        'INSERT INTO order_items (order_id, product_id, size, quantity, unit_price_kobo) VALUES ($1,$2,$3,$4,$5)',
        [order.id, l.p.id, l.size, l.qty, l.p.price_kobo]);
    await client.query('COMMIT');

    // Email is sent after the order is saved; a mail failure must not lose the order.
    let emailSent = true;
    try {
      const rowsHtml = lines.map(l =>
        `<tr><td>${esc(l.p.name)} (size ${esc(l.size)}) × ${l.qty}</td><td style="text-align:right">${money(l.p.price_kobo * l.qty)}</td></tr>`).join('');
      await mg.messages.create(env.MAILGUN_DOMAIN, {
        from: env.MAILGUN_FROM,
        to: [req.user.email],
        subject: `Order #${order.id} confirmed`,
        text: `Hi ${req.user.name}, your order #${order.id} is confirmed.\n\n` +
          lines.map(l => `${l.p.name} (size ${l.size}) x ${l.qty}  ${money(l.p.price_kobo * l.qty)}`).join('\n') +
          `\n\nTotal: ${money(total)}\nShipping to: ${address}`,
        html: `<h2>Thanks, ${esc(req.user.name)}!</h2><p>Order <b>#${order.id}</b> is confirmed.</p>
               <table cellpadding="6" width="100%">${rowsHtml}
               <tr><td><b>Total</b></td><td style="text-align:right"><b>${money(total)}</b></td></tr></table>
               <p>Shipping to: ${esc(address)}</p>`,
      });
    } catch (mailErr) { emailSent = false; console.error('Mailgun error:', mailErr.message); }

    res.json({ orderId: order.id, total_kobo: total, emailSent });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong. Try again.' });
});

app.listen(env.PORT || 3000, () => console.log('Shop running on ' + (env.BASE_URL || 'http://localhost:3000')));
*/
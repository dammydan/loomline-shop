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
app.use(express.json({ limit: '3mb' })); // 3mb so admin photo uploads fit
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

// ---------- Admin helpers ----------
const admins = (env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const isAdmin = u => !!u && admins.includes(String(u.email).toLowerCase());
const requireAdmin = (req, res, next) =>
  !req.isAuthenticated() ? res.status(401).json({ error: 'Sign in first.' })
  : !isAdmin(req.user) ? res.status(403).json({ error: 'Admins only.' })
  : next();

app.get('/api/me', (req, res) =>
  res.json(req.user ? { name: req.user.name, email: req.user.email, isAdmin: isAdmin(req.user) } : null));

app.get('/api/products', async (_req, res, next) => {
  try { res.json((await pool.query('SELECT * FROM products WHERE active ORDER BY id')).rows); }
  catch (e) { next(e); }
});

// Counts one visit per browser session (the page calls this once).
app.post('/api/track', async (_req, res) => {
  try {
    await pool.query(`INSERT INTO daily_views (day, views) VALUES (CURRENT_DATE, 1)
                      ON CONFLICT (day) DO UPDATE SET views = daily_views.views + 1`);
  } catch (e) { console.error('track error:', e.message); }
  res.json({ ok: true });
});

// Photos uploaded in the admin panel are stored in the database and served from here.
app.get('/api/images/:id', async (req, res, next) => {
  try {
    const { rows: [img] } = await pool.query('SELECT mime, data FROM product_images WHERE id = $1', [Number(req.params.id) || 0]);
    if (!img) return res.sendStatus(404);
    res.set({ 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' }).send(img.data);
  } catch (e) { next(e); }
});

// ---------- Admin API ----------
app.get('/api/admin/stats', requireAdmin, async (_req, res, next) => {
  try {
    const q = sql => pool.query(sql).then(r => r.rows);
    const [[totals], days, top, recent] = await Promise.all([
      q(`SELECT (SELECT COUNT(*) FROM orders)::int AS orders,
                (SELECT COALESCE(SUM(total_kobo),0) FROM orders)::float8 AS revenue,
                (SELECT COUNT(*) FROM users)::int AS customers,
                (SELECT COUNT(*) FROM products WHERE active)::int AS products,
                (SELECT COALESCE(SUM(views),0) FROM daily_views)::int AS visits,
                (SELECT COALESCE(SUM(views),0) FROM daily_views WHERE day = CURRENT_DATE)::int AS "visitsToday"`),
      q(`SELECT to_char(d::date, 'DD Mon') AS label, COALESCE(v.views,0)::int AS visits, COALESCE(o.n,0)::int AS orders
         FROM generate_series(CURRENT_DATE - 13, CURRENT_DATE, interval '1 day') d
         LEFT JOIN daily_views v ON v.day = d::date
         LEFT JOIN (SELECT created_at::date AS day, COUNT(*) AS n FROM orders GROUP BY 1) o ON o.day = d::date
         ORDER BY d`),
      q(`SELECT p.name, SUM(oi.quantity)::int AS sold, SUM(oi.quantity * oi.unit_price_kobo)::float8 AS revenue
         FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.name ORDER BY sold DESC LIMIT 5`),
      q(`SELECT o.id, o.full_name AS name, u.email, o.total_kobo, o.created_at
         FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 10`),
    ]);
    res.json({ ...totals, days, top, recent });
  } catch (e) { next(e); }
});

app.post('/api/admin/products', requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim(), description = String(b.description || '').trim();
    const kobo = Math.round(Number(b.priceNaira) * 100);
    const sizes = String(b.sizes || '').split(',').map(s => s.trim()).filter(Boolean).join(',');
    const bad = msg => res.status(400).json({ error: msg });
    if (!name || name.length > 120) return bad('Enter a product name.');
    if (!description || description.length > 500) return bad('Enter a short description (under 500 characters).');
    if (!(kobo > 0 && kobo < 1e10)) return bad('Enter a price in naira greater than 0.');
    if (!sizes) return bad('Enter at least one size, for example S,M,L,XL or One size.');

    let imageUrl = null;
    if (b.image) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.image);
      if (!m) return bad('That image format is not supported. Use JPG, PNG or WebP.');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 2.5e6) return bad('That image is too large.');
      const { rows: [img] } = await pool.query('INSERT INTO product_images (mime, data) VALUES ($1,$2) RETURNING id', [m[1], buf]);
      imageUrl = '/api/images/' + img.id;
    } else if (b.imageUrl && String(b.imageUrl).trim()) {
      imageUrl = String(b.imageUrl).trim();
      if (!/^(https:\/\/|\/(?!\/))/.test(imageUrl) || imageUrl.length > 500) return bad('The image link must start with https:// or /images/.');
    }
    const { rows: [p] } = await pool.query(
      'INSERT INTO products (name, description, price_kobo, sizes, image_url) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, description, kobo, sizes, imageUrl]);
    res.json(p);
  } catch (e) { next(e); }
});

// "Remove" hides the product (so past orders keep working) and frees any uploaded photo.
app.delete('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
  try {
    const { rows: [p] } = await pool.query('UPDATE products SET active = false WHERE id = $1 RETURNING image_url', [Number(req.params.id) || 0]);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    const m = /^\/api\/images\/(\d+)$/.exec(p.image_url || '');
    if (m) await pool.query('DELETE FROM product_images WHERE id = $1', [Number(m[1])]);
    res.json({ ok: true });
  } catch (e) { next(e); }
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
    const { rows: products } = await client.query('SELECT * FROM products WHERE id = ANY($1) AND active', [ids]);
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
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  google_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Prices are stored in kobo (100 kobo = N1) so there are no decimal rounding issues.
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  price_kobo INTEGER NOT NULL CHECK (price_kobo > 0),
  sizes TEXT NOT NULL DEFAULT 'S,M,L,XL',   -- comma-separated list shown in the dropdown
  image_url TEXT                            -- e.g. /images/denim-jacket.jpg or a full https URL
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  full_name TEXT NOT NULL,
  address TEXT NOT NULL,
  total_kobo INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  size TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_kobo INTEGER NOT NULL
);

-- Session store (used by connect-pg-simple)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Admin panel additions (safe to re-run)
ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;  -- "removed" products are hidden, not deleted, so old orders still work
CREATE TABLE IF NOT EXISTS product_images (   -- photos uploaded from the admin panel
  id SERIAL PRIMARY KEY,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS daily_views (      -- simple visit counter for the stats page
  day DATE PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0
);

-- Only seeds when the products table is empty, so re-running this file is safe.
INSERT INTO products (name, description, price_kobo, sizes, image_url)
SELECT * FROM (VALUES
 ('Classic White Tee', 'Heavyweight cotton, relaxed fit. Goes with everything.', 1500000, 'S,M,L,XL,XXL', '/images/classic-white-tee.jpg'),
 ('Ankara Print Shirt', 'Bold wax-print cotton with a slim, button-up cut.', 2800000, 'S,M,L,XL', '/images/ankara-print-shirt.jpg'),
 ('Denim Jacket', 'Washed mid-blue with brass buttons and a boxy fit.', 4500000, 'S,M,L,XL', '/images/denim-jacket.jpg'),
 ('Pleated Midi Skirt', 'Flowy, lined, and easy to dress up or down.', 2500000, '8,10,12,14,16', '/images/pleated-midi-skirt.jpg'),
 ('Slim Chinos', 'Stretch twill in sand. Work-ready, weekend-ready.', 3000000, '30,32,34,36,38', '/images/slim-chinos.jpg'),
 ('Linen Kaftan Dress', 'Breathable linen with side pockets and a loose drape.', 3800000, 'S,M,L,XL', '/images/linen-kaftan-dress.jpg')
) AS v(name, description, price_kobo, sizes, image_url)
WHERE NOT EXISTS (SELECT 1 FROM products);
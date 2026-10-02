# Loomline shop

Express + Neon Postgres + Google sign-in + Mailgun confirmation emails.

## Run it
1. `npm install`
2. Copy `.env.example` to `.env` and fill it in (steps below)
3. Run `schema.sql` in your database's SQL editor (creates tables + 6 sample clothing items (prices in kobo, sizes, image paths))
4. `npm start` then open http://localhost:3000

## Setup steps
**Neon:** neon.tech > new project > copy the connection string into `DATABASE_URL`.

**Google:** console.cloud.google.com > new project > APIs & Services > OAuth consent screen (External; add your Gmail as a test user) > Credentials > Create OAuth client ID > Web application.
Authorized redirect URI: `http://localhost:3000/auth/google/callback` (add your live URL version too after deploying).

**Mailgun:** use the free sandbox domain. Sandbox domains only send to *authorized recipients*: Sending > Domain settings > Authorized Recipients, add your own email and click the verification link. Use the Private API key.

## Deploy
Render or Railway work well. Set the same env vars, set `BASE_URL` to the live URL, and add `BASE_URL/auth/google/callback` to Google's redirect URIs.

## Product photos
Add your photos to `public/images/` (see the README.txt in that folder), or set `image_url` to any https image link in the `products` table.

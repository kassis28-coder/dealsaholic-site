# Dealsaholic — Live Site Setup (do this on a computer)

This folder is a complete, ready-to-deploy website. Once it's live, it will:
- Automatically fetch fresh Amazon deals once a day (no manual work)
- Display them as a styled deals page at your domain
- Keep working even if one day's fetch fails (it just shows yesterday's deals)

It has three parts, all included:
- `public/index.html` — the actual website visitors see
- `netlify/functions/fetch-deals.mjs` — runs once a day, finds the best
  discounts, saves them
- `netlify/functions/get-deals.mjs` — lets the website read those results

## Part 1 — Connect this GitHub repo to Netlify

1. Go to https://app.netlify.com and log in.
2. Click "Add new project" → "Import an existing project".
3. Choose GitHub, authorize if asked, select this repo.
4. Build settings auto-detect from netlify.toml — leave defaults, click Deploy.

## Part 2 — Add your Amazon credentials to Netlify

In Netlify: Site configuration → Environment variables. Add:

| Key | Value |
|---|---|
| AMAZON_CLIENT_ID | your Credential ID |
| AMAZON_CLIENT_SECRET | your Secret |
| AMAZON_PARTNER_TAG | your Associates tag |

Use a freshly generated credential, not one that was ever screenshotted.

## Part 3 — Point your domain at this Netlify site

Site configuration → Domain management → Add a domain. Follow the DNS
instructions Netlify shows you.

## Checking it's working

Visit your Netlify URL. It may say "No deals fetched yet" until the first
scheduled run completes. Check Functions → fetch-deals → logs if something
looks wrong.

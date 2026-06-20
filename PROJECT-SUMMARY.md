# Deals-aholic Project Summary
(Paste this at the start of a new Claude chat to get me back up to speed instantly)

## What this is
An automated Amazon affiliate deals website called "Deals-aholic" — pulls real Amazon deals via the Amazon Creators API, displays them on a clean card-based site, and also lets sellers pay to submit their own deals for manual review/approval.

## Live links
* Site: https://deals-aholic.com
* Seller submission form: https://deals-aholic.com/submit.html
* Admin review page: https://deals-aholic.com/admin.html
* About page: https://deals-aholic.com/about.html
* Privacy Policy: https://deals-aholic.com/privacy.html
* GitHub repo: https://github.com/kassis28-coder/dealsaholic-site
* Backup URL: https://strong-moonbeam-b8d8e4.netlify.app

## Brand
* Name is "Deals-aholic" (WITH hyphen)
* Instagram: instagram.com/deals_aholic
* Telegram: t.me/dealsaholic
* Brand color: orange (#FF8A1E), cream/paper background (#FAF8F4)
* Facebook pages: "Deals-aholic" and "101 Savings (Sarasota)"

## Infrastructure
* Hosting: Netlify, site name "strong-moonbeam-b8d8e4", Git-connected to GitHub main branch
* Netlify plan: Personal ($9/mo) — could downgrade to Free (pending)
* Netlify team: "Afiliado do Zero" (ID ketinha26)
* Storage: Netlify Blobs — stores: "deals", "submissions", "tokens", "images", "pending-emails"
* Domain: deals-aholic.com (bought on Namecheap, DNS pointing to Netlify)

## Environment variables in Netlify
* AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_PARTNER_TAG = kethya08-20
* PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
* ADMIN_PASSWORD (known by owner)

## Netlify Functions
* fetch-deals.mjs — scheduled hourly, fetches Amazon deals in 5 batches of 7 categories
* get-deals.mjs — public endpoint, returns Amazon deals + approved submissions merged
* get-submissions.mjs — admin only, returns all submissions
* review-submission.mjs — admin only, approve/reject submissions
* create-paypal-order.mjs — creates PayPal order for seller packages
* capture-paypal-order.mjs — captures payment, saves submission, generates token for multi-post packages
* submit-email-deal.mjs — receives email deals from Make automation
* admin-create-deal.mjs — admin creates deals manually (auto-fetches image from Amazon API)
* delete-submission.mjs — admin deletes submissions
* edit-submission.mjs — admin edits submissions
* create-token.mjs — generates seller token after payment
* validate-token.mjs — validates seller token and returns credits
* use-token.mjs — uses one credit from seller token
* get-image.mjs — serves images stored in Netlify Blobs

## Seller Token System
* Seller pays for package (1/5/10 posts)
* After payment, unique token generated
* Token link shown on screen: deals-aholic.com/submit.html?token=XXXX
* Seller uses same link each time to submit remaining deals
* Each submission uses 1 credit
* Token page shows remaining credits and instructions

## Make.com Automation (PARTIALLY WORKING)
* Scenario: Gmail → Claude → HTTP → Telegram → Facebook
* Gmail watches inquiresonthego@gmail.com for unread emails
* Claude extracts deal info from email
* HTTP posts to submit-email-deal Netlify function (JSON encoding issue — NOT FULLY WORKING)
* Telegram posts deal to t.me/dealsaholic channel
* Facebook posts to both Deals-aholic and 101 Savings pages
* Make free plan: 1,000 credits/month

## Admin Page Features
* Login with ADMIN_PASSWORD
* Pending tab — approve/reject/delete seller submissions
* Approved tab — edit/delete approved deals
* Rejected tab — delete rejected submissions
* Create Post tab — manually create deals (auto-fetches image from Amazon API)

## Google AdSense
* Applied for AdSense with ca-pub-5899720587294349
* Code added to index.html, about.html, privacy.html
* Pending review (1-14 days)

## Known Issues / Pending
1. Make HTTP module JSON encoding issue — email deals not posting to site
2. Netlify plan downgrade to Free (pending)
3. Gmail email sending for seller tokens (pending — Make not working)
4. Walmart affiliate API integration (not started)
5. Debug fields cleanup in fetch-deals.mjs output

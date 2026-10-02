# Instagram daily-plan operations

This workflow publishes Instagram only for `@deals_aholic`. It does not read
or change a Facebook publisher, page, token, schedule, API, or workflow.

All creatives must pass the locked visual contract in
`docs/instagram-visual-style.md`. A 1080×1350 dimension check alone does not
make a creative publishable.

## Automatic workflow

`prepare-instagram-day` runs during the 6:00 PM ET planning window. It:

1. reads real deals from the existing `deals/latest` blob;
2. rejects incomplete or previously reserved/published Instagram deals;
3. freezes the exact title, price, promo code, product image, and Deals-Aholic URL;
4. consumes a separately approved luxury editorial creative for that exact deal;
5. decodes and validates each JPEG as exactly 1080×1350;
6. stores the validated bytes in `instagram-creatives`; and
7. creates the next day's six slots at 7 AM, 10 AM, 1 PM, 4 PM, 7 PM, and 10 PM ET.

Critical copy is kept inside the centered 1080×1080 safe area (`y=135..1215`),
so Instagram's square profile/feed crop cannot cut off the title, price, code,
branding, or CTA.

`publish-social-deals` runs every five minutes. It publishes only the frozen
slot for the current hour, verifies that its stored creative is validated and
publicly retrievable, confirms the token belongs to `@deals_aholic`, creates one
Instagram container, waits for processing to finish, publishes it, and logs the
media ID. A saved container is reused on retry. An uncertain create result is
stopped for manual recovery instead of risking a duplicate.

## Approving creatives for the schedule

The planner no longer waits for approval fields that do not exist in the deal
feed. Queue each finished creative through the protected Instagram-only endpoint.
It validates the deal against the live feed, decodes the file, enforces exactly
1080×1350, and stores it independently of Facebook:

```sh
curl -X POST https://deals-aholic.com/api/queue-instagram-creative \
  -H 'x-social-automation-secret: <SOCIAL_AUTOMATION_SECRET>' \
  -F 'dealId=<EXISTING_DEAL_ID>' \
  -F 'styleApproved=true' \
  -F 'image=@approved-1080x1350.jpg'
```

Six unique approved creatives are required before the next-day plan becomes
ready. An image is never scheduled before validation.

## LinkDM synchronization

LinkDM is not an Instagram publishing prerequisite. The account's LinkDM
**Next Post** rule attaches the DM automation after LinkDM synchronizes the new
Instagram media. The plan records `next_post_published_pending_sync` after a
successful publish instead of incorrectly reporting LinkDM as unused. A stale
"Last synced" time in LinkDM means the post is published but the LinkDM import
has not run yet; **Check for new posts** forces that import.

Submit an optional code with:

```sh
curl -X POST https://deals-aholic.com/.netlify/functions/set-linkdm-draft-code \
  -H 'Content-Type: application/json' \
  -H 'x-social-automation-secret: <SOCIAL_AUTOMATION_SECRET>' \
  --data '{"date":"YYYY-MM-DD","hour":"07","draftCode":"<LINKDM_DRAFT_CODE>"}'
```

The repository has no verified LinkDM API credential, so it does not claim to
create or activate LinkDM automations itself.

## Diagnostics

Use `GET /api/instagram-plan-status?date=YYYY-MM-DD`. The response includes the
frozen deal identity and URL, price/promo fields, creative validation metadata,
Instagram state/media ID, retries, and the last error. It never returns access
tokens, captions, or raw LinkDM Draft Codes.

Required Netlify variable: `INSTAGRAM_ACCESS_TOKEN` for `@deals_aholic`.

Optional variables:

- `SOCIAL_AUTOMATION_SECRET` — required to queue approved creatives or add a LinkDM Draft Code.

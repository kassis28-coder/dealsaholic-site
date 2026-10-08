# Instagram daily-plan operations

This workflow publishes Instagram only for `@deals_aholic`. It does not read
or change a Facebook publisher, page, token, schedule, API, or workflow.

All creatives must pass the locked luxury editorial style check. A 1080×1350
dimension check alone does not make a creative publishable.

## Automatic workflow

Two isolated scheduled functions prepare the next-day plan: `prepare-instagram-noon`
runs at 12:00 PM ET and `prepare-instagram-day` runs at 6:00 PM ET. Netlify cron
uses UTC, so each function checks every five minutes and gates work against
`America/New_York`; this keeps both runs aligned through daylight-saving changes.
The noon job fills 8 AM–1 PM, and the evening job fills 2 PM–7 PM. Each job:

1. reads recent Instagram captions and excludes every Deals-Aholic deal URL already posted;
2. reads real deals from the existing `deals/latest` blob;
3. rejects incomplete or previously reserved/published Instagram deals, including the same ASIN arriving under a different deal ID;
4. freezes the exact title, price, promo code, product image, and Deals-Aholic URL;
5. consumes a separately approved luxury editorial creative for that exact deal;
6. decodes and validates each JPEG as exactly 1080×1350;
7. stores the validated bytes in `instagram-creatives`; and
8. creates or fills only its six next-day slots, preserving any other batch already in the plan.

Critical copy is kept inside the centered 1080×1080 safe area (`y=135..1215`),
so Instagram's square profile/feed crop cannot cut off the title, price, code,
branding, or CTA.

`publish-instagram-deals` runs every five minutes. It publishes only the frozen
slot for the current hour, verifies that its stored creative is validated and
publicly retrievable, confirms the token belongs to `@deals_aholic`, creates one
Instagram container, waits for processing to finish, publishes it, and logs the
media ID. A saved container is reused on retry. An uncertain create result is
stopped for manual recovery instead of risking a duplicate.

Immediately before container creation, the publisher checks the live Instagram
captions again. If the exact deal URL is already present, publication is blocked
with `duplicate_detected`; a different product must be selected in a new plan.

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

Six unique approved creatives are required for each batch; the plan is marked
ready only when all twelve slots exist. An image is never scheduled before validation.

## LinkDM synchronization

This retains the existing LinkDM **Next Post** workflow: Instagram publishes
the scheduled post, then LinkDM synchronizes that new post and applies the
configured comment-to-DM automation. The plan records
`next_post_published_pending_sync` until that sync occurs. A stale "Last synced"
time means LinkDM has not imported the Instagram post yet; **Check for new
posts** forces that import. No new LinkDM API or scheduling method is introduced.

Submit an optional code with:

```sh
curl -X POST https://deals-aholic.com/.netlify/functions/set-linkdm-draft-code \
  -H 'Content-Type: application/json' \
  -H 'x-social-automation-secret: <SOCIAL_AUTOMATION_SECRET>' \
  --data '{"date":"YYYY-MM-DD","hour":"07","draftCode":"<LINKDM_DRAFT_CODE>"}'
```

The existing `set-linkdm-draft-code` endpoint remains available for explicit
per-post LinkDM codes; the automatic `Next Post` path does not require inventing
or preassigning a draft code.

## Diagnostics

Use `GET /api/instagram-plan-status?date=YYYY-MM-DD`. The response includes the
frozen deal identity and URL, price/promo fields, creative validation metadata,
Instagram state/media ID, retries, and the last error. It never returns access
tokens, captions, or raw LinkDM Draft Codes.

Required Netlify variable: `INSTAGRAM_ACCESS_TOKEN` for `@deals_aholic`.

Optional variables:

- `SOCIAL_AUTOMATION_SECRET` — required to queue approved creatives or add a LinkDM Draft Code.

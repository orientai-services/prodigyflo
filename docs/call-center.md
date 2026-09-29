# Call Center (Door 2) — branch `feat/call-center-desk`

Not on `main`. Do not point production Twilio or Meta at this until humans sign off.

## What this is
Staff desk for Facebook lead-ad form fills and inbound calls to the number printed on those ads.

Not the SCS journey. Journey people stay on Clients / intake.

Language chip is stamped from Page ID (`CALL_CENTER_PAGE_EN` / `CALL_CENTER_PAGE_ES`). Never from a name.

## What is live on this branch
- `/call-center` desk with demo Door 2 leads
- Call / Text / Book / Missed as **mock** actions
- `POST /api/call-center/ingest` locked until `CALL_CENTER_INGEST_KEY` is set

## What is not plugged
- Twilio voice / SMS
- Facebook leadgen webhook
- Prisma write to production (SQL file is additive and unapplied)

## After humans say the desk is right
1. Preview deploy this branch only.
2. Set page IDs + ingest key on the preview.
3. Post one test form through ingest.
4. Only then attach Twilio webhooks to the **preview** host, not production Flo.

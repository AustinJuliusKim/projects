# studio-leads

Small Lambda behind an API Gateway HttpApi that validates and stores small-business leads from the studio landing page in DynamoDB, and optionally emails the lead a checklist link through SES.

## Contract

`POST /leads` with `content-type: application/json` (body max 8 KB). CORS is configured on the HttpApi (`AllowedOrigin` parameter).

| Field | Rules |
| --- | --- |
| `email` | required, trimmed, lowercased, valid format, max 254 |
| `firstName` | required, max 80 |
| `businessType` | required: `restaurant`, `salon-booking`, `retail`, `professional-office`, `other` |
| `businessName` | required, max 120 |
| `website` | optional; http(s) URL max 200 (bare domains get `https://`) |
| `city` | required: `glendale`, `pasadena`, `burbank`, `sfv`, `la-other`, `other` |
| `consent` | must be `true` |
| `utm` | optional object; only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` (strings, max 100) kept |
| `company` | honeypot; must be empty or absent |

| Status | Body | When |
| --- | --- | --- |
| 201 | `{"ok":true}` | stored (upsert by email; `createdAt` preserved) |
| 200 | `{"ok":true}` | honeypot filled (nothing stored) |
| 400 | `{"error":"invalid_json"}` | body is not JSON |
| 400 | `{"error":"invalid","fields":{...}}` | validation failed |
| 413 | `{"error":"payload_too_large"}` | body over 8 KB |
| 500 | `{"error":"server_error"}` | storage failure |

A welcome-email failure never changes the 201.

## Local test

```
npm install
npm test
```

Tests use fakes only; no AWS calls.

## Deploy (documented only)

```
sam build && sam deploy --guided
```

Parameters: `AllowedOrigin`, `SendWelcomeEmail` (`"false"` default), `FromAddress`, `ChecklistUrl`, `MailingAddress`. The `ApiUrl` output is the base URL; POST to `<ApiUrl>/leads`. The table is retained on stack deletion.

## Enabling SES welcome email

1. Verify the sender identity (domain or address) in SES in the stack's region.
2. Request production access (move out of the SES sandbox) so you can send to arbitrary recipients.
3. Redeploy with `SendWelcomeEmail=true`, `FromAddress=<verified address>`, and a real `MailingAddress` (CAN-SPAM requires a physical address).

The IAM grant for `ses:SendEmail` exists only when the email is enabled and is limited to `FromAddress`.

## Privacy

Stores only the submitted fields plus `createdAt`/`updatedAt` timestamps. No IP address or user agent is recorded, and error logs do not include the lead's email.

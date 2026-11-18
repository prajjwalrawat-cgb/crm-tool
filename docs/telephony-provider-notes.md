# Telephony provider notes

Written 2026-11-14 from Exotel's official developer docs, fetched before the adapter was written. Field names change between API versions, so the adapter (`src/telephony/providers/exotel.ts`) maps payloads defensively: unknown fields are ignored, missing fields are tolerated, and both PascalCase and lower-case keys are accepted.

Sources:
- [Make a call (Calls/connect)](https://developer.exotel.com/api/make-a-call-api)
- [Status callback (v1)](https://developer.exotel.com/docs/voice-v1/api-reference/status-callback)
- [Webhooks & callbacks](https://developer.exotel.com/docs/references/webhooks)
- [Authentication](https://developer.exotel.com/docs/references/authentication)
- [Passthru applet guide](https://developer.exotel.com/docs/app-bazaar/passthru-applet-guide)
- [Call details](https://developer.exotel.com/docs/voice-v1/api-reference/call-details)

## Exotel

### Auth and base URL

- **Auth:** HTTP Basic auth. The username is the **API key** and the password is the **API token**. The docs say not to put them in the URL.
- **Account SID:** goes in every path. It is not secret, but keep it out of client code.
- **Region:** Singapore is `api.exotel.com` (the default). Mumbai is `api.in.exotel.com`, for India accounts. Using the wrong region fails authentication. The region is stored per account (`credentials.subdomain`).
- **Base URL:** `https://<subdomain>/v1/Accounts/<account_sid>/`.
- **Rate limit:** 200 requests/min, then 429.

### Click-to-call: `POST /v1/Accounts/{sid}/Calls/connect` (form-encoded)

Exotel rings `From` first (the agent), then `To` (the customer).

| Param | Our value |
|---|---|
| `From` | agent phone, E.164 (`user_phone_mapping.agent_phone`) |
| `To` | customer phone, E.164 |
| `CallerId` | ExoPhone from `telephony_accounts.virtual_numbers` |
| `Record` | `true` when the tenant has recording on |
| `CallType` | `trans` |
| `CustomField` | our `calls.id` (max 128 chars), echoed back in the StatusCallback |
| `StatusCallback` | `https://<app>/api/public/telephony/exotel/<accountId>/webhook?s=<webhook_secret>` |
| `StatusCallbackEvents[0]` / `[1]` | `answered`, `terminal` |
| `StatusCallbackContentType` | `application/json` |
| `TimeLimit` / `TimeOut` | optional, not set |

The response is JSON with `Call.Sid` (our `provider_call_id`), `Call.Status` (`queued`, `in-progress`, `completed`, `failed`, `busy`, `no-answer`) and `Call.Direction` (`inbound`, `outbound-dial` or `outbound-api`). Errors come as `RestException { Status, Message }`.

### StatusCallback (outbound)

- **Always present:** `CallSid`, `DateUpdated` (`YYYY-MM-DD HH:mm:ss`), `Status` (`completed`, `failed`, `busy` or `no-answer`), `RecordingUrl` (only when recording was on and a conversation happened).
- **When `StatusCallbackEvents` is set:** `EventType` (`answered` or `terminal`), `DateCreated`, `To`, `From`, `PhoneNumberSid`, `StartTime`, `EndTime`, `ConversationDuration` (seconds both parties were connected, our `talk_time_sec`), `Direction`, `CustomField`.
- **`Legs[]`:** `{ OnCallDuration, Status, AnsweredBy? }`. Leg status is `completed`, `busy`, `failed`, `no-answer`, `canceled` or `null`. `AnsweredBy` is documented as `Human`, `Machine`, `NotSure` or `NA`, but an example shows `HUMAN`, so we compare case-insensitively.
- **Timing:** `Duration`, `Price` and `EndTime` settle about 2 minutes after hangup. Non-terminal events can carry null `EndTime` and `RecordingUrl`.
- **Content type:** not stated. The example is JSON, and older applets post form data, so the webhook route accepts JSON, form-urlencoded and query string.
- **Reliability:** delivery can be late or fail. The docs recommend the Call Details API (`GET /v1/Accounts/{sid}/Calls/{CallSid}.json`) as a fallback. We don't have that reconciliation yet; see BUILD_NOTES.

### Inbound calls (Passthru applet)

The ExoPhone's flow needs a Passthru applet pointing at our webhook URL. Parameters: `CallSid`, `CallFrom` (caller), `CallTo` (ExoPhone), `Direction` (`incoming`/`outgoing`, or `inbound`/`outbound` in AgentStream), `DialWhomNumber` (the agent dialled last), and `DialCallStatus` (second-leg result after a Connect applet: `completed`, `client-hangup`, `incomplete` or `voicemail`). The method can be GET or POST. Some versions send `From`/`To` instead of `CallFrom`/`CallTo`, so the adapter reads both.

### Webhook security

Exotel documents **no request signature**. Its recommendations are HTTPS, an allowlist of Exotel IPs (ranges come from support, not published), payload validation, idempotency on `CallSid`, and not relying on a hard-to-guess path alone. We do:

1. A per-account `webhook_secret` in the callback URL (`?s=`), compared in constant time. Exotel cannot add headers.
2. An optional IP allowlist from env `EXOTEL_WEBHOOK_IPS` (comma-separated). When unset, no IP check is done.
3. Rejection of payloads without a `CallSid`.
4. An idempotent upsert on `(tenant, provider, provider_call_id)`, with status that only moves forward.

### Recordings

`RecordingUrl` is an S3 URL (the examples use `s3-ap-southeast-1.amazonaws.com/exotelrecordings/...`). No auth requirement is documented. We GET it without auth and retry once with Basic auth on 401/403. Recordings can lag the terminal webhook, so archiving retries with backoff for up to 30 minutes.

## Knowlarity, Ozonetel, MyOperator, Twilio

These are registered in the provider registry and throw `NotImplementedError`. Read each provider's current docs before implementing; field names were not taken from memory here.

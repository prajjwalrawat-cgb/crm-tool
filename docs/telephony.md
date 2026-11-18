# Setting up telephony (Exotel)

For the workspace admin who connects calling. It takes about 15 minutes once you have an Exotel account with at least one ExoPhone (virtual number).

## What you get

- **Click-to-call:** a Call button on each lead and on contact phone numbers. Your own phone rings first, then the customer's.
- **Inbound calls:** a popup on the lead owner's screen showing who is calling, their company and the last interaction. A caller who isn't in the CRM yet gets a new lead, routed by your distribution rules.
- **Call log:** every call on the lead timeline with its duration and outcome. If recording is on, the recording can be played from the lead page.
- **Dispositions:** after each call the rep records the outcome (Interested, Call back, Do not call…). *Call back* creates a task. *Do not call* adds the number to your do-not-call list.
- **Dialer campaigns:** work a list of leads one call at a time, in preview or progressive mode.
- **AI call summaries (optional, off by default):** see the last section.

## 1. Before you start (your server admin)

These settings go in the server environment, not in the app:

| Variable | Why |
|---|---|
| `KMS_KEY` | **Required.** 32 random bytes, as 64 hex characters (`openssl rand -hex 32`). Exotel credentials are encrypted with it. If it is lost, re-enter the credentials. If it leaks, rotate it and re-enter the credentials. |
| `APP_URL` | The public address of the app, e.g. `https://crm.example.com`. Webhook URLs are built from it. |
| `SUPABASE_CALL_RECORDINGS_BUCKET` | Optional; the default is `call-recordings`. Create this bucket as **private**. |
| `EXOTEL_WEBHOOK_IPS` | Optional. A comma-separated list of the IP addresses Exotel calls from; you get them from Exotel support. When set, webhooks from any other IP are rejected. |
| `TELEPHONY_STT_PROVIDER`, `ANTHROPIC_API_KEY` | Only for AI summaries; see below. |

Inngest must be running in production. Webhooks, recording archiving and the dialer all run as background jobs.

## 2. Connect the Exotel account

1. In Exotel, open **Settings → API Settings** and copy the **Account SID**, **API key** and **API token**.
2. In Saleinx, open **Settings → Telephony → Provider account**.
3. Choose **exotel**. Pick the API region: India accounts are usually **Mumbai (api.in.exotel.com)**. The wrong region makes every call fail to authenticate.
4. Paste the three values and your ExoPhone number(s) as caller ids, then click **Save account**.
   The credentials are encrypted and are never shown again. To change them later, type new ones; leaving the fields blank keeps the saved values.

## 3. Map each agent's phone

Under **Agent phones**, pick each rep and enter the mobile or desk phone Exotel should ring for them. Only mapped reps can place calls and see the call bar at the bottom of the app. Reps set themselves Available, On break or Offline there. Offline or On break also stops new leads being routed to them.

## 4. Inbound calls

Outbound calls report their status to Saleinx automatically. For **inbound** calls:

1. Copy the **Webhook URL** shown under the account in Settings → Telephony.
2. In Exotel's App Bazaar, open the call flow attached to your ExoPhone. Add a **Passthru** applet pointing at that URL, before the Connect applet that rings your agents.

The `s=` part of the URL is a secret: treat the URL like a password. If it leaks, click **Rotate** and paste the new URL into Exotel.

## 5. Test

Under **Test call**, enter your own second phone and click **Place test call**. Your mapped phone rings first; answer it and the second phone rings. Hang up, and the call appears with its outcome.

## 6. Calling policy and compliance

- **Calling hours:** reps can't dial outside the window, which defaults to 09:00–21:00 IST. Managers are asked to confirm first.
- **Do-not-call list:** numbers on it are blocked from click-to-call and skipped by the dialer. Upload a CSV or a plain list, one number per line.
- **Recording:** turn it on or off, and record the consent-policy version in force. If you want a "this call may be recorded" announcement, configure the audio in your Exotel call flow.
- **Who can hear recordings:** reps hear their own calls; managers, admins and owners hear all calls in the workspace. Every play is logged.

**Your organisation is responsible for compliance.** That includes scrubbing numbers against the national DND/NDNC registry, following TRAI rules on commercial calls and calling hours, and getting the recording consent your jurisdiction requires. Saleinx blocks only the numbers on this workspace's own list and does not check any registry.

## 7. Dialer campaigns

Managers create campaigns under **Dialer** (in the call bar) → **New campaign**. Pick the leads (by stage, source or date), the agents, the calling hours, the maximum attempts and the gap between retries. Start the campaign from its board.

- **Preview:** the agent sees the lead and presses Call.
- **Progressive:** as soon as the agent saves a disposition and is Available, the next lead is dialled.

Two agents never get the same lead. Unanswered and busy calls come back after the retry gap.

## 8. AI call summaries (optional)

These are off by default, because they send call content to outside services:

1. A speech-to-text engine turns the recording into a transcript. None is enabled yet; choosing one is a separate decision, since it sends call audio to that provider.
2. Claude (Anthropic) turns the transcript into a short summary: next steps, sentiment, objections, competitors mentioned, a suggested disposition and an optional follow-up date. Only the transcript and the call date are sent. No names, phone numbers or CRM fields are sent.

Summaries run only for calls with at least 45 seconds of talk time. The summary is labelled AI-generated. A follow-up date is offered as a task the rep can accept, never created automatically, and it is dropped if the transcript doesn't mention a day.

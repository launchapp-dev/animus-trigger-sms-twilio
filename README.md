# animus-trigger-sms-twilio

Twilio SMS/MMS trigger backend plugin for [Animus](https://github.com/launchapp-dev).
Receives inbound SMS via Twilio's HTTP webhook and sends outbound SMS/MMS via
Twilio's Programmable Messaging REST API.

- **Plugin kind:** `trigger_backend`
- **Protocol:** STDIO JSON-RPC (Animus plugin protocol v0.1)
- **Inbound:** validated `X-Twilio-Signature` HTTP webhook → `sms.received` /
  `mms.received` trigger events
- **Outbound:** `sms/send` and `sms/send_mms` custom RPC methods

## Setup

### 1. Create a Twilio account and buy a phone number

1. Sign up at <https://www.twilio.com/try-twilio>.
2. From the console, copy your **Account SID** and **Auth Token**.
3. Buy an SMS-capable phone number (Phone Numbers → Buy a number → check SMS).

### 2. Expose the webhook publicly

Twilio needs a publicly reachable HTTPS URL to deliver inbound SMS. In dev,
run [ngrok](https://ngrok.com/):

```bash
ngrok http 8091
```

Copy the `https://abc123.ngrok.io` URL. In Twilio's console, under
**Phone Numbers → Active numbers → \<your number\> → Messaging Configuration**,
set **A message comes in** → **Webhook** → `https://abc123.ngrok.io/sms` (POST).

### 3. Install the plugin

```bash
animus plugin install launchapp-dev/animus-trigger-sms-twilio
```

Or build from source:

```bash
git clone https://github.com/launchapp-dev/animus-trigger-sms-twilio.git
cd animus-trigger-sms-twilio
npm install
npm run build
animus plugin install ./
```

### 4. Configure environment

Set the following in the **Animus daemon's** process environment (the plugin
host scrubs the daemon env before spawn and only forwards declared vars):

| Variable                | Required | Description                                                                 |
| ----------------------- | -------- | --------------------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID`    | yes      | Twilio account SID (starts with `AC...`).                                  |
| `TWILIO_AUTH_TOKEN`     | yes      | Twilio auth token — used for webhook signature validation AND outbound auth. |
| `TWILIO_FROM_NUMBER`    | yes      | Default E.164 sender (e.g. `+15551234567`).                                |
| `TWILIO_WEBHOOK_PORT`   | no       | Local port for the inbound HTTP server (default `8091`).                   |
| `TWILIO_WEBHOOK_PATH`   | no       | HTTP path the server responds on (default `/sms`).                         |
| `TWILIO_PUBLIC_URL`     | no       | Full public URL Twilio posts to (e.g. `https://abc123.ngrok.io`). Strongly recommended — required for signature validation behind multi-hop proxies. |

### 5. Use it in a workflow

```yaml
# .animus/workflows.yaml
triggers:
  - id: sms-inbox
    backend: animus-trigger-sms-twilio
    events: [sms.received, mms.received]
    on_event:
      - workflow: handle-sms
        with:
          from: ${event.payload.from}
          body: ${event.payload.body}

workflows:
  handle-sms:
    phases:
      - id: reply
        plugin_rpc:
          plugin: animus-trigger-sms-twilio
          method: sms/send
          params:
            to: ${inputs.from}
            body: "Got your message. Working on it."
```

## Trigger events

### `sms.received`

Emitted for plain text messages (`NumMedia == 0`).

```json
{
  "trigger_id": "sms-inbox",
  "event_id": "SMxxxxxxxx",
  "kind": "sms.received",
  "payload": {
    "from": "+15551234567",
    "to": "+15557654321",
    "body": "hello",
    "message_sid": "SMxxxxxxxx",
    "num_segments": 1,
    "num_media": 0,
    "media_urls": [],
    "media": [],
    "account_sid": "ACxxxxxxxx",
    "from_city": "SAN FRANCISCO",
    "from_state": "CA",
    "from_country": "US",
    "from_zip": "94107",
    "received_at": "2026-05-28T15:21:33.412Z"
  }
}
```

### `mms.received`

Emitted when `NumMedia >= 1`. Same payload as `sms.received`, with
`media_urls`/`media` populated.

## Custom RPC methods

### `sms/send`

Send a plain SMS.

```jsonc
{
  "method": "sms/send",
  "params": {
    "to": "+15551234567",
    "body": "hello",
    "from": "+15557654321",          // optional; defaults to TWILIO_FROM_NUMBER
    "status_callback": "https://..." // optional; Twilio delivery receipts
  }
}
```

Returns:

```json
{
  "message_sid": "SMxxx",
  "status": "queued",
  "to": "+15551234567",
  "from": "+15557654321",
  "date_created": "2026-05-28T15:21:33.412Z",
  "price": null,
  "price_unit": null,
  "num_segments": "1",
  "error_code": null,
  "error_message": null
}
```

### `sms/send_mms`

Send an MMS with one or more public media URLs.

```jsonc
{
  "method": "sms/send_mms",
  "params": {
    "to": "+15551234567",
    "body": "look at this",
    "media_url": "https://example.com/pic.jpg"
    // or media_url: ["https://...a.jpg", "https://...b.jpg"]
  }
}
```

## Security

Inbound webhook requests are validated against Twilio's
`X-Twilio-Signature` header using the official `twilio` Node SDK
(`validateRequest`). Requests with a missing or invalid signature are
rejected with HTTP 403 and produce no trigger event. Anyone who can reach
the webhook port but does NOT have your `TWILIO_AUTH_TOKEN` cannot forge a
matching signature, so they cannot spoof inbound SMS.

Set `TWILIO_PUBLIC_URL` to the exact URL configured in Twilio's console
— signature validation depends on byte-for-byte URL match.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

[Elastic-2.0](./LICENSE)

## Not covered in v0.1

- **WhatsApp via Twilio** (`whatsapp:+...` numbers + Twilio Sandbox / Business API)
- **Voice** (`<Voice>` TwiML, inbound calls, recordings)
- **Status callbacks** (delivery receipts as separate trigger events)
- **Outbound message templates / messaging services** (`messagingServiceSid`)

Track these in v0.2.

// Translate a Twilio inbound SMS/MMS form-encoded webhook payload into a
// normalized Animus TriggerEvent.
//
// Twilio posts `application/x-www-form-urlencoded` with these fields (subset):
//   - MessageSid:    "SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
//   - AccountSid:    "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
//   - From:          "+15551234567" (E.164)
//   - To:            "+15557654321" (E.164, the Twilio number receiving the msg)
//   - Body:          "hello world"
//   - NumSegments:   "1"
//   - NumMedia:      "0"            (>=1 means MMS)
//   - MediaUrl0..N:  "https://api.twilio.com/..../Media/MExxxx"
//   - MediaContentType0..N: "image/jpeg"
//   - FromCity / FromState / FromCountry / FromZip (best-effort geo)
//
// Reference: https://www.twilio.com/docs/messaging/guides/webhook-request

export interface TwilioInboundForm {
  [key: string]: string | undefined;
}

export interface InboundEvent {
  /** "sms.received" for text-only, "mms.received" when NumMedia > 0. */
  kind: 'sms.received' | 'mms.received';
  /** Stable Twilio Message SID; used as the event_id. */
  message_sid: string;
  account_sid: string;
  /** E.164 sender. */
  from: string;
  /** E.164 receiving Twilio number. */
  to: string;
  body: string;
  num_segments: number;
  num_media: number;
  media: ReadonlyArray<{ url: string; content_type: string }>;
  /** Best-effort caller geo (Twilio fills when available). */
  from_city?: string;
  from_state?: string;
  from_country?: string;
  from_zip?: string;
  /** ISO-8601 timestamp when this plugin received the webhook. */
  received_at: string;
}

function asInt(s: string | undefined, fallback: number): number {
  if (s === undefined || s === '') return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a Twilio inbound webhook form payload into an `InboundEvent`. */
export function parseTwilioInbound(form: TwilioInboundForm, now: Date = new Date()): InboundEvent {
  const message_sid = form.MessageSid ?? form.SmsMessageSid ?? form.SmsSid;
  if (!message_sid || message_sid.length === 0) {
    throw new Error('twilio inbound: missing MessageSid');
  }
  const account_sid = form.AccountSid;
  if (!account_sid || account_sid.length === 0) {
    throw new Error('twilio inbound: missing AccountSid');
  }
  const from = form.From;
  const to = form.To;
  if (!from || !to) {
    throw new Error('twilio inbound: missing From/To');
  }
  const num_segments = asInt(form.NumSegments, 1);
  const num_media = asInt(form.NumMedia, 0);

  const media: Array<{ url: string; content_type: string }> = [];
  for (let i = 0; i < num_media; i += 1) {
    const url = form[`MediaUrl${i}`];
    if (!url) continue;
    const ct = form[`MediaContentType${i}`] ?? 'application/octet-stream';
    media.push({ url, content_type: ct });
  }

  const event: InboundEvent = {
    kind: num_media > 0 ? 'mms.received' : 'sms.received',
    message_sid,
    account_sid,
    from,
    to,
    body: form.Body ?? '',
    num_segments,
    num_media,
    media,
    received_at: now.toISOString(),
  };
  if (form.FromCity) event.from_city = form.FromCity;
  if (form.FromState) event.from_state = form.FromState;
  if (form.FromCountry) event.from_country = form.FromCountry;
  if (form.FromZip) event.from_zip = form.FromZip;
  return event;
}

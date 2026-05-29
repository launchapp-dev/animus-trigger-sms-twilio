// Outbound SMS/MMS via Twilio's Programmable Messaging REST API.
//
// Wraps `twilio(accountSid, authToken).messages.create({ to, from, body, mediaUrl })`.
// Authors call these from workflow YAML via the custom RPC methods `sms/send`
// and `sms/send_mms`.

import type { Twilio } from 'twilio';

/** Result shape returned to the workflow runtime after a successful send. */
export interface SendResult {
  message_sid: string;
  status: string;
  to: string;
  from: string;
  date_created: string | null;
  price: string | null;
  price_unit: string | null;
  num_segments: string | null;
  error_code: number | null;
  error_message: string | null;
}

export interface SendParams {
  /** E.164 destination phone number. Required. */
  to: string;
  /** Message body. Required. */
  body: string;
  /** Override the default `TWILIO_FROM_NUMBER`. Optional. */
  from?: string;
  /** Optional StatusCallback URL for delivery receipts. */
  status_callback?: string;
}

export interface SendMmsParams extends SendParams {
  /** One or more public HTTPS URLs to media files (image/audio/video). Required. */
  media_url: string | string[];
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`twilio outbound: '${name}' must be a non-empty string`);
  }
  return value;
}

function normalizeMediaUrls(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (out.length === 0) throw new TypeError(`twilio outbound: 'media_url' must contain at least one URL`);
    return out;
  }
  throw new TypeError(`twilio outbound: 'media_url' must be a string or string[]`);
}

function toSendResult(msg: {
  sid: string;
  status: string;
  to: string;
  from: string;
  dateCreated: Date | null;
  price: string | null;
  priceUnit: string | null;
  numSegments: string | null;
  errorCode: number | null;
  errorMessage: string | null;
}): SendResult {
  return {
    message_sid: msg.sid,
    status: msg.status,
    to: msg.to,
    from: msg.from,
    date_created: msg.dateCreated ? msg.dateCreated.toISOString() : null,
    price: msg.price,
    price_unit: msg.priceUnit,
    num_segments: msg.numSegments,
    error_code: msg.errorCode,
    error_message: msg.errorMessage,
  };
}

/** Send a plain SMS. */
export async function sendSms(
  client: Twilio,
  defaultFrom: string,
  raw: unknown,
): Promise<SendResult> {
  const params = (raw ?? {}) as Partial<SendParams>;
  const to = requireString(params.to, 'to');
  const body = requireString(params.body, 'body');
  const from = typeof params.from === 'string' && params.from.length > 0 ? params.from : defaultFrom;
  if (!from) {
    throw new TypeError(
      `twilio outbound: 'from' not provided and TWILIO_FROM_NUMBER is unset`,
    );
  }
  const opts: Record<string, unknown> = { to, body, from };
  if (typeof params.status_callback === 'string' && params.status_callback.length > 0) {
    opts.statusCallback = params.status_callback;
  }
  const msg = await client.messages.create(opts as never);
  return toSendResult(msg);
}

/** Send an MMS (text + media attachment(s)). */
export async function sendMms(
  client: Twilio,
  defaultFrom: string,
  raw: unknown,
): Promise<SendResult> {
  const params = (raw ?? {}) as Partial<SendMmsParams>;
  const to = requireString(params.to, 'to');
  const body = requireString(params.body, 'body');
  const mediaUrl = normalizeMediaUrls(params.media_url);
  const from = typeof params.from === 'string' && params.from.length > 0 ? params.from : defaultFrom;
  if (!from) {
    throw new TypeError(
      `twilio outbound: 'from' not provided and TWILIO_FROM_NUMBER is unset`,
    );
  }
  const opts: Record<string, unknown> = { to, body, from, mediaUrl };
  if (typeof params.status_callback === 'string' && params.status_callback.length > 0) {
    opts.statusCallback = params.status_callback;
  }
  const msg = await client.messages.create(opts as never);
  return toSendResult(msg);
}

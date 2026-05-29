// Unit tests for the Twilio SMS trigger plugin.
//
// Coverage:
//   1. Signature validation: a request with no `X-Twilio-Signature` is rejected
//      (403, no event). A request with a forged signature is rejected. A
//      request signed with the right auth token is accepted (200) and emits
//      the expected event.
//   2. Inbound payload translation: Twilio form fields map to the wire event
//      shape with SMS vs MMS distinction via `NumMedia`.
//   3. Outbound: `sendSms` / `sendMms` call the Twilio client with the right
//      shape and surface the response.

import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

import { parseTwilioInbound } from './inbound.js';
import { sendMms, sendSms } from './outbound.js';
import { TwilioWebhookServer } from './webhook-server.js';
import type { InboundEvent } from './inbound.js';

/** Build the X-Twilio-Signature header Twilio would attach (HMAC-SHA1, base64).
 *  Algorithm per https://www.twilio.com/docs/usage/security#validating-requests:
 *     data = url + sorted(key + value for key,value in form)
 *     signature = base64(HMAC_SHA1(auth_token, data))
 */
function signTwilio(authToken: string, url: string, form: Record<string, string>): string {
  const keys = Object.keys(form).sort();
  let data = url;
  for (const k of keys) data += k + (form[k] ?? '');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

function formEncode(form: Record<string, string>): string {
  return Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

const AUTH_TOKEN = 'test-auth-token-do-not-use-in-prod';

async function startServer(events: InboundEvent[]) {
  // Port 0 → OS picks a free port; read it back from the underlying server.
  const server = new TwilioWebhookServer({
    authToken: AUTH_TOKEN,
    port: 0,
    path: '/sms',
    publicUrl: undefined,
    onEvent: (ev) => events.push(ev),
    // Silence logs in tests.
    logger: () => undefined,
  });
  await server.start();
  // We don't have direct access to the bound port; tunnel via the internal
  // listener using a clever cast. We expose port via re-opening: read after
  // listen. Simpler: re-create with a known free port.
  return server;
}

/** Start the server with an explicit port we pick. */
async function startServerOnPort(port: number, events: InboundEvent[], opts?: { publicUrl?: string }) {
  const server = new TwilioWebhookServer({
    authToken: AUTH_TOKEN,
    port,
    path: '/sms',
    publicUrl: opts?.publicUrl,
    onEvent: (ev) => events.push(ev),
    logger: () => undefined,
  });
  await server.start();
  return server;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import('node:net').then((net) => {
      const srv = net.createServer();
      srv.unref();
      srv.on('error', reject);
      srv.listen(0, () => {
        const addr = srv.address() as AddressInfo;
        const port = addr.port;
        srv.close(() => resolve(port));
      });
    }, reject);
  });
}

describe('parseTwilioInbound', () => {
  it('translates a plain SMS payload', () => {
    const ev = parseTwilioInbound({
      MessageSid: 'SM1111',
      AccountSid: 'AC0000',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'hello world',
      NumSegments: '1',
      NumMedia: '0',
      FromCity: 'SAN FRANCISCO',
      FromState: 'CA',
      FromCountry: 'US',
      FromZip: '94107',
    });
    expect(ev.kind).toBe('sms.received');
    expect(ev.message_sid).toBe('SM1111');
    expect(ev.from).toBe('+15551234567');
    expect(ev.to).toBe('+15557654321');
    expect(ev.body).toBe('hello world');
    expect(ev.num_media).toBe(0);
    expect(ev.media).toEqual([]);
    expect(ev.from_city).toBe('SAN FRANCISCO');
  });

  it('distinguishes MMS via NumMedia > 0', () => {
    const ev = parseTwilioInbound({
      MessageSid: 'MM2222',
      AccountSid: 'AC0000',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'pic',
      NumSegments: '1',
      NumMedia: '2',
      MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME0',
      MediaContentType0: 'image/jpeg',
      MediaUrl1: 'https://api.twilio.com/2010-04-01/Accounts/AC/Messages/MM/Media/ME1',
      MediaContentType1: 'image/png',
    });
    expect(ev.kind).toBe('mms.received');
    expect(ev.num_media).toBe(2);
    expect(ev.media).toHaveLength(2);
    expect(ev.media[0]?.content_type).toBe('image/jpeg');
  });

  it('throws on missing MessageSid', () => {
    expect(() =>
      parseTwilioInbound({
        AccountSid: 'AC0000',
        From: '+1',
        To: '+1',
      }),
    ).toThrow(/MessageSid/);
  });
});

describe('TwilioWebhookServer signature validation', () => {
  it('rejects requests with no X-Twilio-Signature (403, no event)', async () => {
    const port = await getFreePort();
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events);
    try {
      const form = formEncode({ MessageSid: 'SM1', AccountSid: 'AC0', From: '+1', To: '+2', Body: 'hi', NumMedia: '0' });
      const res = await fetch(`http://127.0.0.1:${port}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
      });
      expect(res.status).toBe(403);
      expect(events).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('rejects requests with a forged signature', async () => {
    const port = await getFreePort();
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events, { publicUrl: `http://127.0.0.1:${port}` });
    try {
      const form = formEncode({ MessageSid: 'SM1', AccountSid: 'AC0', From: '+1', To: '+2', Body: 'hi', NumMedia: '0' });
      const res = await fetch(`http://127.0.0.1:${port}/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': 'definitely-wrong-base64-signature',
        },
        body: form,
      });
      expect(res.status).toBe(403);
      expect(events).toHaveLength(0);
    } finally {
      await server.stop();
    }
  });

  it('accepts requests with a valid signature and emits a TriggerEvent', async () => {
    const port = await getFreePort();
    const publicUrl = `http://127.0.0.1:${port}`;
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events, { publicUrl });
    try {
      const form = {
        MessageSid: 'SM_valid',
        AccountSid: 'AC_acct',
        From: '+15551112222',
        To: '+15553334444',
        Body: 'pong',
        NumSegments: '1',
        NumMedia: '0',
      };
      const url = `${publicUrl}/sms`;
      const sig = signTwilio(AUTH_TOKEN, url, form);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': sig,
        },
        body: formEncode(form),
      });
      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]?.message_sid).toBe('SM_valid');
      expect(events[0]?.body).toBe('pong');
      expect(events[0]?.kind).toBe('sms.received');
    } finally {
      await server.stop();
    }
  });

  it('rejects non-POST methods', async () => {
    const port = await getFreePort();
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sms`, { method: 'GET' });
      expect(res.status).toBe(405);
    } finally {
      await server.stop();
    }
  });

  it('returns 404 for unknown paths', async () => {
    const port = await getFreePort();
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/other`, {
        method: 'POST',
        headers: { 'X-Twilio-Signature': 'any' },
        body: '',
      });
      expect(res.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('accepts requests when TWILIO_PUBLIC_URL is the full webhook URL', async () => {
    // Regression test for the documented setup where users paste the full
    // ngrok URL (e.g. `https://abc.ngrok.io/sms`) into TWILIO_PUBLIC_URL.
    // Twilio signs against that exact URL; if our server appends `/sms` again
    // the validator sees `/sms/sms` and rejects every valid request.
    const port = await getFreePort();
    const fullPublic = `http://127.0.0.1:${port}/sms`;
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events, { publicUrl: fullPublic });
    try {
      const form = {
        MessageSid: 'SM_full_url',
        AccountSid: 'AC_acct',
        From: '+15551112222',
        To: '+15553334444',
        Body: 'hello',
        NumSegments: '1',
        NumMedia: '0',
      };
      const sig = signTwilio(AUTH_TOKEN, fullPublic, form);
      const res = await fetch(`http://127.0.0.1:${port}/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': sig,
        },
        body: formEncode(form),
      });
      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
      expect(events[0]?.message_sid).toBe('SM_full_url');
    } finally {
      await server.stop();
    }
  });

  it('preserves trailing slash in TWILIO_PUBLIC_URL when configured that way', async () => {
    // Twilio signs the URL byte-for-byte; trimming a trailing slash flips the
    // signature. Validate the slash-preserving path.
    const port = await getFreePort();
    const fullPublic = `http://127.0.0.1:${port}/sms/`;
    const events: InboundEvent[] = [];
    const server = await startServerOnPort(port, events, { publicUrl: fullPublic });
    try {
      const form = {
        MessageSid: 'SM_trailing',
        AccountSid: 'AC_acct',
        From: '+15551112222',
        To: '+15553334444',
        Body: 'hello',
        NumSegments: '1',
        NumMedia: '0',
      };
      const sig = signTwilio(AUTH_TOKEN, fullPublic, form);
      const res = await fetch(`http://127.0.0.1:${port}/sms/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Twilio-Signature': sig,
        },
        body: formEncode(form),
      });
      expect(res.status).toBe(200);
      expect(events).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  it('refuses to construct without an auth token', () => {
    expect(
      () =>
        new TwilioWebhookServer({
          authToken: '',
          port: 1,
          path: '/sms',
          onEvent: () => undefined,
        }),
    ).toThrow(/authToken is required/);
  });
});

describe('outbound sendSms / sendMms', () => {
  it('sendSms forwards to/from/body to messages.create', async () => {
    const create = vi.fn().mockResolvedValue({
      sid: 'SM_out_1',
      status: 'queued',
      to: '+15551110001',
      from: '+15559990000',
      dateCreated: new Date('2026-05-01T12:00:00Z'),
      price: null,
      priceUnit: null,
      numSegments: '1',
      errorCode: null,
      errorMessage: null,
    });
    const client = { messages: { create } } as never;
    const res = await sendSms(client, '+15559990000', {
      to: '+15551110001',
      body: 'hello',
    });
    expect(create).toHaveBeenCalledWith({
      to: '+15551110001',
      body: 'hello',
      from: '+15559990000',
    });
    expect(res.message_sid).toBe('SM_out_1');
    expect(res.status).toBe('queued');
    expect(res.date_created).toBe('2026-05-01T12:00:00.000Z');
  });

  it('sendSms allows per-call from override and status_callback', async () => {
    const create = vi.fn().mockResolvedValue({
      sid: 'SM2', status: 'queued', to: '+1', from: '+2',
      dateCreated: null, price: null, priceUnit: null, numSegments: null,
      errorCode: null, errorMessage: null,
    });
    const client = { messages: { create } } as never;
    await sendSms(client, '+15559990000', {
      to: '+15551110001',
      body: 'hi',
      from: '+15558887777',
      status_callback: 'https://example.com/twilio-cb',
    });
    expect(create).toHaveBeenCalledWith({
      to: '+15551110001',
      body: 'hi',
      from: '+15558887777',
      statusCallback: 'https://example.com/twilio-cb',
    });
  });

  it('sendSms throws when no from is configured', async () => {
    const client = { messages: { create: vi.fn() } } as never;
    await expect(sendSms(client, '', { to: '+1', body: 'x' })).rejects.toThrow(/TWILIO_FROM_NUMBER/);
  });

  it('sendSms requires to and body', async () => {
    const client = { messages: { create: vi.fn() } } as never;
    await expect(sendSms(client, '+15559990000', { body: 'x' })).rejects.toThrow(/'to'/);
    await expect(sendSms(client, '+15559990000', { to: '+1' })).rejects.toThrow(/'body'/);
  });

  it('sendMms accepts a string media_url and array', async () => {
    const create = vi.fn().mockResolvedValue({
      sid: 'MM1', status: 'queued', to: '+1', from: '+2',
      dateCreated: null, price: null, priceUnit: null, numSegments: '1',
      errorCode: null, errorMessage: null,
    });
    const client = { messages: { create } } as never;
    await sendMms(client, '+15559990000', {
      to: '+15551110001',
      body: 'pic',
      media_url: 'https://example.com/img.jpg',
    });
    expect(create).toHaveBeenCalledWith({
      to: '+15551110001',
      body: 'pic',
      from: '+15559990000',
      mediaUrl: ['https://example.com/img.jpg'],
    });

    create.mockClear();
    await sendMms(client, '+15559990000', {
      to: '+15551110001',
      body: 'pics',
      media_url: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    });
    expect(create).toHaveBeenCalledWith({
      to: '+15551110001',
      body: 'pics',
      from: '+15559990000',
      mediaUrl: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    });
  });

  it('sendMms rejects empty/invalid media_url', async () => {
    const client = { messages: { create: vi.fn() } } as never;
    await expect(
      sendMms(client, '+15559990000', { to: '+1', body: 'x', media_url: [] }),
    ).rejects.toThrow(/media_url/);
    await expect(
      sendMms(client, '+15559990000', { to: '+1', body: 'x' }),
    ).rejects.toThrow(/media_url/);
  });
});

// Avoid unused-import lint for the helper we keep around in case future tests
// want a 0-port server.
void startServer;

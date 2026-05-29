// Tiny HTTP server that listens for Twilio's inbound SMS/MMS webhook POSTs and
// forwards validated payloads to a callback.
//
// Why we roll our own server:
//   - the plugin host doesn't (yet) expose an inbound HTTP transport to plugins
//   - a single-route Node `http` server has zero deps + zero attack surface
//   - we already need access to `process.env` for the Twilio auth token, so
//     spinning up a server here keeps secret handling local
//
// Signature validation (CRITICAL — see codex review notes):
//   - Twilio signs every webhook request with `X-Twilio-Signature` (HMAC-SHA1
//     of the full request URL + sorted form params, base64-encoded, keyed with
//     the account auth token).
//   - We use `twilio.validateRequest()` from the official SDK to verify.
//   - On signature failure we return 403 and emit NO event. This is the
//     non-negotiable guard against forged inbound SMS.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URLSearchParams } from 'node:url';
import twilioPkg from 'twilio';

// `twilio` is shipped as CJS — importing `{ validateRequest }` directly from
// ESM throws a "Named export not found" error. Pull it off the default export
// (the official documented pattern for CJS interop).
const { validateRequest } = twilioPkg;

import { parseTwilioInbound, type InboundEvent, type TwilioInboundForm } from './inbound.js';

export interface WebhookServerOptions {
  /** Twilio Auth Token (from `TWILIO_AUTH_TOKEN`). Required for signature validation. */
  authToken: string;
  /**
   * Public-facing URL the webhook is reachable at (must match what was
   * configured in Twilio's console — e.g. `https://abc123.ngrok.io/sms`).
   * Twilio computes the signature over this exact URL. If unset, we
   * reconstruct from the `Host` + `X-Forwarded-Proto` headers, which works
   * when behind a single reverse proxy but FAILS for multi-hop / mixed-scheme
   * setups. Always set `TWILIO_PUBLIC_URL` in production.
   */
  publicUrl?: string;
  /** Local TCP port to listen on. */
  port: number;
  /** HTTP path the server responds on (e.g. `/sms`). */
  path: string;
  /** Invoked once per validated inbound message. */
  onEvent: (event: InboundEvent) => void;
  /** Optional structured logger (stderr-only; stdout is reserved for JSON-RPC). */
  logger?: (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;
}

const defaultLogger: NonNullable<WebhookServerOptions['logger']> = (level, msg, extra) => {
  const line = extra === undefined
    ? `[twilio-webhook] ${level}: ${msg}`
    : `[twilio-webhook] ${level}: ${msg} ${JSON.stringify(extra)}`;
  process.stderr.write(`${line}\n`);
};

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reconstructUrl(req: IncomingMessage, publicUrl: string | undefined): string {
  if (publicUrl) {
    // Users typically configure TWILIO_PUBLIC_URL to the FULL webhook URL
    // (e.g. `https://abc.ngrok.io/sms`) because that's what they paste into
    // Twilio's console. Naively appending `req.url` (also `/sms`) would
    // produce `https://abc.ngrok.io/sms/sms`, which Twilio never signed →
    // every valid request fails 403.
    //
    // Strategy: parse `publicUrl` as a URL. If its path is empty or "/", treat
    // it as a base and append `req.url`. Otherwise treat it as the exact
    // webhook URL and use as-is (Twilio always POSTs to the configured URL,
    // so `req.url`'s path will match `publicUrl`'s path anyway).
    try {
      const parsed = new URL(publicUrl);
      // Only treat "no path" / "bare /" as "base URL needs req.url appended".
      // Any explicit path (e.g. `/sms`, `/sms/`, `/twilio/inbound/`) means the
      // user pasted the exact URL into Twilio's console — use it byte-for-byte
      // (including a meaningful trailing slash, since Twilio signs the URL
      // verbatim and `https://x/sms` vs `https://x/sms/` produce different
      // signatures).
      if (parsed.pathname === '' || parsed.pathname === '/') {
        const reqPath = req.url ?? '/';
        return `${parsed.origin}${reqPath.startsWith('/') ? reqPath : `/${reqPath}`}`;
      }
      return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch {
      // Fall through to header-based reconstruction on a malformed URL.
    }
  }
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = req.headers.host ?? 'localhost';
  return `${proto}://${host}${req.url ?? '/'}`;
}

function parseForm(body: string): TwilioInboundForm {
  const params = new URLSearchParams(body);
  const out: TwilioInboundForm = {};
  for (const [k, v] of params) {
    out[k] = v;
  }
  return out;
}

export class TwilioWebhookServer {
  private server: Server | null = null;
  private readonly opts: WebhookServerOptions;
  private readonly log: NonNullable<WebhookServerOptions['logger']>;

  constructor(opts: WebhookServerOptions) {
    if (!opts.authToken || opts.authToken.length === 0) {
      throw new TypeError('TwilioWebhookServer: authToken is required for signature validation');
    }
    this.opts = opts;
    this.log = opts.logger ?? defaultLogger;
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const { port, path } = this.opts;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log('error', 'handler crashed', String(err));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, () => {
        this.log('info', `listening for Twilio webhooks on :${port}${path}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }
    // Match path ignoring trailing slash and query string.
    const url = req.url ?? '/';
    const pathOnly = url.split('?', 1)[0] ?? '/';
    const normExpected = this.opts.path.replace(/\/+$/, '') || '/';
    const normActual = pathOnly.replace(/\/+$/, '') || '/';
    if (normActual !== normExpected) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const signature = req.headers['x-twilio-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      this.log('warn', 'rejecting request without X-Twilio-Signature header');
      res.statusCode = 403;
      res.end();
      return;
    }

    let body: string;
    try {
      body = await readBody(req, 1024 * 1024); // 1 MB ceiling
    } catch (err) {
      this.log('warn', 'body read failed', String(err));
      res.statusCode = 400;
      res.end();
      return;
    }
    const form = parseForm(body);
    const fullUrl = reconstructUrl(req, this.opts.publicUrl);

    // CRITICAL: never skip this check. `validateRequest` returns false on
    // any mismatch (URL, params, or signature). Spoofed callers without the
    // auth token cannot forge a matching signature.
    const ok = validateRequest(this.opts.authToken, signature, fullUrl, form as Record<string, string>);
    if (!ok) {
      this.log('warn', 'rejecting request with invalid Twilio signature', {
        url: fullUrl,
      });
      res.statusCode = 403;
      res.end();
      return;
    }

    let event: InboundEvent;
    try {
      event = parseTwilioInbound(form);
    } catch (err) {
      this.log('warn', 'rejecting malformed Twilio payload', String(err));
      res.statusCode = 400;
      res.end();
      return;
    }

    try {
      this.opts.onEvent(event);
    } catch (err) {
      // Event sink failure shouldn't surface to Twilio as 4xx (it will retry);
      // log + 200 to suppress retries while we surface the failure to ops.
      this.log('error', 'onEvent threw', String(err));
    }

    // Empty TwiML response — we acknowledge but don't auto-reply.
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/xml');
    res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  }
}

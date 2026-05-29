// Twilio SMS/MMS trigger plugin for Animus.
//
// Plugin kind: `trigger_backend`. Speaks the Animus STDIO JSON-RPC protocol on
// stdin/stdout and exposes:
//
//   - `trigger/watch`  — host registers a trigger config; plugin starts an
//                        HTTP server on TWILIO_WEBHOOK_PORT to receive
//                        Twilio's inbound SMS webhooks and emits a
//                        `trigger/event` notification per validated message.
//   - `trigger/schema` — declares SMS/MMS event kinds and ack support.
//   - `trigger/ack`    — host acks a delivered event (no-op for HTTP webhook
//                        triggers; we already 200'd Twilio).
//   - `sms/send`       — outbound SMS via Twilio REST API.
//   - `sms/send_mms`   — outbound MMS via Twilio REST API.
//   - `health/check`   — reports plugin + Twilio client status.
//
// NOTE: the TS SDK 0.1.0 has `trigger_backend` defined in `roles.ts` but
// `definePlugin` rejects every non-`subject_backend` kind. We therefore drive
// the JSON-RPC loop with the SDK's lower-level wire helpers
// (`createWire` + handshake builders) directly. When the SDK wires
// `trigger_backend` in a future release we can collapse this back to
// `definePlugin({ kind: 'trigger_backend', impl: ... })`.

import process from 'node:process';
import { stdout as nodeStdout } from 'node:process';
import twilio from 'twilio';
import type { Twilio } from 'twilio';

import {
  ErrorCode,
  PluginKind,
  buildInitializeResult,
  buildManifest,
  createWire,
  errorResponse,
  okResponse,
  validateInitializeParams,
  type PluginIdentity,
  type RpcRequest,
  type RpcResponse,
  type Wire,
} from '@launchapp-dev/animus-plugin-sdk';

import { sendMms, sendSms } from './outbound.js';
import { TwilioWebhookServer } from './webhook-server.js';
import type { InboundEvent } from './inbound.js';

const NAME = 'animus-trigger-sms-twilio';
const VERSION = '0.1.1';
const DESCRIPTION = 'Twilio SMS/MMS trigger plugin — HTTP webhook inbound + REST API outbound';

const IDENTITY: PluginIdentity = {
  name: NAME,
  version: VERSION,
  description: DESCRIPTION,
  plugin_kind: PluginKind.TriggerBackend,
};

const METHODS = [
  'trigger/watch',
  'trigger/schema',
  'trigger/ack',
  'sms/send',
  'sms/send_mms',
  'health/check',
];

const TRIGGER_SCHEMA = {
  kinds: ['sms.received', 'mms.received'],
  supports_resume: false,
  supports_dedup: false,
  supports_ack: true,
};

// The Animus plugin host scrubs the daemon's env before spawning a plugin and
// only forwards a short allowlist (PATH, HOME, TMPDIR, ...) plus whatever this
// manifest declares. Every var the plugin reads MUST appear here, including
// optional ones — otherwise hosted deployments cannot override defaults at
// runtime. `required: false` marks the optional ones; the host's preflight
// only enforces the truly-required vars (see crates/orchestrator-core/.../plugin_preflight).
const ENV_REQUIRED = [
  { name: 'TWILIO_ACCOUNT_SID', description: 'Twilio account SID (starts with AC)', required: true,  sensitive: false },
  { name: 'TWILIO_AUTH_TOKEN',  description: 'Twilio auth token (used for webhook signature validation and REST API auth)', required: true,  sensitive: true },
  { name: 'TWILIO_FROM_NUMBER', description: 'Default E.164 sender phone number (e.g. +15551234567)', required: true,  sensitive: false },
  { name: 'TWILIO_WEBHOOK_PORT', description: 'Local TCP port for the inbound webhook server (default 8091)', required: false, sensitive: false },
  { name: 'TWILIO_WEBHOOK_PATH', description: 'HTTP path the webhook server responds on (default /sms)', required: false, sensitive: false },
  { name: 'TWILIO_PUBLIC_URL',   description: 'Full public HTTPS URL Twilio posts to (used for signature validation under proxies; e.g. https://abc.ngrok.io/sms)', required: false, sensitive: false },
];

const CAPABILITIES = {
  methods: METHODS,
  streaming: true, // emits `trigger/event` notifications
  progress: false,
  cancellation: false,
};

// ---- shared mutable state -------------------------------------------------

interface PluginState {
  twilioClient: Twilio | null;
  webhookServer: TwilioWebhookServer | null;
  watchedTriggerIds: Set<string>;
}

const state: PluginState = {
  twilioClient: null,
  webhookServer: null,
  watchedTriggerIds: new Set(),
};

function getTwilioClient(): Twilio {
  if (state.twilioClient) return state.twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error(
      'TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must both be set to send messages',
    );
  }
  state.twilioClient = twilio(sid, token);
  return state.twilioClient;
}

function getDefaultFrom(): string {
  return process.env.TWILIO_FROM_NUMBER ?? '';
}

function emitTriggerEvent(wire: Wire, triggerId: string, event: InboundEvent): void {
  // Match `animus_plugin_protocol::TriggerEvent`:
  //   { event_id (required), trigger_id?, subject_id?, subject_kind?,
  //     action_hint?, payload }
  // The supervisor (crates/orchestrator-daemon-runtime/.../trigger_supervisor.rs)
  // parses the notification params directly via `serde_json::from_value::<TriggerEvent>`.
  wire
    .notify('trigger/event', {
      event_id: event.message_sid,
      trigger_id: triggerId,
      payload: {
        kind: event.kind,
        from: event.from,
        to: event.to,
        body: event.body,
        message_sid: event.message_sid,
        num_segments: event.num_segments,
        num_media: event.num_media,
        media_urls: event.media.map((m) => m.url),
        media: event.media,
        account_sid: event.account_sid,
        from_city: event.from_city ?? null,
        from_state: event.from_state ?? null,
        from_country: event.from_country ?? null,
        from_zip: event.from_zip ?? null,
        received_at: event.received_at,
      },
    })
    .catch((err) => {
      process.stderr.write(`[${NAME}] failed to publish trigger/event: ${String(err)}\n`);
    });
}

async function ensureWebhookServer(wire: Wire): Promise<void> {
  if (state.webhookServer) return;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    throw new Error('TWILIO_AUTH_TOKEN must be set to validate inbound Twilio webhooks');
  }
  const port = Number.parseInt(process.env.TWILIO_WEBHOOK_PORT ?? '8091', 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid TWILIO_WEBHOOK_PORT: ${process.env.TWILIO_WEBHOOK_PORT}`);
  }
  const path = process.env.TWILIO_WEBHOOK_PATH ?? '/sms';
  const publicUrl = process.env.TWILIO_PUBLIC_URL;

  const server = new TwilioWebhookServer({
    authToken,
    publicUrl,
    port,
    path,
    onEvent: (ev) => {
      // Fan out to every active trigger watcher. Multiple watches on the same
      // plugin instance are rare but supported (e.g. dev + prod both pointing
      // at the same Twilio number).
      for (const triggerId of state.watchedTriggerIds) {
        emitTriggerEvent(wire, triggerId, ev);
      }
    },
  });
  await server.start();
  state.webhookServer = server;
}

// ---- RPC dispatch ---------------------------------------------------------

async function dispatch(frame: RpcRequest, wire: Wire): Promise<RpcResponse | undefined> {
  const id = frame.id;
  const method = frame.method;

  // Notifications: never respond.
  if (id === undefined) {
    if (method === 'exit') {
      setImmediate(() => {
        // `exit` can arrive before any `trigger/watch` started the webhook
        // server. Always exit even when there's no server to stop, otherwise
        // the process hangs and the host has to SIGKILL after grace period.
        const stop = state.webhookServer ? state.webhookServer.stop() : Promise.resolve();
        stop.finally(() => process.exit(0));
      });
      return undefined;
    }
    return undefined;
  }

  switch (method) {
    case 'initialize': {
      const params = (frame.params ?? {}) as Parameters<typeof validateInitializeParams>[0];
      const incompat = validateInitializeParams(params);
      if (incompat) {
        return errorResponse(id, ErrorCode.InvalidRequest, incompat);
      }
      return okResponse(id, buildInitializeResult(IDENTITY, CAPABILITIES));
    }
    case '$/ping':
      return okResponse(id, {});
    case 'health/check': {
      const sidPresent = Boolean(process.env.TWILIO_ACCOUNT_SID);
      const tokenPresent = Boolean(process.env.TWILIO_AUTH_TOKEN);
      const fromPresent = Boolean(process.env.TWILIO_FROM_NUMBER);
      if (!sidPresent || !tokenPresent || !fromPresent) {
        return okResponse(id, {
          status: 'degraded',
          uptime_ms: null,
          memory_usage_bytes: null,
          last_error: `missing env: ${[
            sidPresent ? null : 'TWILIO_ACCOUNT_SID',
            tokenPresent ? null : 'TWILIO_AUTH_TOKEN',
            fromPresent ? null : 'TWILIO_FROM_NUMBER',
          ]
            .filter(Boolean)
            .join(', ')}`,
        });
      }
      return okResponse(id, {
        status: 'healthy',
        uptime_ms: Math.round(process.uptime() * 1000),
        memory_usage_bytes: process.memoryUsage().rss,
        last_error: null,
      });
    }
    case 'shutdown': {
      // Stop the webhook listener so we don't keep accepting (and acking)
      // Twilio POSTs after the host believes us shut down — that would race
      // the next plugin instance for the same port and result in duplicate
      // event delivery during a restart.
      if (state.webhookServer) {
        const server = state.webhookServer;
        state.webhookServer = null;
        state.watchedTriggerIds.clear();
        try {
          await server.stop();
        } catch (err) {
          process.stderr.write(`[${NAME}] shutdown: webhook stop failed: ${String(err)}\n`);
        }
      }
      return okResponse(id, {});
    }
    case 'exit':
      setImmediate(() => {
        // `exit` can arrive before any `trigger/watch` started the webhook
        // server. Always exit even when there's no server to stop, otherwise
        // the process hangs and the host has to SIGKILL after grace period.
        const stop = state.webhookServer ? state.webhookServer.stop() : Promise.resolve();
        stop.finally(() => process.exit(0));
      });
      return okResponse(id, {});
    case 'trigger/watch': {
      try {
        const params = (frame.params ?? {}) as { trigger_id?: unknown };
        const triggerId =
          typeof params.trigger_id === 'string' && params.trigger_id.length > 0
            ? params.trigger_id
            : 'twilio-sms-default';
        await ensureWebhookServer(wire);
        state.watchedTriggerIds.add(triggerId);
        return okResponse(id, {
          trigger_id: triggerId,
          status: 'watching',
          listener: {
            host: '0.0.0.0',
            port: Number.parseInt(process.env.TWILIO_WEBHOOK_PORT ?? '8091', 10),
            path: process.env.TWILIO_WEBHOOK_PATH ?? '/sms',
            public_url: process.env.TWILIO_PUBLIC_URL ?? null,
          },
        });
      } catch (err) {
        return errorResponse(id, ErrorCode.InternalError, `trigger/watch failed: ${String(err)}`);
      }
    }
    case 'trigger/schema':
      return okResponse(id, TRIGGER_SCHEMA);
    case 'trigger/ack': {
      // We already 200'd Twilio in the webhook handler. Twilio uses delivery
      // ack semantics on its end; nothing to do here.
      return okResponse(id, { acked: true });
    }
    case 'sms/send': {
      try {
        const client = getTwilioClient();
        const result = await sendSms(client, getDefaultFrom(), frame.params);
        return okResponse(id, result);
      } catch (err) {
        return errorResponse(id, ErrorCode.InternalError, `sms/send failed: ${String(err)}`);
      }
    }
    case 'sms/send_mms': {
      try {
        const client = getTwilioClient();
        const result = await sendMms(client, getDefaultFrom(), frame.params);
        return okResponse(id, result);
      } catch (err) {
        return errorResponse(id, ErrorCode.InternalError, `sms/send_mms failed: ${String(err)}`);
      }
    }
    default:
      return errorResponse(id, ErrorCode.MethodNotFound, `unknown method '${method}'`);
  }
}

// ---- bootstrap ------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const manifest = buildManifest(IDENTITY, CAPABILITIES, {
    env_required: ENV_REQUIRED,
    notification_buffer_size: 64,
    extra_capabilities: ['trigger_event:sms.received', 'trigger_event:mms.received'],
  });

  if (args.includes('--manifest') || args.includes('-m')) {
    await new Promise<void>((resolve, reject) => {
      nodeStdout.write(`${JSON.stringify(manifest)}\n`, (err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  }
  if (args.includes('--help') || args.includes('-h')) {
    process.stderr.write(
      `${NAME} ${VERSION} — Animus STDIO plugin\n` +
        'Usage:\n' +
        `  ${NAME} --manifest    Print plugin manifest as JSON and exit\n` +
        `  ${NAME}               Run JSON-RPC loop on stdin/stdout\n`,
    );
    process.exit(0);
  }

  const wire = createWire();
  await wire.run((frame) => dispatch(frame, wire));
}

// Top-level await would require ESM target tweaks for tsup bundling; a plain
// async main + .catch keeps the bundle simple.
main().catch((err) => {
  process.stderr.write(`[${NAME}] fatal: ${String(err)}\n`);
  process.exit(1);
});

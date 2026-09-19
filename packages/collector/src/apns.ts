/**
 * APNs sender (§61) — token-based (JWT ES256, .p8 key), HTTP/2, no external
 * deps: node:http2 + node:crypto. Every credential comes from the
 * environment, never from code or a committed file:
 *   TRENO_APNS_KEY_PATH  path to the .p8 private key on the server
 *   TRENO_APNS_KEY_ID    10-char key id from the Apple developer portal
 *   TRENO_APNS_TEAM_ID   team id
 *   TRENO_APNS_TOPIC     bundle id of the app (com.berry13.treno)
 * Unset env ⇒ sendApns() is a no-op returning false — notifications degrade
 * silently, the collector never depends on them.
 */
import { createSign, createPrivateKey } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import http2 from 'node:http2';
import { log } from '#core/log.ts';

interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
}

let cachedJwt: { token: string; exp: number } | null = null;

function config(): ApnsConfig | null {
  const keyPath = process.env.TRENO_APNS_KEY_PATH;
  const keyId = process.env.TRENO_APNS_KEY_ID;
  const teamId = process.env.TRENO_APNS_TEAM_ID;
  const topic = process.env.TRENO_APNS_TOPIC;
  if (!keyPath || !keyId || !teamId || !topic) return null;
  return { keyPath, keyId, teamId, topic };
}

export function apnsConfigured(): boolean {
  const c = config();
  return c != null && existsSync(c.keyPath);
}

/** Provider JWT, cached until 50 min (Apple allows up to 1 h). */
function providerJwt(c: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwt.exp - 60 > now) return cachedJwt.token;
  const header = { alg: 'ES256', kid: c.keyId };
  const payload = { iss: c.teamId, iat: now };
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = b64url(header) + '.' + b64url(payload);
  const key = createPrivateKey(readFileSync(c.keyPath));
  const der = createSign('SHA256').update(signingInput).sign(key);
  // DER → JOSE raw r||s (64 bytes)
  const raw = der.length === 64 ? der : Buffer.concat([der.subarray(4, 36)!, der.subarray(38)!]);
  const token = signingInput + '.' + raw.toString('base64url');
  cachedJwt = { token, exp: now + 3000 };
  return token;
}

/** Send one push; resolves false when unconfigured or rejected by APNs. */
export function sendApns(deviceToken: string, title: string, body: string): Promise<boolean> {
  const c = config();
  if (!c) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, err?: unknown) => {
      if (!settled) { settled = true; resolve(ok); }
      if (!ok && err) log.warn('apns: send failed', { error: String(err) });
    };
    try {
      const session = http2.connect('https://api.push.apple.com:443');
      session.on('error', (e) => done(false, e));
      const req = session.request({
        ':method': 'POST',
        ':path': '/3/device/' + encodeURIComponent(deviceToken),
        authorization: 'bearer ' + providerJwt(c),
        'apns-topic': c.topic,
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
      req.setEncoding('utf8');
      let status = 0;
      req.on('response', (headers) => { status = Number(headers[':status']); });
      req.on('data', () => { /* error payload, logged via status */ });
      req.on('end', () => {
        session.close();
        done(status === 200);
      });
      req.write(JSON.stringify({ aps: { alert: { title, body }, sound: 'default' } }));
      req.end();
      // hard timeout so a stuck session can never wedge the notifier
      setTimeout(() => { if (!settled) { settled = true; req.close(); session.close(); resolve(false); } }, 8000).unref();
    } catch (e) {
      done(false, e);
    }
  });
}

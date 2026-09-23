/**
 * APNs sender (§61) — token-based (JWT ES256, .p8 key), HTTP/2, no external
 * deps: node:http2 + node:crypto. Every credential comes from the
 * environment, never from code or a committed file:
 *   TRENO_APNS_KEY_PATH  path to the .p8 private key on the server
 *   TRENO_APNS_KEY_ID    10-char key id from the Apple developer portal
 *   TRENO_APNS_TEAM_ID   team id
 *   TRENO_APNS_TOPIC     bundle id of the app (com.marco13beretta.treno)
 *   TRENO_APNS_SANDBOX   1 = send via the sandbox host (development-signed
 *                        builds); unset/0 = production host
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
  // dsaEncoding: 'ieee-p1363' — JWS ES256 signatures are the raw r||s form
  // (64 bytes for P-256), NOT Node's default ASN.1/DER. APNs rejects DER.
  // (A previous hand-rolled DER→raw offset hack was only correct for the
  // ~25% of signatures where r and s both need no padding byte.)
  const raw = createSign('SHA256').update(signingInput).sign({ key, dsaEncoding: 'ieee-p1363' });
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
      // Development-signed builds (aps-environment=development) register SANDBOX
      // tokens: those only receive pushes sent to api.sandbox.push.apple.com.
      // TRENO_APNS_SANDBOX=1 selects it; unset/0 keeps production (App Store/
      // TestFlight/ad-hoc builds). The .p8 key itself is valid for both.
      const host = process.env.TRENO_APNS_SANDBOX === '1'
        ? 'https://api.sandbox.push.apple.com:443'
        : 'https://api.push.apple.com:443';
      const session = http2.connect(host);
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
      let body = '';
      req.on('response', (headers) => { status = Number(headers[':status']); });
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        session.close();
        if (status !== 200) log.warn('apns: rejected', { status, reason: body.slice(0, 200) });
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

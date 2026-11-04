// Limits on the agent's web_fetch tool. It runs without a prompt, and pages can
// contain instructions aimed at the model, so it must not be steerable into the
// user's own network, and a hostile server must not be able to hang or fill it.
const dns = require('dns');
const net = require('net');

function ipv4IsPrivate(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19));
}

function expandIpv6(ip) {
  let text = ip.split('%')[0].toLowerCase();
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = text.includes('::') ? 8 - left.length - right.length : 0;
  return [...left, ...Array(zeros).fill('0'), ...right].map(h => parseInt(h, 16));
}

function isPrivateAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4IsPrivate(ip);
  if (kind !== 6) return true;
  const h = expandIpv6(ip);
  const embedded = () => `${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`;
  if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) return ipv4IsPrivate(embedded());
  if (h.slice(0, 7).every(x => x === 0)) return h[7] === 0 || h[7] === 1;
  return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xff00) === 0xff00;
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa)$/i;

const defaultLookup = (host) => dns.promises.lookup(host, { all: true });

// There's a small gap between this lookup and the connection, so a hostile DNS
// server could still change its answer. Closing that needs a custom connector.
async function checkUrl(url, lookup = defaultLookup) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'not a valid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: 'only http and https URLs can be fetched' };
  const refused = { ok: false, reason: 'refused: that is a local or private network address' };
  const host = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || LOCAL_NAME.test(host)) return refused;
  if (net.isIP(host)) return isPrivateAddress(host) ? refused : { ok: true };
  let addresses;
  try { addresses = await lookup(host); }
  catch { return { ok: false, reason: `could not resolve ${host}` }; }
  if (!addresses?.length || addresses.some(a => isPrivateAddress(a.address))) return refused;
  return { ok: true };
}

async function readCapped(res, maxBytes, controller) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };
    received += value.length;
    text += decoder.decode(value, { stream: true });
    if (received >= maxBytes) {
      controller.abort();
      return { text, truncated: true };
    }
  }
}

async function safeFetchText(url, opts = {}) {
  const {
    fetchImpl = fetch,
    lookup = defaultLookup,
    headers = {},
    timeoutMs = 15000,
    maxBytes = 2 * 1024 * 1024,
    maxRedirects = 5
  } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let finished = false;
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const check = await checkUrl(current, lookup);
      if (!check.ok) return { error: check.reason };
      const res = await fetchImpl(current, { headers, redirect: 'manual', signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).href;
        continue;
      }
      if (!res.ok) return { error: `fetch ${res.status}` };
      const { text, truncated } = await readCapped(res, maxBytes, controller);
      finished = true;
      return { url: current, text, truncated, contentType: res.headers.get('content-type') || '' };
    }
    return { error: `too many redirects (more than ${maxRedirects})` };
  } catch (e) {
    if (!finished && controller.signal.aborted) return { error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    return { error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isPrivateAddress, checkUrl, safeFetchText };

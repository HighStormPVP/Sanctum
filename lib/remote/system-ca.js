// The root certificates a Mac's system keychain holds, for the relay connection.
//
// Electron's Node checks certificates against its own built-in list, not the Mac's Keychain.
// A school's or company's filter that re-signs secure traffic (Zscaler, for one) has its root
// installed in the system keychain by the device's management, so Safari accepts the re-signed
// certificate and Node refuses it. Adding those roots to the built-in list lets the relay
// connection through the filter, exactly as a browser's traffic goes. The chats inside stay
// end-to-end encrypted either way.
//
// Only /Library/Keychains/System.keychain, which only an administrator or the device's
// management can change; never the login keychain, where any program running as the user can
// add a certificate without asking. And only what can be a root: a CA certificate that signed
// itself and hasn't expired. Stray leaves, intermediates and old cross-signs are left out, so
// one of them can't be picked over a good root.
const crypto = require('node:crypto');
const tls = require('node:tls');
const { execFile } = require('node:child_process');

const MAC_SYSTEM_KEYCHAIN = '/Library/Keychains/System.keychain';
const SECURITY = '/usr/bin/security';

const PEM = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;

function pemBlocks(text) {
  return (String(text || '').match(PEM) || []).map((block) => block.replace(/\r\n/g, '\n').trim());
}

// The blocks that can stand as a root, at `now`.
function trustAnchors(blocks, now = Date.now()) {
  return blocks.filter((pem) => {
    try {
      const cert = new crypto.X509Certificate(pem);
      return cert.ca === true && cert.checkIssued(cert) && Date.parse(cert.validTo) > now;
    } catch {
      return false; // unreadable, so it can't be a root
    }
  });
}

function runSecurity(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// { list, complete }. `list` is null off a Mac, or when the system keychain has no root of its
// own, so the built-in list is used unchanged; otherwise the built-in list with those roots
// added, each once. `complete` is false when the keychain couldn't be read, so the answer
// shouldn't be kept.
async function systemCertificates({ platform = process.platform, run = runSecurity, now = Date.now() } = {}) {
  if (platform !== 'darwin') return { list: null, complete: true };
  let text;
  try {
    text = await run(SECURITY, ['find-certificate', '-a', '-p', MAC_SYSTEM_KEYCHAIN]);
  } catch {
    return { list: null, complete: false };
  }
  const builtIn = new Set(tls.rootCertificates);
  const added = trustAnchors(pemBlocks(text), now).filter((pem) => !builtIn.has(pem));
  if (!added.length) return { list: null, complete: true };
  return { list: [...tls.rootCertificates, ...new Set(added)], complete: true };
}

module.exports = { systemCertificates, pemBlocks, trustAnchors, MAC_SYSTEM_KEYCHAIN };

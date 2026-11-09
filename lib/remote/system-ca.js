// The certificates a Mac trusts, for the relay connection.
//
// Electron's Node checks certificates against its own built-in list, not the Mac's Keychain.
// A school's or company's filter that re-signs secure traffic (Zscaler, for one) installs its
// authority in the Keychain, so Safari accepts the re-signed certificate and Node refuses it.
// Reading the Keychain's certificates and adding them to the built-in list makes the relay
// connection trust what the Mac trusts, and no more: the traffic still goes through the
// filter, exactly as a browser's does. The chats inside stay end-to-end encrypted either way.
//
// The system's own keychains are writable only by an administrator or the device's
// management; the login keychain holds what this user chose to add.
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');

const MAC_KEYCHAINS = [
  '/System/Library/Keychains/SystemRootCertificates.keychain',
  '/Library/Keychains/System.keychain'
];
const SECURITY = '/usr/bin/security';

const PEM = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?-----END CERTIFICATE-----/g;

function pemBlocks(text) {
  return (String(text || '').match(PEM) || []).map((block) => block.replace(/\r\n/g, '\n').trim());
}

function runSecurity(file, args) {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// null off a Mac, or when the Keychain gave nothing, so the built-in list is used unchanged.
// Otherwise the built-in list with the Keychain's certificates added, each once.
function systemCertificates({ platform = process.platform, run = runSecurity, home = process.env.HOME || '' } = {}) {
  if (platform !== 'darwin') return null;
  const keychains = [...MAC_KEYCHAINS];
  if (home) keychains.push(path.posix.join(home, 'Library/Keychains/login.keychain-db'));
  const found = [];
  for (const keychain of keychains) {
    try {
      found.push(...pemBlocks(run(SECURITY, ['find-certificate', '-a', '-p', keychain])));
    } catch {
      // A keychain that isn't there, or can't be read, adds nothing.
    }
  }
  if (!found.length) return null;
  return [...new Set([...tls.rootCertificates, ...found])];
}

module.exports = { systemCertificates, pemBlocks, MAC_KEYCHAINS };

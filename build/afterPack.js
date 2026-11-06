const { execSync } = require('child_process');
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

// Switched off in every build, on every platform. The owner's PC has ELECTRON_RUN_AS_NODE=1 set for
// the whole machine, and with RunAsNode on an installed Sanctum would start as plain Node. The other
// two would let NODE_OPTIONS or --inspect attach a debugger, which reaches the keys and the chats.
// Nothing in Sanctum runs itself as Node. main.js refuses Chromium's own debug switches.
const FUSES = {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false
};

function appBinary(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${name}.exe`);
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') return path.join(appOutDir, `${name}.app`);
  return path.join(appOutDir, packager.executableName);
}

exports.FUSES = FUSES;

exports.default = async function (context) {
  // Before signing, since flipping changes the binary.
  const binary = appBinary(context);
  console.log(`afterPack: switching off run-as-node, NODE_OPTIONS and inspect in ${binary}`);
  await flipFuses(binary, FUSES);

  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  console.log(`afterPack: ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
  console.log('afterPack: ad-hoc signing verified');
};

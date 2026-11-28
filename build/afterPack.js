const fs = require('fs')
const path = require('path')

/**
 * Auto-update integrity guard.
 *
 * Previously this hook *removed* `publisherName` from app-update.yml, which
 * disables electron-updater's publisher verification. That made the unsigned
 * update chain silently executable by anyone who could publish a release.
 * Verification must stay enabled; this hook now only warns when a manifest is
 * missing publisher information so an unsigned build cannot look shippable.
 */
async function verifyUpdateManifest(context) {
  const file = path.join(context.appOutDir, 'resources', 'app-update.yml')
  if (!fs.existsSync(file)) return
  const manifest = fs.readFileSync(file, 'utf8')
  if (!/^publisherName\s*:/m.test(manifest)) {
    console.warn(
      '[afterPack] app-update.yml has no publisherName: auto-update publisher verification is disabled. ' +
        'Sign the installer (set CSC_LINK / CSC_KEY_PASSWORD) before shipping this build.'
    )
  }
}

module.exports = verifyUpdateManifest
module.exports.default = verifyUpdateManifest

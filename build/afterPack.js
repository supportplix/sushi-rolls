const fs = require('fs')
const path = require('path')

async function removePublisherRequirement(context) {
  const file = path.join(context.appOutDir, 'resources', 'app-update.yml')
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const out = []
  let skipping = false
  for (const line of lines) {
    if (/^publisherName\s*:/.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^\s*-\s+/.test(line)) continue
    skipping = false
    out.push(line)
  }
  fs.writeFileSync(file, out.join('\n'), 'utf8')
}

module.exports = removePublisherRequirement
module.exports.default = removePublisherRequirement

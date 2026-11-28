// Guard against the DB-01 / OPS-14 failure mode: schema.sql being treated as
// the whole installation while versioned migrations are never applied.
// Runs locally and in CI; read-only, no database access.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const errors = []

const read = (relative) => {
  try {
    return readFileSync(join(root, relative), 'utf8')
  } catch {
    errors.push(`missing or unreadable: ${relative}`)
    return ''
  }
}

const schema = read('supabase/schema.sql')
const readme = read('README.md')

if (schema) {
  const head = schema.split(/\r?\n/).slice(0, 30).join('\n').toLowerCase()
  if (!head.includes('migration')) {
    errors.push('supabase/schema.sql header must state that migrations must be applied after it')
  }
}

if (readme) {
  const lower = readme.toLowerCase()
  if (!lower.includes('migration') && !lower.includes('db push')) {
    errors.push('README.md must document applying supabase/migrations after schema.sql')
  }
}

let migrations = []
try {
  migrations = readdirSync(join(root, 'supabase', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()
} catch {
  errors.push('cannot list supabase/migrations')
}

if (migrations.length === 0) {
  errors.push('no SQL migrations found in supabase/migrations')
} else {
  const versions = migrations.map((name) => name.slice(0, 14))
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i)
  if (duplicates.length) errors.push(`duplicate migration version prefix(es): ${[...new Set(duplicates)].join(', ')}`)
  console.log(`Migration inventory (${migrations.length}):`)
  for (const name of migrations) console.log(`  - ${name}`)
}

if (errors.length) {
  console.error('\nMigration inventory check FAILED:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log('\nMigration inventory check OK.')

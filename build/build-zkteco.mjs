import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const source = join(root, 'zkteco-bridge')
const sdk = join(root, 'vendor', 'zkteco', 'sdk')
const target = join(root, 'resources', 'zkteco')
const exe = join(source, 'bin', 'ZkTecoBridge.exe')

if (!existsSync(exe)) throw new Error('ZkTecoBridge.exe is missing; run npm run build:zkteco first')
if (!existsSync(sdk)) throw new Error('ZKTeco SDK files are missing')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(exe, join(target, 'ZkTecoBridge.exe'))
for (const file of readdirSync(sdk)) {
  if (file.toLowerCase().endsWith('.dll')) cpSync(join(sdk, file), join(target, file))
}
cpSync(join(source, 'install-service.ps1'), join(target, 'install-service.ps1'))
cpSync(join(source, 'install-logon-agent.ps1'), join(target, 'install-logon-agent.ps1'))
cpSync(join(root, 'vendor', 'zkteco', 'driver-setup-5.0.0.12.exe'), join(target, 'driver-setup-5.0.0.12.exe'))

console.log('ZKTeco runtime staged in resources/zkteco')

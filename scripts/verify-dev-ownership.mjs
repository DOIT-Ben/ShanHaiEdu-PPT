import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.getuid?.() !== 0) {
  throw new Error('DEV_OWNERSHIP_VERIFICATION_REQUIRES_ROOT')
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`DEV_OWNERSHIP_VERIFICATION_FAILED:${label}`)
  }
}

for (const command of [
  ['ownership', '/usr/local/bin/bun', ['run', 'check:ownership']],
  ['git-status', '/usr/bin/git', ['status', '--short']],
  ['tests', '/usr/local/bin/bun', ['run', 'test']],
  ['typecheck', '/usr/local/bin/bun', ['run', 'typecheck']],
  ['build', '/usr/local/bin/bun', ['run', 'build']],
]) {
  run(`root-${command[0]}`, command[1], command[2])
}

for (const command of [
  ['ownership', '/usr/sbin/runuser', ['-u', 'codex-dev', '--', '/usr/local/bin/bun', 'run', 'check:ownership']],
  ['git-status', '/usr/sbin/runuser', ['-u', 'codex-dev', '--', '/usr/bin/git', 'status', '--short']],
  ['tests', '/usr/sbin/runuser', ['-u', 'codex-dev', '--', '/usr/local/bin/bun', 'run', 'test']],
  ['typecheck', '/usr/sbin/runuser', ['-u', 'codex-dev', '--', '/usr/local/bin/bun', 'run', 'typecheck']],
  ['build', '/usr/sbin/runuser', ['-u', 'codex-dev', '--', '/usr/local/bin/bun', 'run', 'build']],
]) {
  run(`codex-dev-${command[0]}`, command[1], command[2])
}

console.log('DEV_OWNERSHIP_DUAL_IDENTITY_OK')

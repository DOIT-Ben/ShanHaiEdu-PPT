import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const coreRoot = path.resolve(import.meta.dir, '../src/core')
const forbidden = [
  /from\s+['"](?:next|@prisma\/client|react|@assistant-ui)/,
  /from\s+['"][^'"]*(?:frameflow|shanhaiedu)/i,
  /require\(['"](?:next|@prisma\/client|react|@assistant-ui)/,
]
const presentationJobV2Files = [
  path.resolve(import.meta.dir, '../src/presentation-job-v2-contracts.ts'),
  path.resolve(import.meta.dir, '../src/core/presentation-job-v2-ports.ts'),
  path.resolve(import.meta.dir, '../src/core/presentation-job-v2-service.ts'),
  path.resolve(import.meta.dir, '../src/http/presentation-job-v2-handler.ts'),
]
const presentationJobV2Forbidden = [
  /frameflow/i,
  /reserveCredits|settleCredits|releaseCredits|finalizeCredits/,
  /credit|price|cookie|session/i,
  /generationPlan|blueprint|nextAttemptAt|leaseToken|providerAlias|budgetUnits|maxRevisionRounds/,
]

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(target) : Promise.resolve(target.endsWith('.ts') ? [target] : [])
  }))
  return nested.flat()
}

const violations: string[] = []
for (const file of await sourceFiles(coreRoot)) {
  const source = await readFile(file, 'utf8')
  if (forbidden.some((pattern) => pattern.test(source))) violations.push(path.relative(process.cwd(), file))
}

for (const file of presentationJobV2Files) {
  const source = await readFile(file, 'utf8')
  if (presentationJobV2Forbidden.some((pattern) => pattern.test(source))) {
    violations.push(path.relative(process.cwd(), file))
  }
}

if (violations.length > 0) {
  console.error(`Core boundary violations:\n${violations.join('\n')}`)
  process.exit(1)
}

console.log(`Core boundary check passed (${(await sourceFiles(coreRoot)).length} files)`)

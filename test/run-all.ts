/**
 * Master test runner — runs all correctness test suites sequentially.
 *
 * Usage:
 *   bun run test/run-all.ts
 *   URL=http://localhost:7003 ADMIN_KEY=test-admin-key bun run test/run-all.ts
 *
 * Expects a running ezbase instance (test docker-compose or dev stack).
 */

const URL = process.env.URL || 'http://localhost:7003'

const suites = [
  { name: 'smoke', file: 'smoke.ts' },
  { name: 'qa', file: 'qa.ts' },
  { name: 'auth', file: 'auth.ts' },
  { name: 'backups', file: 'backups.ts' },
  { name: 'backup-roundtrip', file: 'backup-roundtrip.ts' },
]

async function waitForHealthy(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${URL}/api/health`)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.error('Server never became healthy')
  process.exit(1)
}

async function main() {
  console.log(`Waiting for ${URL} to be healthy...`)
  await waitForHealthy()
  console.log('Server is healthy.\n')

  const results: { name: string; ok: boolean; duration: number }[] = []

  for (const suite of suites) {
    const label = `[${suite.name}]`
    console.log(`${'='.repeat(60)}`)
    console.log(`${label} Running ${suite.file}...`)
    console.log(`${'='.repeat(60)}`)

    const start = Date.now()
    const proc = Bun.spawn(['bun', 'run', `test/${suite.file}`], {
      cwd: process.cwd().replace(/\/test$/, ''),
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, URL },
    })
    const exitCode = await proc.exited
    const duration = ((Date.now() - start) / 1000).toFixed(1)

    const ok = exitCode === 0
    results.push({ name: suite.name, ok, duration: parseFloat(duration) })
    console.log(`\n${label} ${ok ? 'PASSED' : 'FAILED'} (${duration}s)\n`)
  }

  console.log('='.repeat(60))
  console.log('RESULTS')
  console.log('='.repeat(60))
  for (const r of results) {
    console.log(`  ${r.ok ? '\u2713' : '\u2717'} ${r.name} (${r.duration}s)`)
  }

  const allPassed = results.every((r) => r.ok)
  console.log(`\n${allPassed ? 'ALL SUITES PASSED' : 'SOME SUITES FAILED'}`)
  process.exit(allPassed ? 0 : 1)
}

main()

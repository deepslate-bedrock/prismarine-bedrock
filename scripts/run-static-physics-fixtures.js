'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { isMainThread, parentPort, workerData, Worker } = require('worker_threads')

const ROOT = path.resolve(__dirname, '..')
const GENERATED_FIXTURE_DIR = path.join(ROOT, 'test', 'static', 'physics', '1.26.10')
const REQUIRES_SEED_REFINE = new Set([
  'climb_scaffolding_up',
  'fall_into_cobweb',
  'jump_in_cobweb',
  'no_leather_powder_snow',
  'walk_into_cobweb'
])

function formatDuration (ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

function listTestFiles (dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(entry => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) return listTestFiles(fullPath)
      return entry.isFile() && entry.name.endsWith('.test.js') ? [fullPath] : []
    })
    .sort()
}

function splitFiles (files, jobs) {
  const chunks = Array.from({ length: jobs }, () => [])
  for (let i = 0; i < files.length; i++) chunks[i % jobs].push(files[i])
  return chunks.filter(chunk => chunk.length > 0)
}

function errorToObject (error) {
  return {
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : String(error)
  }
}

function patchPhysicsHelpersForStaticFixtures () {
  const helperPath = path.join(ROOT, 'test', 'static', 'physics', '_helpers.js')
  const helpers = require(helperPath)
  const makeHarness = helpers.makeHarness

  helpers.makeHarness = opts => {
    const scenario = opts && opts.scenario
    return makeHarness({
      ...opts,
      _suppressFwdRefine: !REQUIRES_SEED_REFINE.has(scenario)
    })
  }
}

async function runFileInWorker (file) {
  const state = {
    suites: [],
    tests: 0,
    pending: [],
    failures: []
  }

  const makeContext = () => ({ timeout () {} })

  global.describe = (name, fn) => {
    state.suites.push(name)
    try {
      fn.call(makeContext())
    } catch (error) {
      state.failures.push({ file, name, error: errorToObject(error) })
    } finally {
      state.suites.pop()
    }
  }

  global.it = (name, fn) => {
    state.tests++
    const fullName = [...state.suites, name].join(' > ')
    try {
      const result = fn.call(makeContext())
      if (result && typeof result.then === 'function') {
        state.pending.push(Promise.resolve(result).catch(error => {
          state.failures.push({ file, name: fullName, error: errorToObject(error) })
        }))
      }
    } catch (error) {
      state.failures.push({ file, name: fullName, error: errorToObject(error) })
    }
  }

  global.before = fn => fn.call(makeContext())
  global.after = fn => fn.call(makeContext())
  global.beforeEach = fn => fn.call(makeContext())
  global.afterEach = fn => fn.call(makeContext())

  global.describe.skip = () => {}
  global.describe.only = global.describe
  global.it.skip = () => {}
  global.it.only = global.it

  try {
    require(file)
  } catch (error) {
    state.failures.push({ file, name: path.basename(file), error: errorToObject(error) })
  }

  await Promise.all(state.pending)
  return { tests: state.tests, failures: state.failures }
}

async function runWorker () {
  patchPhysicsHelpersForStaticFixtures()

  let tests = 0
  const failures = []
  const start = Date.now()

  for (const file of workerData.files) {
    const result = await runFileInWorker(file)
    tests += result.tests
    failures.push(...result.failures)
  }

  parentPort.postMessage({
    files: workerData.files.length,
    tests,
    failures,
    durationMs: Date.now() - start
  })
}

function runChunk (files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { root: ROOT, files }
    })

    worker.once('message', resolve)
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`static physics worker exited with code ${code}`))
    })
  })
}

async function runMain () {
  process.chdir(ROOT)

  const files = listTestFiles(GENERATED_FIXTURE_DIR)
  const requestedJobs = Number(process.env.STATIC_PHYSICS_JOBS)
  const defaultJobs = Math.max(1, os.cpus().length - 1)
  const jobs = Math.max(1, Math.min(files.length, Number.isFinite(requestedJobs) && requestedJobs > 0 ? requestedJobs : defaultJobs))
  const chunks = splitFiles(files, jobs)
  const start = Date.now()

  console.log(`static physics fixtures: ${files.length} files across ${chunks.length} workers`)

  const results = await Promise.all(chunks.map(runChunk))
  const tests = results.reduce((total, result) => total + result.tests, 0)
  const failures = results.flatMap(result => result.failures)
  const duration = formatDuration(Date.now() - start)

  if (failures.length > 0) {
    console.error(`static physics fixtures: ${failures.length} failing, ${tests - failures.length} passing (${duration})`)
    for (const failure of failures) {
      console.error(`\n${path.relative(ROOT, failure.file)} - ${failure.name}`)
      console.error(failure.error.stack)
    }
    process.exitCode = 1
    return
  }

  console.log(`static physics fixtures: ${tests} passing (${duration})`)
}

if (isMainThread) {
  runMain().catch(error => {
    console.error(error.stack || error)
    process.exitCode = 1
  })
} else {
  runWorker().catch(error => {
    parentPort.postMessage({
      files: workerData.files.length,
      tests: 0,
      failures: [{ file: workerData.files[0] || __filename, name: 'worker', error: errorToObject(error) }],
      durationMs: 0
    })
  })
}

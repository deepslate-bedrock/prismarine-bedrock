'use strict'

const path = require('path')
const { spawn } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const mochaBin = require.resolve('mocha/bin/mocha.js')
const physicsRunner = path.join(__dirname, 'run-static-physics-fixtures.js')

function prefixStream (stream, prefix, write) {
  let pending = ''

  stream.on('data', chunk => {
    pending += chunk.toString()
    const lines = pending.split(/\r?\n/)
    pending = lines.pop()
    for (const line of lines) {
      if (line.length > 0) write(`${prefix} ${line}\n`)
      else write('\n')
    }
  })

  stream.on('end', () => {
    if (pending.length > 0) write(`${prefix} ${pending}\n`)
  })
}

function runCommand (label, command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    prefixStream(child.stdout, `[${label}]`, chunk => process.stdout.write(chunk))
    prefixStream(child.stderr, `[${label}]`, chunk => process.stderr.write(chunk))

    child.on('error', error => {
      process.stderr.write(`[${label}] ${error.stack || error}\n`)
      resolve(1)
    })

    child.on('close', code => resolve(code || 0))
  })
}

async function main () {
  const jobs = [
    runCommand('static', process.execPath, [
      mochaBin,
      '--parallel',
      '--ignore',
      'test/static/physics/1.26.10/**/*.test.js',
      'test/static/**/*.test.js'
    ]),
    runCommand('physics', process.execPath, [physicsRunner])
  ]

  const codes = await Promise.all(jobs)
  process.exitCode = codes.find(code => code !== 0) || 0
}

main().catch(error => {
  console.error(error.stack || error)
  process.exitCode = 1
})

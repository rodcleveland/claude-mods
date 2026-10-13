#!/usr/bin/env node
// YouTube TV's player window: a page on 127.0.0.1 holding YouTube's own embedded player, and a
// small hub between that page and Rods Rack. Rods Rack starts this program, sends the page
// commands with POST /command, and reads what the page reports from this program's output, one
// JSON object a line. Every request carries the token Rods Rack gave it in TV_TOKEN.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TOKEN = process.env.TV_TOKEN ?? ''
// Rods Rack pings while the TV is on; with no word from it for this long, the program ends.
const IDLE_MS = Number(process.env.TV_IDLE_MS ?? 120_000)
const KEEPALIVE_MS = 20_000
const MAX_BODY = 64 * 1024

if (!/^[0-9a-f]{32}$/.test(TOKEN)) {
  process.stderr.write('TV_TOKEN must be 32 hex characters\n')
  process.exit(2)
}

const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tv-page.html'), 'utf8')
const windows = new Set()
let lastWord = Date.now()
// What a window that opens later should pick up: the last thing played and the volume.
let latestPlay = null
let latestVolume = null

const say = message => process.stdout.write(`${JSON.stringify(message)}\n`)

function send(response, status, type, body) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', chunk => {
      body += chunk
      if (body.length > MAX_BODY) reject(new Error('too big'))
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

function broadcast(command) {
  const line = `data: ${JSON.stringify(command)}\n\n`
  for (const w of windows) w.write(line)
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  // Only this machine's own address, by name too, so no other site can reach it through DNS.
  const host = request.headers.host ?? ''
  if (host !== `127.0.0.1:${server.address().port}` || url.searchParams.get('t') !== TOKEN) {
    return send(response, 403, 'text/plain', 'Forbidden')
  }

  try {
    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, 'text/html; charset=utf-8', page.replaceAll('__TV_TOKEN__', TOKEN))
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      response.write(': hello\n\n')
      if (latestVolume !== null) response.write(`data: ${JSON.stringify(latestVolume)}\n\n`)
      if (latestPlay !== null) response.write(`data: ${JSON.stringify(latestPlay)}\n\n`)
      windows.add(response)
      say({ type: 'windows', count: windows.size })
      request.on('close', () => {
        windows.delete(response)
        say({ type: 'windows', count: windows.size })
      })
      return
    }

    if (request.method === 'POST' && url.pathname === '/command') {
      lastWord = Date.now()
      const command = JSON.parse(await readBody(request))
      if (command.op === 'play') latestPlay = command
      if (command.op === 'volume') latestVolume = command
      if (command.op === 'off') latestPlay = null
      broadcast(command)
      return send(response, 200, 'application/json', JSON.stringify({ windows: windows.size }))
    }

    if (request.method === 'POST' && url.pathname === '/ping') {
      lastWord = Date.now()
      return send(response, 200, 'application/json', JSON.stringify({ windows: windows.size }))
    }

    if (request.method === 'POST' && url.pathname === '/state') {
      const state = JSON.parse(await readBody(request))
      say({ ...state, type: 'state' })
      return send(response, 204, 'text/plain', '')
    }

    return send(response, 404, 'text/plain', 'Not found')
  } catch {
    return send(response, 400, 'text/plain', 'Bad request')
  }
})

server.listen(0, '127.0.0.1', () => say({ type: 'listening', port: server.address().port }))

setInterval(() => {
  for (const w of windows) w.write(': keepalive\n\n')
  if (Date.now() - lastWord > IDLE_MS) {
    broadcast({ op: 'off' })
    process.exit(0)
  }
}, KEEPALIVE_MS).unref()

// Ends with the session either way: Rods Rack's going closes these pipes.
process.stdout.on('error', () => process.exit(0))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => process.exit(0))

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { loadConfig } = require('./config')

const cfg = loadConfig()
const args = process.argv.slice(2)
if (args.includes('--nuke')) cfg.nuke.enabled = true
if (args.includes('--no-nuke')) cfg.nuke.enabled = false
if (args.includes('--debug')) cfg.debug = true
const targetArg = args.find(a => !a.startsWith('--'))
if (targetArg) cfg.target = targetArg
if (!cfg.target) { console.log('usage: node orbit.js <PlayerName> [--nuke] [--debug]  (or set "target" in config.json)'); process.exit(1) }

const TARGET = cfg.target
const PERIOD_MS = cfg.lapSeconds * 1000
// Per-tick movement caps, kept below vanilla creative flight speed.
const MAX_H_STEP = 0.4
const MAX_V_STEP = 0.3

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-'))
const sha1 = s => crypto.createHash('sha1').update(s, 'binary').digest('hex').substr(0, 6)
const debug = (...m) => { if (cfg.debug) console.log(...m) }
const excluded = uuid => cfg.excludeUuidPrefixes.some(p => uuid.replace(/-/g, '').startsWith(p))

// Collect accounts from prismarine-auth caches (renewable) and optional raw token caches.
function discoverBots () {
  const found = new Map()
  for (const dir of [cfg.authCacheDir, ...cfg.extraAuthDirs]) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^([0-9a-f]{6})_mca-cache\.json$/)
      if (!m) continue
      try {
        const mca = JSON.parse(fs.readFileSync(path.join(dir, f))).mca
        if (!mca || !mca.access_token) continue
        const uuid = JSON.parse(Buffer.from(mca.access_token.split('.')[1], 'base64url')).profiles.mc.replace(/-/g, '')
        if (!uuid || excluded(uuid)) continue
        const fresh = mca.obtainedOn || 0
        const prev = found.get(uuid)
        if (!prev || fresh > prev.fresh) found.set(uuid, { kind: 'prismarine', dir, H: m[1], uuid, fresh })
      } catch (e) { console.log(`skip ${dir}/${f}: ${e.message}`) }
    }
  }
  const now = Date.now() / 1000
  for (const dir of cfg.tokenCacheDirs) {
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!/^auth-cache.*\.json$/.test(f)) continue
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f)))
        if (!c.uuid || !c.mc_access_token || excluded(c.uuid) || found.has(c.uuid)) continue
        if (!(c.mc_expires_at > now + 300)) { console.log(`skip ${c.name}: token expired`); continue }
        found.set(c.uuid, { kind: 'token', uuid: c.uuid, name: c.name, token: c.mc_access_token, expires: c.mc_expires_at })
      } catch (e) { console.log(`skip ${dir}/${f}: ${e.message}`) }
    }
  }
  return [...found.values()]
}

const BOTS = discoverBots()
if (!BOTS.length) { console.log(`No accounts found. Run: node login.js <AccountName>`); process.exit(1) }
console.log(`Using ${BOTS.length} accounts: ` + BOTS.map(b => b.kind === 'token'
  ? `${b.name}(token until ${new Date(b.expires * 1000).toLocaleTimeString()})`
  : b.uuid.slice(0, 8)).join(', '))

process.on('uncaughtException', e => console.log('uncaught: ' + e.message))
process.on('unhandledRejection', e => console.log('unhandledRejection: ' + ((e && e.message) || e)))

// Copy an account's cache into the temp profiles folder under a unique name.
function stage (dir, H) {
  const user = 'acct_' + H + '_' + sha1(dir)
  const nh = sha1(user)
  for (const t of ['live', 'xbl', 'mca']) {
    const s = path.join(dir, `${H}_${t}-cache.json`)
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(TMP, `${nh}_${t}-cache.json`))
  }
  return user
}

// Does a player hitbox with feet at p overlap any solid block?
function collides (bot, p) {
  const EPS = 1e-4
  const x0 = p.x - 0.3 + EPS; const x1 = p.x + 0.3 - EPS
  const y0 = p.y + EPS; const y1 = p.y + 1.8 - EPS
  const z0 = p.z - 0.3 + EPS; const z1 = p.z + 0.3 - EPS
  for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) {
    for (let by = Math.floor(y0) - 1; by <= Math.floor(y1); by++) {
      for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
        const b = bot.blockAt(new Vec3(bx, by, bz))
        if (!b) return true
        for (const sh of (b.shapes || [])) {
          if (x0 < bx + sh[3] && x1 > bx + sh[0] && y0 < by + sh[4] && y1 > by + sh[1] && z0 < bz + sh[5] && z1 > bz + sh[2]) return true
        }
      }
    }
  }
  return false
}

const clamp = (v, m) => Math.max(-m, Math.min(m, v))

// Move one speed-capped step toward `want` without entering blocks.
function glideStep (bot, want) {
  const cur = bot.entity.position
  let dx = want.x - cur.x
  let dz = want.z - cur.z
  const h = Math.hypot(dx, dz)
  if (h > MAX_H_STEP) { dx *= MAX_H_STEP / h; dz *= MAX_H_STEP / h }
  const dy = clamp(want.y - cur.y, MAX_V_STEP)
  const tries = [cur.offset(dx, dy, dz), cur.offset(0, MAX_V_STEP, 0), cur.offset(dx, 0, dz)]
  for (const c of tries) {
    if (c.equals(cur)) continue
    if (!collides(bot, c)) { bot.entity.position.set(c.x, c.y, c.z); return true }
  }
  return false
}

const safeChat = (bot, msg) => { try { bot.chat(msg) } catch (e) { console.log('chat failed: ' + e.message) } }
const targetPos = bot => {
  const p = bot.players[TARGET] && bot.players[TARGET].entity
  return (p && p.position) ? p.position : null
}

// Auth handler for a pre-issued Minecraft access token.
const tokenAuth = acct => (client, options) => {
  const profile = { id: acct.uuid, name: acct.name }
  client.session = { accessToken: acct.token, selectedProfile: profile, availableProfile: [profile] }
  client.username = acct.name
  options.haveCredentials = true
  options.accessToken = acct.token
  client.emit('session', client.session)
  options.connect(client)
}

function makeBot (acct, tag, phase) {
  const opts = { host: cfg.host, port: cfg.port, hideErrors: true }
  if (acct.kind === 'token') {
    Object.assign(opts, { username: acct.name, auth: tokenAuth(acct), disableChatSigning: true })
  } else {
    Object.assign(opts, {
      username: stage(acct.dir, acct.H),
      auth: 'microsoft',
      profilesFolder: TMP,
      onMsaCode: () => console.log(`[${tag}] needs interactive login - skipping (run: node login.js <name>)`)
    })
  }
  const bot = mineflayer.createBot(opts)
  bot._announced = false
  bot._alive = true
  bot._rb = 0

  bot.on('login', () => console.log(`[${tag}] logged in as ${bot.username}`))
  bot.on('kicked', r => console.log(`[${tag}] kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`))
  bot.on('error', e => console.log(`[${tag}] error: ${e.message}`))
  bot.on('end', r => {
    console.log(`[${tag}] disconnected: ${r}`)
    bot._alive = false
    stopTimers(bot)
  })
  bot.once('login', () => {
    if (bot.username.toLowerCase() === TARGET.toLowerCase()) {
      console.log(`[${tag}] is ${TARGET} itself - quitting`)
      bot.quit()
    }
  })

  // Accept teleport requests from the target or our own bots.
  bot.on('messagestr', m => {
    const r = m.match(/^(\S+) has requested (to teleport to you|that you teleport to them)/i)
    if (!r) return
    const from = r[1].toLowerCase()
    const trusted = from === TARGET.toLowerCase() || bots.some(b => b.username && b.username.toLowerCase() === from)
    if (!trusted) { console.log(`[${tag}] ignoring teleport request from ${r[1]}`); return }
    setTimeout(() => { console.log(`[${tag}] /tpaccept ${r[1]}`); safeChat(bot, '/tpaccept') }, 400)
  })
  bot.on('messagestr', (m, pos) => { if (pos !== 'game_info') debug(`chat [${tag}] ${m}`) })

  bot._client.on('position', pk => {
    bot._rb++
    debug(`[${tag}] server set position -> ${(+pk.x).toFixed(1)},${(+pk.y).toFixed(1)},${(+pk.z).toFixed(1)}`)
  })

  // mineflayer's startFlying() is client-side only; tell the server we're flying too.
  const sendFlying = () => {
    try { bot._client.write('abilities', { flags: 2, flyingSpeed: 0.05, walkingSpeed: 0.1 }) } catch (e) { console.log(`[${tag}] abilities write failed: ${e.message}`) }
  }
  bot._client.on('abilities', a => {
    debug(`[${tag}] abilities allowFly=${!!(a.flags & 4)} flying=${!!(a.flags & 2)}`)
    if ((a.flags & 4) && !(a.flags & 2)) setTimeout(sendFlying, 100)
  })

  bot.once('spawn', () => {
    console.log(`[${tag}] spawned as ${bot.username}, gameMode=${bot.game && bot.game.gameMode}`)
    if (cfg.debug) {
      bot._status = setInterval(() => {
        const p = bot.entity && bot.entity.position
        if (!p) return
        const tgt = targetPos(bot)
        console.log(`[${tag}] pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} ` +
          `dist=${tgt ? tgt.distanceTo(p).toFixed(1) : '-'} serverSetPos=${bot._rb} chunk=${bot.blockAt(p) ? 'loaded' : 'UNLOADED'}`)
        bot._rb = 0
      }, 10000)
    }
    try { bot.creative.startFlying() } catch (e) { console.log(`[${tag}] startFlying failed: ${e.message}`) }
    sendFlying()
    bot._t0 = Date.now()
    bot._orbit = true
    bot.on('physicsTick', () => {
      if (!bot._orbit) return
      const tgt = targetPos(bot)
      if (!tgt) return
      if (!bot._announced) { bot._announced = true; console.log(`[${tag}] can see ${TARGET} -> orbiting`) }
      bot.physics.gravity = 0
      bot.entity.velocity.set(0, 0, 0)
      bot.entity.onGround = false
      const ang = phase + (Date.now() - bot._t0) / PERIOD_MS * 2 * Math.PI
      glideStep(bot, tgt.offset(cfg.radius * Math.cos(ang), cfg.heightOffset, cfg.radius * Math.sin(ang)))
      try { bot.lookAt(tgt.offset(0, 1.6, 0), true) } catch (e) {}
    })
  })
  return bot
}

// Bot 0 teleports to the target; the others chain onto any bot already there, which auto-accepts.
const bots = []
BOTS.forEach((acct, i) => setTimeout(() => {
  const tag = 'B' + i
  const bot = makeBot(acct, tag, i * 2 * Math.PI / BOTS.length)
  bots.push(bot)

  // Nuke: bots take turns sending the command, evenly spread over the interval.
  bot.once('spawn', () => {
    const { command, intervalMs } = cfg.nuke
    const firstIn = (i * intervalMs / BOTS.length) - i * cfg.loginStaggerMs
    const fire = () => {
      if (!cfg.nuke.enabled) return
      console.log(`[${tag}] ${command}`)
      safeChat(bot, command)
    }
    bot._nukeFirst = setTimeout(() => { fire(); bot._nukeTimer = setInterval(fire, intervalMs) }, Math.max(3000, firstIn))
  })

  if (i === 0) {
    bot.once('spawn', () => {
      let n = 0
      const ask = () => {
        if (!bot._alive || targetPos(bot)) return
        if (++n > 8) { console.log(`[${tag}] gave up on /tpa ${TARGET} - use /tpahere ${bot.username}`); return }
        console.log(`[${tag}] /tpa ${TARGET} (try ${n}) - /tpaccept, or /tpahere ${bot.username}`)
        safeChat(bot, '/tpa ' + TARGET)
        bot._askTimer = setTimeout(ask, 40000)
      }
      setTimeout(ask, 1500)
    })
    return
  }

  bot.once('spawn', () => {
    let tries = 0
    let waited = 0
    bot._retryTimer = setInterval(() => {
      if (targetPos(bot)) { clearInterval(bot._retryTimer); return }
      const anchor = bots.find(b => b !== bot && b._alive && b.entity && targetPos(b))
      if (!anchor && ++waited < 10) return
      tries++
      if (anchor && tries <= 6) {
        console.log(`[${tag}] /tpa ${anchor.username} (try ${tries})`)
        safeChat(bot, '/tpa ' + anchor.username)
      } else {
        clearInterval(bot._retryTimer)
        console.log(`[${tag}] chain failed -> /tpa ${TARGET} (please /tpaccept)`)
        safeChat(bot, '/tpa ' + TARGET)
      }
    }, 6000)
  })
}, i * cfg.loginStaggerMs))

// Console commands: "nuke on", "nuke off", "nuke" (toggle), "quit".
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  const [cmd, arg] = line.trim().toLowerCase().split(/\s+/)
  if (cmd === 'nuke') {
    cfg.nuke.enabled = arg === 'on' ? true : arg === 'off' ? false : !cfg.nuke.enabled
    console.log(`nuke mode ${cfg.nuke.enabled ? 'ON' : 'OFF'}`)
  } else if (cmd === 'quit' || cmd === 'exit') {
    shutdown()
  } else if (cmd) {
    console.log('commands: nuke on | nuke off | nuke | quit')
  }
})

function stopTimers (b) {
  b._orbit = false
  clearTimeout(b._askTimer)
  clearTimeout(b._nukeFirst)
  clearInterval(b._nukeTimer)
  clearInterval(b._retryTimer)
  clearInterval(b._status)
}

function shutdown () {
  console.log(`disconnecting ${bots.length} bots...`)
  rl.close()
  for (const b of bots) {
    try {
      stopTimers(b)
      b.quit('bye')
    } catch (e) {}
  }
  setTimeout(() => {
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (e) {}
    process.exit(0)
  }, 800)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
console.log(`Orbiting ${TARGET} on ${cfg.host}. Nuke mode ${cfg.nuke.enabled ? 'ON' : 'OFF'} (type "nuke on" / "nuke off").`)

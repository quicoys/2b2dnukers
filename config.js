const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  host: '2b2d.org',
  port: 25565,
  target: '',
  radius: 8,
  lapSeconds: 8,
  heightOffset: 1,
  loginStaggerMs: 5000,
  nuke: { enabled: false, command: '/bomb', intervalMs: 5000 },
  authCacheDir: './accounts',
  extraAuthDirs: [],
  tokenCacheDirs: [],
  excludeUuidPrefixes: [],
  debug: false
}

const resolveDir = d => path.resolve(__dirname, d.replace(/^~(?=\/|$)/, require('os').homedir()))

function loadConfig () {
  const file = path.join(__dirname, 'config.json')
  const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const cfg = { ...DEFAULTS, ...user, nuke: { ...DEFAULTS.nuke, ...user.nuke } }
  cfg.authCacheDir = resolveDir(cfg.authCacheDir)
  cfg.extraAuthDirs = cfg.extraAuthDirs.map(resolveDir)
  cfg.tokenCacheDirs = cfg.tokenCacheDirs.map(resolveDir)
  return cfg
}

module.exports = { loadConfig }

// Usage: node login.js <AccountName>
const fs = require('fs')
const { Authflow, Titles } = require('prismarine-auth')
const { loadConfig } = require('./config')

const name = process.argv[2]
if (!name) { console.log('usage: node login.js <AccountName>'); process.exit(1) }
const { authCacheDir } = loadConfig()
fs.mkdirSync(authCacheDir, { recursive: true })

const flow = new Authflow(name, authCacheDir,
  { authTitle: Titles.MinecraftNintendoSwitch, deviceType: 'Nintendo', flow: 'live' },
  code => console.log(`Open ${code.verification_uri}, enter ${code.user_code} and sign in as ${name} (expires in ${Math.round(code.expires_in / 60)} min)`))

flow.getMinecraftJavaToken({ fetchProfile: true })
  .then(({ profile }) => {
    if (!profile || !profile.name) throw new Error('signed in, but that Microsoft account has no Minecraft profile')
    console.log(`Login OK: ${profile.name} (${profile.id})`)
    if (profile.name.toLowerCase() !== name.toLowerCase()) {
      console.log(`Warning: signed in as ${profile.name}, not ${name}. It is saved and will be used anyway.`)
    }
  })
  .catch(e => { console.log('Login failed: ' + e.message); process.exit(1) })

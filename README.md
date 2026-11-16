# 2b2dnukers

A [mineflayer](https://github.com/PrismarineJS/mineflayer) bot swarm that teleports to a player and flies in a ring around them. An optional **nuke mode** has the bots take turns sending a chat command (default `/bomb`).

## Setup

```sh
npm install
cp config.example.json config.json   # then set "target" to your player name
```

Sign in each bot account once (Microsoft device-code login):

```sh
node login.js <AccountName>
```

Tokens are cached in `authCacheDir` (default `./accounts`) and refresh automatically.

## Run

```sh
node orbit.js                 # uses "target" from config.json
node orbit.js SomePlayer      # override target
node orbit.js --nuke          # start with nuke mode on
node orbit.js --no-nuke       # start with nuke mode off
node orbit.js --debug         # verbose position/chat logging
```

While running, type in the terminal:

| Command    | Effect               |
|------------|----------------------|
| `nuke on`  | enable nuke mode     |
| `nuke off` | disable nuke mode    |
| `nuke`     | toggle nuke mode     |
| `quit`     | disconnect all bots  |

Orbiting is always on. Bot 0 sends `/tpa <target>` (accept it, or `/tpahere` the bot); the other bots chain-teleport onto bot 0.

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `host`, `port` | `2b2d.org`, `25565` | Server |
| `target` | — | Player to orbit |
| `radius` | `8` | Orbit radius (blocks) |
| `lapSeconds` | `8` | Time for one lap |
| `heightOffset` | `1` | Height above the target's feet |
| `loginStaggerMs` | `5000` | Delay between bot logins |
| `nuke.enabled` | `false` | Nuke mode at startup |
| `nuke.command` | `/bomb` | Command each bot sends |
| `nuke.intervalMs` | `5000` | How often each bot sends it |
| `authCacheDir` | `./accounts` | Where `login.js` saves accounts |
| `extraAuthDirs` | `[]` | More prismarine-auth cache folders to load accounts from |
| `tokenCacheDirs` | `[]` | Folders with `auth-cache*.json` files holding raw tokens (`uuid`, `name`, `mc_access_token`, `mc_expires_at`) |
| `excludeUuidPrefixes` | `[]` | Never log in accounts whose UUID starts with these |
| `debug` | `false` | Verbose logging |

Never commit `config.json` or your account caches — they're in `.gitignore`.

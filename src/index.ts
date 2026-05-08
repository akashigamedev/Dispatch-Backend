import 'dotenv/config'
import './env.js' // validate env first — exits on invalid config
import { createServer } from './api/server.js'
import { env } from './env.js'
import { log } from './log.js'
import { pollProjects } from './scheduler/poller.js'

const app = createServer()

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'nightowl server started')
})

// Poll every 2 minutes. M4 will gate this behind active + work-window checks.
const POLL_INTERVAL_MS = 2 * 60 * 1000
setInterval(() => {
  pollProjects().catch((err) => log.error({ err }, 'poller error'))
}, POLL_INTERVAL_MS)

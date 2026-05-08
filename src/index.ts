import 'dotenv/config'
import './env.js' // validate env first — exits on invalid config
import { createServer } from './api/server.js'
import { env } from './env.js'
import { log } from './log.js'

const app = createServer()

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'nightowl server started')
})

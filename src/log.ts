import pino from 'pino'

const pretty = process.stdout.isTTY

export const log = pino({
  level: pretty ? 'debug' : 'info',
  ...(pretty && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
})

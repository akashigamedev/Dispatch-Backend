import { z } from 'zod'

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  GITHUB_APP_ID: z.coerce.number().int().positive(),
  GITHUB_APP_PRIVATE_KEY_BASE64: z.string().min(1),
  GITHUB_APP_CLIENT_ID: z.string().min(1),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),

  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

function parseEnv() {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:')
    for (const [field, issues] of Object.entries(result.error.flatten().fieldErrors)) {
      console.error(`  ${field}: ${issues?.join(', ')}`)
    }
    process.exit(1)
  }
  return result.data
}

export const env = parseEnv()

export const githubAppPrivateKey = Buffer.from(
  env.GITHUB_APP_PRIVATE_KEY_BASE64,
  'base64',
).toString('utf-8')

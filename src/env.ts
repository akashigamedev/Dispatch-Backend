import { z } from 'zod'

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),

  GITHUB_PAT: z.string().min(1),

  DATABASE_URL: z.string().url(),

  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

function parseEnv() {
  const result = schema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:')
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
    process.exit(1)
  }
  return result.data
}

export const env = parseEnv()

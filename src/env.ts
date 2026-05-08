import { z } from 'zod'

const schema = z
  .object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    SUPABASE_JWT_SECRET: z.string().min(1),

    // GitHub auth — at least one mode (PAT or full GH App config) must be set.
    // Validated as a refinement below.
    GITHUB_PAT: z.string().min(1).optional(),
    GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
    GITHUB_APP_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
    GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),

    ANTHROPIC_API_KEY: z.string().startsWith('sk-ant-'),

    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().url(),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  })
  .refine(
    (e) => {
      const appFields = [
        e.GITHUB_APP_ID,
        e.GITHUB_APP_PRIVATE_KEY_BASE64,
        e.GITHUB_APP_CLIENT_ID,
        e.GITHUB_APP_CLIENT_SECRET,
        e.GITHUB_WEBHOOK_SECRET,
      ]
      const appAllSet = appFields.every((v) => v !== undefined)
      const appAnySet = appFields.some((v) => v !== undefined)
      const patSet = !!e.GITHUB_PAT

      if (!patSet && !appAllSet) return false
      // partial GH App config is rejected — all-or-none
      if (appAnySet && !appAllSet) return false
      return true
    },
    {
      message:
        'GitHub auth not configured: set GITHUB_PAT, or all of GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_BASE64/GITHUB_APP_CLIENT_ID/GITHUB_APP_CLIENT_SECRET/GITHUB_WEBHOOK_SECRET.',
    },
  )

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

export const githubAppPrivateKey = env.GITHUB_APP_PRIVATE_KEY_BASE64
  ? Buffer.from(env.GITHUB_APP_PRIVATE_KEY_BASE64, 'base64').toString('utf-8')
  : undefined

export const githubAuthMode: 'app' | 'pat' = env.GITHUB_APP_ID ? 'app' : 'pat'

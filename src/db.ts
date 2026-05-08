import { createClient } from '@supabase/supabase-js'
import { env } from './env.js'
import type { Database } from './types/supabase.js'

// Service-role client: bypasses RLS. Only for server-side use — never expose to clients.
export const db = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

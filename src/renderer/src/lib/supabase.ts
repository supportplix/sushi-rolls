import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

export function buildClient(url: string, anonKey: string): SupabaseClient {
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'sushi-rolls-auth',
      detectSessionInUrl: false
    },
    realtime: {
      params: { eventsPerSecond: 5 }
    },
    global: {
      headers: { 'x-app': 'sushi-rolls-desktop' }
    }
  })
  return client
}

export function getClient(): SupabaseClient {
  if (!client) throw new Error('SUPABASE_NOT_READY')
  return client
}

export function clearClient(): void {
  client = null
}

export const AUTH_EMAIL_DOMAIN = 'sushirolls.local'

export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}

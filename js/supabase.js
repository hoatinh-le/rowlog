import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://ayevvdzcfshembhymwtx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF5ZXZ2ZHpjZnNoZW1iaHltd3R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NDkwNDksImV4cCI6MjA5MDAyNTA0OX0.1eXmRNLPJakyAEgb-QbAJgFeh5rD8alZZ41wNAgEbkY'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
})

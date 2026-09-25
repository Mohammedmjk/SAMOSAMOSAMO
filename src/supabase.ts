import { createClient, SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://boaopqyzhvyzdclmoycr.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJvYW9wcXl6aHZ5emRjbG1veWNyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MzM3NTEsImV4cCI6MjEwNTQwOTc1MX0.gGK13rvlXjqhBnyQ4b_GAkb2MYJXOTdWXOxwyykAwjY';

export const SUPABASE_TABLE_NAME = 'samo';

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!supabaseClient) {
    const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
    supabaseClient = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  }
  return supabaseClient;
}

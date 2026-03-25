import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? 'https://yvdfiwabdvcpqwrmtysd.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2ZGZpd2FiZHZjcHF3cm10eXNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MDgyMzUsImV4cCI6MjA4OTk4NDIzNX0.H1sbIMZYr_K7YXNAkXJEwfokUm3dCxmmhQ3wCSFyuu0';

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

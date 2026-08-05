import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://drvjzdxycxgvaeskcbgc.supabase.co";
const supabaseAnonKey =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRydmp6ZHh5Y3hndmFlc2tjYmdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU3NjcyMDAsImV4cCI6MjEwMTM0MzIwMH0.AKeE9YCK5Cx5N1NIjDLibzeh9D1oAkHA4lW4bbw6E2k";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const SUPABASE_URL = supabaseUrl;
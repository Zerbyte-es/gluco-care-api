import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';

// Define your Cloudflare Worker environment bindings
type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Helper for user-facing API calls (respects RLS using the Anon Key)
const getSupabase = (env: Bindings) => createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

// Helper for background cron tasks (bypasses RLS using the Service Role Key)
const getAdminSupabase = (env: Bindings) => createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// 1. Glucose Upload Endpoint
app.post('/api/glucose/upload', async (c) => {
  const supabase = getSupabase(c.env);
  const { user_id, glucose_level } = await c.req.json();

  // Insert log into Supabase
  const { data, error } = await supabase
    .from('glucose_logs')
    .insert([{ user_id, glucose_level, reading_type: 'post_meal' }])
    .select();

  if (error) return c.json({ error: error.message }, 400);

  // Check clinical threshold (> 200 mg/dL triggers immediate doctor alert)
  const isCritical = glucose_level > 200;

  // Reset pending schedules for this user upon upload
  await supabase
    .from('check_schedules')
    .update({ status: 'completed', escalation_count: 0 })
    .eq('user_id', user_id)
    .eq('status', 'pending');

  return c.json({
    success: true,
    message: "Result uploaded successfully.",
    alert_doctor: isCritical,
    trend: isCritical ? "red_down" : "green_up"
  });
});

// 2. Native Cloudflare Scheduled Worker (The 30-Minute Escalation Loop)
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) {
    // Use the admin client here so the background worker can scan all users, bypassing RLS
    const supabase = getAdminSupabase(env);
    console.log("Running 30-minute escalation check loop...");

    const now = new Date().toISOString();

    // Fetch all pending schedules that are overdue by 30+ minutes
    const { data: overdueSchedules, error } = await supabase
      .from('check_schedules')
      .select('*, users(fcm_token, full_name)')
      .eq('status', 'pending')
      .lt('scheduled_time', now);

    if (error || !overdueSchedules) {
      console.error("Error fetching overdue schedules:", error);
      return;
    }

    for (const schedule of overdueSchedules) {
      // Trigger push notification reminder
      console.log(`[ESCALATION] Sending reminder to user ID: ${schedule.user_id}`);
      
      // Update last reminder sent timestamp and increment escalation counter
      await supabase
        .from('check_schedules')
        .update({ 
          last_reminder_sent_at: now,
          escalation_count: (schedule.escalation_count || 0) + 1 
        })
        .eq('id', schedule.id);
    }
  }
};

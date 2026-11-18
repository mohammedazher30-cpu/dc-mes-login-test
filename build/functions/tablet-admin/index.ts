import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown) => new Response(JSON.stringify(b), { headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (error: string, extra: Record<string, unknown> = {}) => out({ ok: false, error, ...extra });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function pinHash(pin: string, salt: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100000 }, k, 256));
}
const randomB64 = (n: number) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function same(a: string, b: string) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
/* Admin only: register / disable tablets, set or remove team leader PINs. */
async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: u } = await admin.from("app_user").select("id,role,active").eq("id", data.user.id).maybeSingle();
  return u && u.active && u.role === "admin" ? u : null;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "tl";
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const me = await caller(req);
    if (!me) return fail("Only an active admin can do this.");
    const b = await req.json().catch(() => ({}));
    if (b.action === "list") {
      const [{ data: devices }, { data: pins }] = await Promise.all([
        admin.from("device").select("id,name,workshop_ids,active,registered_at,last_used_at,last_user,pair_expires_at,paired_at").order("registered_at"),
        admin.from("operator_pin").select("operator_id,failed_pins,locked_until,set_at")]);
      return out({ ok: true, devices: devices || [], pins: pins || [] });
    }
    if (b.action === "register_device") {
      const name = String(b.name || "").trim();
      if (!name) return fail("Enter a tablet name.");
      const key = randomB64(32);
      const ws = Array.isArray(b.workshop_ids) ? b.workshop_ids : [];
      const { data, error } = await admin.from("device").insert({ name, workshop_ids: ws, key_hash: await sha256(key), registered_by: me.id }).select("id").single();
      if (error) return fail(error.message);
      return out({ ok: true, id: data.id, key });
    }
    if (b.action === "add_device" || b.action === "new_code") {
      /* one-time code the tablet types in to register itself (no email, no admin sign-in on the tablet) */
      const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
      const raw = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => ABC[x % ABC.length]).join("");
      const code = raw.slice(0, 4) + "-" + raw.slice(4);
      const exp = new Date(Date.now() + 10 * 60000).toISOString();
      if (b.action === "add_device") {
        const name = String(b.name || "").trim();
        if (!name) return fail("Enter a tablet name.");
        const ws = Array.isArray(b.workshop_ids) ? b.workshop_ids : [];
        const { data, error } = await admin.from("device").insert({ name, workshop_ids: ws, key_hash: await sha256("pending-" + randomB64(24)), active: false,
          pair_code_hash: await sha256(raw), pair_expires_at: exp, registered_by: me.id }).select("id").single();
        if (error) return fail(error.message);
        return out({ ok: true, id: data.id, code, expires: exp });
      }
      const { error } = await admin.from("device").update({ pair_code_hash: await sha256(raw), pair_expires_at: exp }).eq("id", b.id);
      return error ? fail(error.message) : out({ ok: true, code, expires: exp });
    }
    if (b.action === "signin_link") {
      /* one-time sign-in for an office user, sent by the admin on WhatsApp/Teams (company email scanners use up normal links) */
      const email = String(b.email || "").trim().toLowerCase();
      const { data: u } = await admin.from("app_user").select("id,full_name,email,role,active").ilike("email", email).maybeSingle();
      if (!u) return fail("No MES user with this email. Invite him first.");
      if (!u.active) return fail("This user is deactivated.");
      if (u.role === "team_leader") return fail("Team leaders sign in on tablets with their PIN.");
      const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.email });
      if (error || !link?.properties?.hashed_token) return fail("Could not create the link: " + (error?.message || "unknown"));
      return out({ ok: true, token_hash: link.properties.hashed_token, name: u.full_name || u.email });
    }
    if (b.action === "set_device_active") {
      const { error } = await admin.from("device").update({ active: !!b.active }).eq("id", b.id);
      return error ? fail(error.message) : out({ ok: true });
    }
    if (b.action === "set_pin") {
      const pin = String(b.pin || "");
      if (!/^\d{4}$/.test(pin)) return fail("PIN must be 4 digits.");
      if (/^(\d)\1{3}$/.test(pin) || ["1234", "4321", "0123"].includes(pin)) return fail("PIN is too easy to guess. Choose another.");
      const { data: op } = await admin.from("operator").select("id,name,code,workshop_id").eq("id", b.operator_id).maybeSingle();
      if (!op) return fail("Team leader not found.");
      let { data: au } = await admin.from("app_user").select("id,active").eq("operator_id", op.id).maybeSingle();
      if (!au) {
        const email = `tl-${slug(op.code || op.id)}@tablet.dc-mes.local`;
        const { data: cu, error: ce } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name: op.name, kind: "tablet" } });
        if (ce || !cu?.user) return fail("Could not create the login: " + (ce?.message || "unknown"));
        const { error: ie } = await admin.from("app_user").insert({ id: cu.user.id, full_name: op.name, email, role: "team_leader", workshop_ids: op.workshop_id ? [op.workshop_id] : [], operator_id: op.id, active: true, invited_by: me.id });
        if (ie) { await admin.auth.admin.deleteUser(cu.user.id); return fail("Could not create the MES user: " + ie.message); }
        au = { id: cu.user.id, active: true };
      } else if (!au.active) {
        await admin.from("app_user").update({ active: true }).eq("id", au.id);
      }
      const salt = randomB64(16);
      const { error } = await admin.from("operator_pin").upsert({ operator_id: op.id, pin_hash: await pinHash(pin, salt), pin_salt: salt, auth_user_id: au.id, failed_pins: 0, locked_until: null, set_by: me.id, set_at: new Date().toISOString() });
      return error ? fail(error.message) : out({ ok: true });
    }
    if (b.action === "remove_pin") {
      await admin.from("operator_pin").delete().eq("operator_id", b.operator_id);
      await admin.from("app_user").update({ active: false }).eq("operator_id", b.operator_id);
      return out({ ok: true });
    }
    if (b.action === "unlock_pin") {
      await admin.from("operator_pin").update({ failed_pins: 0, locked_until: null }).eq("operator_id", b.operator_id);
      return out({ ok: true });
    }
    return fail("Unknown action");
  } catch (e) { console.error(e); return fail("Server error. Try again."); }
});

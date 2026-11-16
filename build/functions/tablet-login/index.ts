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
/* Team leader sign-in on a registered tablet: name + 4-digit PIN. No email is sent. */
const MAX_TRIES = 5, LOCK_MIN = 15;
async function deviceByKey(key: unknown) {
  if (typeof key !== "string" || key.length < 20) return null;
  const { data } = await admin.from("device").select("id,name,workshop_ids,active").eq("key_hash", await sha256(key)).maybeSingle();
  return data && data.active ? data : null;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const dev = await deviceByKey(body.device_key);
    if (!dev) return fail("This tablet is not registered or was disabled. Ask your admin.", { device: false });
    const inWs = (ws: string | null) => !dev.workshop_ids?.length || (ws && dev.workshop_ids.includes(ws));
    if (body.action === "list") {
      const { data: pins } = await admin.from("operator_pin").select("operator_id");
      const ids = (pins || []).map((p) => p.operator_id);
      if (!ids.length) return out({ ok: true, device: dev.name, people: [] });
      const { data: ops } = await admin.from("operator").select("id,name,code,workshop_id,workshop:workshop_id(code,name)").in("id", ids).order("name");
      const people = (ops || []).filter((o) => inWs(o.workshop_id)).map((o) => ({ id: o.id, name: o.name, ws: (o as any).workshop?.name || "" }));
      return out({ ok: true, device: dev.name, people });
    }
    if (body.action === "login") {
      const pin = String(body.pin || "");
      if (!/^\d{4}$/.test(pin)) return fail("Enter your 4-digit PIN.");
      const { data: op } = await admin.from("operator").select("id,name,workshop_id").eq("id", body.operator_id).maybeSingle();
      if (!op || !inWs(op.workshop_id)) return fail("You can't sign in on this tablet.");
      const { data: p } = await admin.from("operator_pin").select("*").eq("operator_id", op.id).maybeSingle();
      if (!p) return fail("No PIN set for you yet. Ask your admin.");
      if (p.locked_until && new Date(p.locked_until) > new Date()) {
        const m = Math.ceil((new Date(p.locked_until).getTime() - Date.now()) / 60000);
        return fail(`Too many wrong PINs. Try again in ${m} min or ask your admin.`, { locked: true });
      }
      if (!same(await pinHash(pin, p.pin_salt), p.pin_hash)) {
        const f = (p.failed_pins || 0) + 1;
        const lock = f >= MAX_TRIES;
        await admin.from("operator_pin").update(lock ? { failed_pins: 0, locked_until: new Date(Date.now() + LOCK_MIN * 60000).toISOString() } : { failed_pins: f }).eq("operator_id", op.id);
        return fail(lock ? `Too many wrong PINs. Locked for ${LOCK_MIN} min.` : `Wrong PIN. ${MAX_TRIES - f} tries left.`, { locked: lock });
      }
      const { data: au } = await admin.from("app_user").select("id,email,active").eq("operator_id", op.id).maybeSingle();
      if (!au || !au.active) return fail("Your MES account is not active. Ask your admin.");
      const { data: link, error: le } = await admin.auth.admin.generateLink({ type: "magiclink", email: au.email });
      if (le || !link?.properties?.hashed_token) return fail("Could not sign you in. Try again.");
      const now = new Date().toISOString();
      await admin.from("operator_pin").update({ failed_pins: 0, locked_until: null }).eq("operator_id", op.id);
      await admin.from("device").update({ last_used_at: now, last_user: op.name }).eq("id", dev.id);
      await admin.from("app_user").update({ last_login_at: now }).eq("id", au.id);
      return out({ ok: true, token_hash: link.properties.hashed_token, name: op.name });
    }
    return fail("Unknown action");
  } catch (e) { console.error(e); return fail("Server error. Try again."); }
});

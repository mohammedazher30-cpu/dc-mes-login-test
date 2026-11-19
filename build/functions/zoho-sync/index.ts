import { createClient } from "npm:@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown) => new Response(JSON.stringify(b), { headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (error: string, extra: Record<string, unknown> = {}) => out({ ok: false, error, ...extra });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
/* Zoho connection (admin only): connect with a Self Client code, test, disconnect.
   Keys live in the locked table zoho_connection (service role only). */
const TLD: Record<string, string> = { com: "com", sa: "sa", eu: "eu", in: "in", au: "com.au", jp: "jp", ca: "zohocloud.ca", uk: "uk" };
async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  if (!data?.user) return null;
  const { data: u } = await admin.from("app_user").select("id,role,active").eq("id", data.user.id).maybeSingle();
  return u && u.active && u.role === "admin" ? u : null;
}
const projectsBase = (dc: string) => dc === "ca" ? "https://projectsapi.zohocloud.ca" : `https://projectsapi.zoho.${TLD[dc] || "com"}`;
async function getConn() { const { data } = await admin.from("zoho_connection").select("*").eq("id", 1).maybeSingle(); return data; }
async function accessToken(c: any) {
  if (c.access_token && c.access_expires_at && new Date(c.access_expires_at).getTime() - Date.now() > 120000) return c.access_token;
  const u = `${c.accounts_url}/oauth/v2/token?grant_type=refresh_token&client_id=${encodeURIComponent(c.client_id)}&client_secret=${encodeURIComponent(c.client_secret)}&refresh_token=${encodeURIComponent(c.refresh_token)}`;
  const r = await fetch(u, { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error("Zoho refused the key: " + (j.error || r.status));
  const exp = new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString();
  await admin.from("zoho_connection").update({ access_token: j.access_token, access_expires_at: exp, api_domain: j.api_domain || c.api_domain }).eq("id", 1);
  c.access_token = j.access_token; c.api_domain = j.api_domain || c.api_domain;
  return j.access_token;
}
async function zget(c: any, url: string) {
  const tok = await accessToken(c);
  const r = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + tok } });
  const txt = await r.text();
  let j: any = null; try { j = JSON.parse(txt); } catch { /* not json */ }
  if (!r.ok) throw new Error(`Zoho ${r.status}: ${(j && (j.error?.message || j.message || j.error?.title || JSON.stringify(j.error || j))) || txt.slice(0, 200)}`);
  return j;
}
const arr = (j: any, ...keys: string[]) => Array.isArray(j) ? j : (keys.map((k) => j?.[k]).find(Array.isArray) || []);
async function test(c: any) {
  const out: any = { ok: true, dc: c.dc };
  // Zoho Projects: portals, then projects of the DC portal
  const pj = await zget(c, `${projectsBase(c.dc)}/api/v3/portals`);
  const portals = arr(pj, "portals", "data").map((p: any) => ({ id: String(p.id ?? p.id_string ?? p.portal_id ?? ""), name: p.name ?? p.portal_name ?? p.company_name ?? "" }));
  out.portals = portals;
  const portal = portals.find((p: any) => p.id === c.portal_id) || portals[0];
  if (portal) {
    let projects: any[] = []; let raw = "";
    try {
      const prj = await zget(c, `${projectsBase(c.dc)}/api/v3/portal/${portal.id}/projects?page=1&per_page=100`);
      projects = arr(prj, "projects", "data");
      if (!projects.length) raw = JSON.stringify(prj).slice(0, 400);
    } catch (e) { out.projects_error = String((e as Error).message || e); }
    out.portal = portal;
    out.projects = projects.map((p: any) => ({ id: String(p.id ?? p.id_string ?? ""), name: p.name ?? "", key: p.key ?? p.project_key ?? p.prefix ?? "",
      status: p.status?.name ?? p.custom_status_name ?? p.status ?? "", owner: p.owner?.name ?? p.owner_name ?? "" }));
    if (raw) out.projects_raw = raw;
    await admin.from("zoho_connection").update({ portal_id: portal.id, portal_name: portal.name }).eq("id", 1);
  }
  // Zoho Inventory: organizations
  try {
    const base = c.api_domain || `https://www.zohoapis.${TLD[c.dc] || "com"}`;
    const ij = await zget(c, `${base}/inventory/v1/organizations`);
    const orgs = arr(ij, "organizations").map((o: any) => ({ id: String(o.organization_id ?? ""), name: o.name ?? "" }));
    out.inventory_orgs = orgs;
    if (orgs[0]) await admin.from("zoho_connection").update({ inventory_org_id: orgs[0].id, inventory_org_name: orgs[0].name }).eq("id", 1);
  } catch (e) { out.inventory_error = String((e as Error).message || e); }
  await admin.from("zoho_connection").update({ last_ok_at: new Date().toISOString(), last_error: null }).eq("id", 1);
  return out;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const me = await caller(req);
    if (!me) return fail("Only an active admin can do this.");
    const b = await req.json().catch(() => ({}));
    if (b.action === "status") {
      const c = await getConn();
      if (!c) return out({ ok: true, connected: false });
      const { data: who } = c.connected_by ? await admin.from("app_user").select("full_name").eq("id", c.connected_by).maybeSingle() : { data: null };
      return out({ ok: true, connected: true, dc: c.dc, scope: c.scope, portal: c.portal_name, inventory_org: c.inventory_org_name,
        connected_by: who?.full_name || "", connected_at: c.connected_at, last_ok_at: c.last_ok_at, last_error: c.last_error });
    }
    if (b.action === "connect") {
      const dc = String(b.dc || "com"); if (!TLD[dc]) return fail("Unknown Zoho domain.");
      const client_id = String(b.client_id || "").trim(), client_secret = String(b.client_secret || "").trim(), code = String(b.code || "").trim();
      if (!client_id || !client_secret || !code) return fail("Enter Client ID, Client Secret and the generated code.");
      const accounts_url = dc === "ca" ? "https://accounts.zohocloud.ca" : `https://accounts.zoho.${TLD[dc]}`;
      const r = await fetch(`${accounts_url}/oauth/v2/token?grant_type=authorization_code&client_id=${encodeURIComponent(client_id)}&client_secret=${encodeURIComponent(client_secret)}&code=${encodeURIComponent(code)}`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!j.refresh_token) {
        const why = j.error === "invalid_code" ? "The code is wrong or expired (codes last only a few minutes). Generate a new code and try again."
          : j.error === "invalid_client" ? "Client ID or Client Secret is wrong, or the Zoho domain (.com / .sa) does not match."
          : "Zoho did not accept it: " + (j.error || r.status);
        return fail(why);
      }
      const row = { id: 1, dc, accounts_url, api_domain: j.api_domain || null, client_id, client_secret, refresh_token: j.refresh_token,
        access_token: j.access_token || null, access_expires_at: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000).toISOString(),
        scope: j.scope || null, connected_by: me.id, connected_at: new Date().toISOString(), last_error: null };
      const { error } = await admin.from("zoho_connection").upsert(row);
      if (error) return fail("Could not store the connection: " + error.message);
      try { return out({ connected: true, ...(await test(await getConn())) }); }
      catch (e) { await admin.from("zoho_connection").update({ last_error: String((e as Error).message) }).eq("id", 1); return out({ ok: true, connected: true, test_error: String((e as Error).message) }); }
    }
    if (b.action === "test") {
      const c = await getConn(); if (!c) return fail("Zoho is not connected yet.");
      try { return out(await test(c)); }
      catch (e) { await admin.from("zoho_connection").update({ last_error: String((e as Error).message) }).eq("id", 1); return fail(String((e as Error).message)); }
    }
    if (b.action === "disconnect") {
      const c = await getConn();
      if (c) { try { await fetch(`${c.accounts_url}/oauth/v2/token/revoke?token=${encodeURIComponent(c.refresh_token)}`, { method: "POST" }); } catch { /* ignore */ } }
      await admin.from("zoho_connection").delete().eq("id", 1);
      return out({ ok: true, connected: false });
    }
    return fail("Unknown action");
  } catch (e) { console.error(e); return fail("Server error: " + String((e as Error).message || e)); }
});

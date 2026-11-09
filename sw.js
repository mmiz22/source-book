/* Serves _blob/<id> from the private GitHub repo using the signed-in token. */
const FILE_CACHE = "sb-files";
self.addEventListener("install", e => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
async function auth() {
  const c = await caches.open("sb-auth"); const r = await c.match("auth");
  return r ? r.json() : null;
}
function sniff(b) {
  const u = new Uint8Array(b.slice(0, 12));
  if (u[0] === 0xff && u[1] === 0xd8) return "image/jpeg";
  if (u[0] === 0x89 && u[1] === 0x50) return "image/png";
  if (u[0] === 0x47 && u[1] === 0x49) return "image/gif";
  if (u[0] === 0x52 && u[1] === 0x49 && u[8] === 0x57) return "image/webp";
  if (u[0] === 0x25 && u[1] === 0x50 && u[2] === 0x44 && u[3] === 0x46) return "application/pdf";
  if (u[0] === 0x50 && u[1] === 0x4b) return "application/zip";
  return "application/octet-stream";
}
async function serve(id) {
  const key = "https://sb.cache/file/" + id;
  const cache = await caches.open(FILE_CACHE);
  const hit = await cache.match(key);
  if (hit) return hit;
  const a = await auth();
  if (!a) return new Response("Not signed in", { status: 401 });
  const r = await fetch(`${a.api || "https://api.github.com"}/repos/${a.owner}/${a.repo}/contents/files/${id}?ref=${a.branch}`, {
    headers: { Authorization: "Bearer " + a.token, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" }
  });
  if (!r.ok) return new Response("Not found", { status: r.status });
  const buf = await r.arrayBuffer();
  const resp = new Response(buf, { headers: { "Content-Type": sniff(buf), "Cache-Control": "private, max-age=31536000" } });
  try { await cache.put(key, resp.clone()); } catch {}
  return resp;
}
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  const m = u.origin === self.location.origin && u.pathname.match(/\/_blob\/([A-Za-z0-9_.-]+)$/);
  if (m) e.respondWith(serve(m[1]));
});

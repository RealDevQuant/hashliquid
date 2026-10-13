// A same-origin relay to the venue's public data API (it has no CORS headers, so the browser can't call it).
// GET /api/venue/<path>?<query>  →  (vercel.json rewrite)  →  /api/venue?p=<path>&<query>  →  https://data.velocity.exchange/<path>?<query>
// Read-only, GET only, a short shared cache so a busy terminal doesn't hammer the upstream.
const UPSTREAM = 'https://data.velocity.exchange'
const ALLOWED = /^(stats|market|amm|params)(\/|$)/

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const path = (url.searchParams.get('p') ?? url.pathname.replace(/^\/api\/venue\/?/, '')).replace(/^\/+/, '')
  url.searchParams.delete('p')
  if (!/^[\w\-./]+$/.test(path) || /(^|\/)\.\.?(\/|$)|\/\//.test(path)) return new Response('{"error":"not allowed"}', { status: 403, headers: { 'content-type': 'application/json' } })
  if (!ALLOWED.test(path)) return new Response('{"error":"not allowed"}', { status: 403, headers: { 'content-type': 'application/json' } })
  const upstream = `${UPSTREAM}/${path}${url.search}`
  try {
    const r = await fetch(upstream, { headers: { accept: 'application/json' } })
    const body = await r.text()
    return new Response(body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'public, s-maxage=5, max-age=2' } })
  } catch {
    return new Response('{"error":"upstream unavailable"}', { status: 502, headers: { 'content-type': 'application/json' } })
  }
}

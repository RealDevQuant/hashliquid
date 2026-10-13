import { defineConfig, type Plugin } from 'vite'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// Every dependency the shared client (../client/src) imports must come from web/node_modules,
// otherwise the client gets its own @solana/web3.js and PublicKey instanceof checks break.
const SHARED = ['@solana/web3.js', '@solana/spl-token', '@noble/hashes', '@scure/bip39', 'buffer']

/**
 * The IDLs carry their programs' documentation and error texts, which the page never shows. They are left out
 * of the site: it loads less, and the name of the exchange behind it stays out of what the site serves.
 */
const stripIdlDocs = (): Plugin => ({
  name: 'hashliquid-strip-idl-docs',
  enforce: 'pre',
  transform(code, id) {
    if (!/[\\/]idl[\\/][a-z]+\.json$/.test(id.split('?')[0])) return null
    const clean = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(clean)
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          if (k === 'docs' || k === 'description' || k === 'msg') continue
          out[k] = clean(x)
        }
        return out
      }
      return v
    }
    return { code: JSON.stringify(clean(JSON.parse(code))), map: null }
  },
})

/**
 * Dev server only, local validator only: GET /__fund?to=<wallet> gives that wallet 5 SOL and 10,000 test USDT
 * (client/scripts/fund-local.ts, which uses the throwaway mint authority in .localnet/). It lets the page's
 * "Get test funds" button work without a terminal. It doesn't exist in a built site.
 */
const localFaucet = (): Plugin => ({
  name: 'hashliquid-local-faucet',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__fund', (req, res) => {
      const to = new URL(req.url ?? '', 'http://localhost').searchParams.get('to') ?? ''
      const rpc = process.env.VITE_RPC_URL || 'http://127.0.0.1:8899'
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(to) || !/127\.0\.0\.1|localhost/.test(rpc)) {
        res.statusCode = 400
        res.end('local validator only')
        return
      }
      execFile(process.execPath, [path.resolve(here, '../client/scripts/fund-local.ts'), to], { env: { ...process.env, RPC: rpc } }, (err, stdout, stderr) => {
        res.statusCode = err ? 500 : 200
        res.end(err ? String(stderr || err.message).trim().split('\n').pop() : stdout)
      })
    })
  },
})

export default defineConfig({
  plugins: [stripIdlDocs(), localFaucet()],
  resolve: {
    alias: [{ find: '@hashliquid/client', replacement: path.resolve(here, '../client/src/index.ts') }],
    dedupe: SHARED,
  },
  define: { 'process.env': {} },
  optimizeDeps: { include: ['buffer', '@solana/web3.js', '@solana/spl-token'] },
  server: {
    port: 5183, strictPort: true,
    // serve only this app and the shared client source
    fs: { allow: [here, path.resolve(here, '../client/src')], deny: ['**/.localnet/**', '.env', '.env.*'] },
    // the same relay the built site has as a serverless function (api/venue): the data API sends no CORS headers
    proxy: { '/api/venue': { target: 'https://data.velocity.exchange', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api\/venue/, '') } },
  },
  // two pages: the landing (index.html) and the app (app.html)
  build: { target: 'es2022', chunkSizeWarningLimit: 2000, rollupOptions: { input: { index: path.resolve(here, 'index.html'), app: path.resolve(here, 'app.html'), docs: path.resolve(here, 'docs.html'), agents: path.resolve(here, 'agents.html'), deploy: path.resolve(here, 'deploy.html') } } },
})

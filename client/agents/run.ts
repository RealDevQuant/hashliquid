/*
  run.ts — the agents' service, from the command line. The work is in engine.ts.

    node agents/run.ts            loop forever
    node agents/run.ts --once     one decision cycle
    node agents/run.ts --dry      decide and log, sign nothing (also publishes the feed)
    node agents/run.ts --publish  only rebuild the feed from the chain and the logs
    node agents/run.ts --guard    one guard pass
    node agents/run.ts --launch   launch day: two rounds of forced entries, then exit (add --dry to rehearse)
*/
import { context, decisionCycle, flags, guardPass, launch, loop, publish } from './engine.ts'

const has = (f: string) => process.argv.includes(f)
flags.dry = has('--dry')

async function main() {
  if (has('--launch')) return launch()
  if (has('--publish')) return publish(await context())
  if (has('--guard')) return guardPass()
  if (has('--once') || flags.dry) return decisionCycle()
  await loop()
}
main().catch((e) => { console.error(e); process.exit(1) })

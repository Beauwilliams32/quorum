import os from 'node:os'
import { sh } from '../util.js'

// Same metrics as mem_sampler.py: free/inactive, compressed, wired, swapouts —
// the numbers that matter on a 24GB machine under render load.
const HIST = []
let lastSwapouts = null

export function startSystem(state) {
  const totalMB = Math.round(os.totalmem() / 1048576)

  const tick = async () => {
    const [vm, swap] = await Promise.all([
      sh('/usr/bin/vm_stat'),
      sh('/usr/sbin/sysctl', ['-n', 'vm.swapusage']),
    ])
    if (!vm) return
    const page = Number((vm.match(/page size of (\d+)/) || [])[1] || 16384)
    const mb = name => {
      const m = vm.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s+(\\d+)'))
      return m ? (+m[1] * page) / 1048576 : 0
    }
    const free = mb('Pages free') + mb('Pages speculative')
    const active = mb('Pages active')
    const wired = mb('Pages wired down')
    const comp = mb('Pages occupied by compressor')
    const inactive = mb('Pages inactive')
    const swapouts = +((vm.match(/Swapouts:\s+(\d+)/) || [])[1] || 0)
    const soRate = lastSwapouts == null ? 0 : Math.max(0, swapouts - lastSwapouts) / 2 // per second
    lastSwapouts = swapouts
    const swapUsedMB = Math.round(parseFloat((swap.match(/used = ([\d.]+)M/) || [])[1] || 0))

    const sample = {
      t: Date.now(),
      totalMB,
      freeMB: Math.round(free),
      usedMB: Math.round(active + wired),
      inactiveMB: Math.round(inactive),
      compMB: Math.round(comp),
      swapUsedMB,
      soRate: Math.round(soRate),
      load: +os.loadavg()[0].toFixed(2),
    }
    HIST.push(sample)
    if (HIST.length > 300) HIST.shift() // 10 min at 2s cadence

    // Store full history (for snapshot on connect) but broadcast only the latest sample.
    state.update('system', { latest: sample, hist: HIST }, { latest: sample })
  }

  tick()
  setInterval(tick, 2000)
}

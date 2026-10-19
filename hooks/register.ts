import type { Register } from 'claude-code'
import { loadConfig } from './config.ts'

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      const { config, source, warning } = await loadConfig($)
      if (warning) await $.ui.log(`orq: ${warning}`, { to: 'debug' })
      await $.ui.log(`orq loaded: config ${source}, jobsDir ${config.jobsDir}, ${config.instances.length} instances`, { to: 'debug' })
    } catch (err) {
      await $.ui.log(`orq: session.start failed: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })
}

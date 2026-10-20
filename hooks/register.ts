import type { Register } from 'claude-code'
import { registerEngine, registerOrqCommand } from './commands.ts'
import { loadConfig } from './config.ts'
import { registerTask, registerTaskSurface } from './task.ts'
import { declareIntegrateTool, registerIntegrate } from './integrate.ts'
import { registerInstructions } from './instructions.ts'
import { registerTools, startTools } from './tools.ts'

export const register: Register = (on) => {
  registerEngine(on)
  registerTask(on)
  registerIntegrate(on)
  registerTools(on)
  registerInstructions(on)
  on('session.start', async ($, e, next) => {
    try {
      const { config, source, warning } = await loadConfig($)
      if (warning) await $.ui.log(`orq: ${warning}`, { to: 'debug' })
      await $.ui.log(`orq loaded: config ${source}, jobsDir ${config.jobsDir}, ${config.instances.length} instances`, { to: 'debug' })
    } catch (err) {
      await $.ui.log(`orq: session.start failed: ${String(err)}`, { to: 'debug' })
    }
    try {
      await registerOrqCommand($)
    } catch (err) {
      await $.ui.log(`orq: could not register /orq: ${String(err)}`, { to: 'debug' })
    }
    try {
      await registerTaskSurface($)
    } catch (err) {
      await $.ui.log(`orq: could not register orq:task: ${String(err)}`, { to: 'debug' })
    }
    try {
      await declareIntegrateTool($)
    } catch (err) {
      await $.ui.log(`orq: could not register the integrate tool: ${String(err)}`, { to: 'debug' })
    }
    try {
      await startTools($, (await loadConfig($)).config)
    } catch (err) {
      await $.ui.log(`orq: could not declare the tools: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })
}

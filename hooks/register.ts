import type { Register } from 'claude-code'
import { registerCard, startCard, stopCard } from './card.ts'
import { registerEngine, registerOrqCommand } from './commands.ts'
import { loadConfig } from './config.ts'
import { registerPanel, registerPanelCommand, stopPanel } from './panel.ts'
import { registerTask, registerTaskSurface } from './task.ts'
import { logUnfinished } from './tools.ts'

export const register: Register = (on, options) => {
  registerEngine(on)
  registerPanel(on)
  registerCard(on, options)
  registerTask(on)
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
      await registerPanelCommand($)
    } catch (err) {
      await $.ui.log(`orq: could not register /orq-panel: ${String(err)}`, { to: 'debug' })
    }
    try {
      startCard($)
    } catch (err) {
      await $.ui.log(`orq: could not start the task card: ${String(err)}`, { to: 'debug' })
    }
    try {
      await registerTaskSurface($)
      await logUnfinished($, (await loadConfig($)).config)
    } catch (err) {
      await $.ui.log(`orq: could not register cc-orq:task and log the unfinished jobs: ${String(err)}`, { to: 'debug' })
    }
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    await stopCard($, e)
    stopPanel(e)
    return next(e)
  })
}

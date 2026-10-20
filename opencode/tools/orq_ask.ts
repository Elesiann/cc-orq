import { writeFile } from 'node:fs/promises'

import { tool } from '@opencode-ai/plugin'

// For OpenCode workers. orq starts every job with ORQ_JOB_DIR set; the tool records the question there,
// and the orchestrator reads it when the job exits. Install it as a symlink into ~/.config/opencode/tools/.

const STOP = 'Finish your reply with BLOCKED: followed by the question, and stop.'

export default tool({
  description:
    'Ask the orchestrating agent a question that the brief does not answer. Records the question for the parent. Then stop working.',
  args: {
    question: tool.schema.string().min(1).describe('The question, complete enough to answer without more context.'),
  },
  async execute(args) {
    const dir = process.env.ORQ_JOB_DIR
    if (!dir) {
      return { output: `orq_ask: ORQ_JOB_DIR is not set, so this is not an orq job and nothing was recorded. ${STOP}` }
    }
    const question = args.question.trim()
    if (question === '') return { output: `orq_ask: the question is empty, nothing was recorded. ${STOP}` }
    try {
      await writeFile(`${dir}/question.txt`, `${question}\n`, 'utf8')
    } catch (err) {
      return { output: `orq_ask: the question could not be recorded (${String(err)}). ${STOP}` }
    }
    return { output: `Question recorded for the orchestrator. ${STOP} Do not continue the task.` }
  },
})

// The seven fixtures that the tasks scenarios of the MCP conformance suite call, as tools over an in-memory TaskSource.
// The tools that create tasks answer through taskTool and registerTaskMethods of server/protocol.ts, as `delegate` does.

/** @import { DetailedTask, TaskSource } from '../../server/protocol.ts' */
import { ProtocolError, ProtocolErrorCode, acceptedContent, inputRequired } from '@modelcontextprotocol/server'

import { TASKS_EXTENSION, TaskNotFound, clientInfoOf, taskTool } from '../../server/protocol.ts'

const ENDED = new Set(['completed', 'failed', 'cancelled'])
const WORK_MS = 1000
const RESUME_MS = 150

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], isError })

class FixtureTask {
  state = { status: 'working' }
  createdAt = new Date().toISOString()
  lastUpdatedAt = this.createdAt
  #timer = undefined
  #minted = 0
  #collected = {}
  #whenAnswered = undefined

  constructor(id) {
    this.id = id
  }

  #set(state) {
    if (ENDED.has(this.state.status)) return
    clearTimeout(this.#timer)
    this.state = state
    this.lastUpdatedAt = new Date().toISOString()
  }

  after(ms, then) {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(then, ms)
    this.#timer.unref()
  }

  complete(result) {
    this.#set({ status: 'completed', result })
  }

  fail(error) {
    this.#set({ status: 'failed', error })
  }

  cancel() {
    this.#set({ status: 'cancelled' })
  }

  ask(requests, whenAnswered) {
    const outstanding = {}
    for (const request of requests) outstanding[`input-${(this.#minted += 1)}`] = request
    this.#collected = {}
    this.#whenAnswered = whenAnswered
    this.#set({ status: 'input_required', inputRequests: outstanding })
  }

  answer(responses) {
    if (this.state.status !== 'input_required') return
    const remaining = { ...this.state.inputRequests }
    let answered = 0
    for (const [key, response] of Object.entries(responses)) {
      // A server SHOULD ignore a key that is not outstanding (ext-tasks, tasks/update), and the suite sends one.
      if (!(key in remaining)) continue
      this.#collected[key] = response
      delete remaining[key]
      answered += 1
    }
    if (answered === 0) return
    if (Object.keys(remaining).length > 0) {
      this.#set({ status: 'input_required', inputRequests: remaining })
      return
    }
    this.#set({ status: 'working' })
    this.after(RESUME_MS, () => this.#whenAnswered(this.#collected))
  }

  /** @returns {DetailedTask} */
  detail() {
    return { createdAt: this.createdAt, lastUpdatedAt: this.lastUpdatedAt, ...this.state }
  }
}

const form = (message, properties) =>
  inputRequired.elicit({ message, requestedSchema: { type: 'object', properties, required: Object.keys(properties) } })

const confirmed = (response) => response.action === 'accept' && response.content?.confirm === true
const namesIn = (answers) =>
  Object.values(answers)
    .map((answer) => (answer.action === 'accept' && typeof answer.content?.name === 'string' ? answer.content.name : '-'))
    .join(', ')

const WORK = {
  slow_compute: {
    start: (task, { seconds, label }) => task.after(seconds * 1000, () => task.complete(text(`computed ${label} in ${seconds}s`))),
    sync: async ({ seconds, label }) => {
      await delay(seconds * 1000)
      return text(`computed ${label} in ${seconds}s`)
    },
  },
  failing_job: {
    start: (task) => task.after(WORK_MS, () => task.complete(text('failing_job failed on purpose', true))),
  },
  protocol_error_job: {
    start: (task) => task.after(WORK_MS / 2, () => task.fail({ code: ProtocolErrorCode.InternalError, message: 'protocol_error_job failed on purpose' })),
  },
  confirm_delete: {
    start: (task, { filename }) =>
      task.ask([form(`Delete ${filename}?`, { confirm: { type: 'boolean', title: 'Confirm' } })], (answers) => {
        const [answer] = Object.values(answers)
        task.complete(text(answer !== undefined && confirmed(answer) ? `deleted ${filename}` : `kept ${filename}`))
      }),
  },
  multi_input: {
    start: (task) =>
      task.ask(
        ['first', 'second'].map((which) => form(`Name the ${which} item`, { name: { type: 'string', title: 'Name' }, confirm: { type: 'boolean', title: 'Confirm' } })),
        (answers) => task.complete(text(`named ${namesIn(answers)}`)),
      ),
  },
  test_tool_with_task: {
    start: (task, { name }) => task.after(RESUME_MS, () => task.complete(text(`Hello, ${name}!`))),
  },
}

function argumentsOf(tool, input) {
  const args = typeof input === 'object' && input !== null ? input : {}
  const seconds = typeof args.seconds === 'number' && Number.isFinite(args.seconds) && args.seconds >= 0 ? args.seconds : 0
  return {
    seconds,
    label: typeof args.label === 'string' ? args.label : tool,
    filename: typeof args.filename === 'string' ? args.filename : 'unnamed',
    name: typeof args.name === 'string' ? args.name : 'unknown',
  }
}

/** @returns {TaskSource} */
export function fixtureSource() {
  const tasks = new Map()
  const find = (taskId) => {
    const task = tasks.get(taskId)
    if (task === undefined) throw new TaskNotFound(taskId)
    return task
  }
  return {
    async create(tool, input, client) {
      const work = WORK[tool]
      const args = argumentsOf(tool, input)
      if (!client.tasks) {
        return { result: work.sync !== undefined ? await work.sync(args) : text(`${tool} needs a client that declares ${TASKS_EXTENSION}`, true) }
      }
      const task = new FixtureTask(`task-${tool}-${crypto.randomUUID()}`)
      tasks.set(task.id, task)
      work.start(task, args)
      return { taskId: task.id }
    },
    async get(taskId) {
      return find(taskId).detail()
    },
    async update(taskId, responses) {
      find(taskId).answer(responses)
    },
    async cancel(taskId) {
      find(taskId).cancel()
    },
  }
}

const object = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false })

const TOOLS = {
  greet: {
    description: 'Sync-only: Hello, {name}!',
    inputSchema: object({ name: { type: 'string' } }),
    call: async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${typeof name === 'string' ? name : 'unknown'}!` }] }),
  },
  slow_compute: {
    description: 'Task-capable: waits `seconds`, then answers; `seconds: 0` is immediate.',
    inputSchema: object({ seconds: { type: 'number', minimum: 0 }, label: { type: 'string' } }),
  },
  failing_job: {
    description: 'Required task: ends as a tool error after about a second.',
    inputSchema: object({}),
    required: true,
  },
  protocol_error_job: {
    description: 'Task-capable: ends as failed, with a JSON-RPC error.',
    inputSchema: object({}),
  },
  confirm_delete: {
    description: 'Task-capable: parks on one elicitation, then completes.',
    inputSchema: object({ filename: { type: 'string' } }, ['filename']),
  },
  multi_input: {
    description: 'Task-capable: parks on two elicitations at once.',
    inputSchema: object({}),
  },
  test_tool_with_task: {
    description: 'Required task: asks for user_name in a round of its own, then returns a task that greets it.',
    inputSchema: object({}),
    required: true,
  },
}

const missingTasks = () =>
  new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, 'Missing required client capability', {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
  })

async function testToolWithTask(source, input, ctx) {
  const answer = acceptedContent(ctx.mcpReq.inputResponses, 'user_name')
  if (answer === undefined) {
    return inputRequired({ inputRequests: { user_name: form('What is your name?', { name: { type: 'string', title: 'Name' } }) } })
  }
  return taskTool(source, 'test_tool_with_task')({ ...input, name: answer.name }, ctx)
}

// The low-level server serves the tools, not McpServer.registerTool: McpServer turns an error thrown in a tool callback
// into an `isError` result, and a `required` tool must answer -32021 to a client that did not declare the extension.
export function registerFixtureTools(server, source) {
  server.setRequestHandler('tools/list', () => ({
    tools: Object.entries(TOOLS).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })),
  }))
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: input = {} } = request.params
    const tool = TOOLS[name]
    if (tool === undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${name} not found`)
    if (tool.required && !clientInfoOf(ctx.mcpReq.envelope).tasks) throw missingTasks()
    if (name === 'test_tool_with_task') return testToolWithTask(source, input, ctx)
    return tool.call !== undefined ? tool.call(input) : taskTool(source, name)(input, ctx)
  })
}

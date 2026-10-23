/**
 * server.js — `reflex mcp`: the handlers over MCP stdio. stdout is the protocol channel, so
 * nothing else may print there; logs go to stderr.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const handlers = require('./handlers');
const { version } = require('../../package.json');

const str = (description) => ({ type: 'string', description });

const TOOLS = [
  {
    name: 'context_show',
    description: 'Context pack of an app (screens, texts, transitions) plus its example plans and reusable blocks — read before writing a plan.',
    inputSchema: { type: 'object', properties: { app: str('app key from reflex.workspace.json apps') }, required: ['app'] },
    run: (args) => handlers.contextShow(args),
  },
  {
    name: 'plan_validate',
    description: 'Load and validate a *.plan.md without touching the device; returns errors and warnings to fix.',
    inputSchema: { type: 'object', properties: { plan: str('plan path, relative to the workspace or absolute') }, required: ['plan'] },
    run: (args) => handlers.planValidate(args),
  },
  {
    name: 'snapshot',
    description: 'Visible texts on the device screen right now (typed values are never shown).',
    inputSchema: { type: 'object', properties: { serial: str('adb serial'), platform: str('android | ios'), app: str('app key or package') } },
    run: (args) => handlers.snapshot(args),
  },
  {
    name: 'screen_capture',
    description: 'Snapshot the screen the device shows now into a draft screens/<app>/<group>/<screen>/screen.md: the texts and test ids an agent can turn into an `identify` block. Editable fields (their label is the typed value on Android) are never written.',
    inputSchema: { type: 'object', properties: { as: str('<group>/<screen> of the screen on the device'), app: str('app key from reflex.workspace.json apps'), serial: str('adb serial') }, required: ['as', 'app'] },
    run: (args) => handlers.screenCapture(args),
  },
  {
    name: 'screen_identify',
    description: 'Which screen of an app the device shows right now (null when none matches), with the public texts it matched on — the debugger for an `identify` block.',
    inputSchema: { type: 'object', properties: { app: str('app key from reflex.workspace.json apps'), serial: str('adb serial') }, required: ['app'] },
    run: (args) => handlers.screenIdentify(args),
  },
  {
    name: 'run_start',
    description: 'Start running a plan on the device in the background and return its runId at once; poll run_status until it finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: str('plan path'),
        case: str('run only this data row id'),
        serial: str('adb serial'),
        platform: str('android | ios'),
        screenshots: str('all | fail | none (default fail)'),
        noJev: { type: 'boolean', description: 'disable the Jev fallback (L2)' },
        noLearn: { type: 'boolean', description: 'do not write what the run learned back into screens/' },
        jevThreshold: { type: 'number', description: 'Jev confidence threshold in (0, 1] (default 0.75)' },
        maxJevCalls: { type: 'number', description: 'Jev call budget for the run (default 30)' },
      },
      required: ['plan'],
    },
    run: (args) => handlers.runStart(args),
  },
  {
    name: 'resume_start',
    description: 'Resume a run that stopped with needs_agent (after fixing the stuck step) in the background; poll run_status.',
    inputSchema: { type: 'object', properties: { runId: str('run id from run_start'), plan: str('plan path if it moved') }, required: ['runId'] },
    run: (args) => handlers.resumeStart(args),
  },
  {
    name: 'run_status',
    description: 'State of a run: starting | running | done | needs_agent | error | crashed, with the final result when finished.',
    inputSchema: { type: 'object', properties: { runId: str('run id') }, required: ['runId'] },
    run: (args) => handlers.runStatus(args),
  },
];

async function startServer() {
  const server = new Server({ name: 'reflex', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOLS.find((item) => item.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
    try {
      const result = await tool.run(request.params.arguments || {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message || String(error) }] };
    }
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write('[reflex] MCP server ready on stdio\n');
}

module.exports = { startServer, TOOLS };

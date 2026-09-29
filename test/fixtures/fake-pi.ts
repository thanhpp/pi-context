import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIDialogOptions,
  NormalizedBuildSystemPromptOptions,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

export interface FakePiHarness {
  api: ExtensionAPI;
  startSession(): Promise<void>;
  beforeAgentStart(prompt: string): Promise<NormalizedBuildSystemPromptOptions>;
  callTool(args: Record<string, unknown>): Promise<unknown>;
}

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CapturedTool = ToolDefinition<any, any, any>;

export function createFakePi(options: {
  cwd: string;
  mode: 'tui' | 'rpc' | 'json' | 'print';
  sessionId?: string;
  confirm?: (title: string, message: string, options?: ExtensionUIDialogOptions) => Promise<boolean>;
}): FakePiHarness {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, CapturedTool>();
  const statusValues = new Map<string, string | undefined>();
  const notifications: Array<{ message: string; type: 'info' | 'warning' | 'error' }> = [];
  const confirmations: Array<{ title: string; message: string; options?: ExtensionUIDialogOptions }> = [];
  const toolTexts: string[] = [];
  let systemPromptOptions: NormalizedBuildSystemPromptOptions | undefined;
  let sessionId = options.sessionId ?? 'fake-session-1';
  const mode = options.mode;

  const ui = {
    async select(): Promise<string | undefined> { return undefined; },
    async confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
      confirmations.push({ title, message, ...(dialogOptions === undefined ? {} : { options: dialogOptions }) });
      return options.confirm ? options.confirm(title, message, dialogOptions) : false;
    },
    async input(): Promise<string | undefined> { return undefined; },
    async editor(): Promise<string | undefined> { return undefined; },
    notify(message: string, type: 'info' | 'warning' | 'error' = 'info'): void {
      notifications.push({ message, type });
    },
    setStatus(key: string, text: string | undefined): void { statusValues.set(key, text); },
    setWorkingMessage(): void {},
    setWorkingVisible(): void {},
    setWorkingIndicator(): void {},
    setHiddenThinkingLabel(): void {},
    setWidget(): void {},
    setFooter(): void {},
    setHeader(): void {},
    setTitle(): void {},
    async custom(): Promise<undefined> { return undefined; },
    pasteToEditor(): void {},
    setEditorText(): void {},
    getEditorText(): string { return ''; },
    addAutocompleteProvider(): void {},
    setEditorComponent(): void {},
    getEditorComponent(): undefined { return undefined; },
    getAllThemes(): never[] { return []; },
    getTheme(): undefined { return undefined; },
    setTheme(): { success: false; error: string } { return { success: false, error: 'Unavailable in fake pi.' }; },
    getToolsExpanded(): boolean { return false; },
    setToolsExpanded(): void {},
    onTerminalInput(): () => void { return () => undefined; },
  };

  const context = {
    ui,
    mode,
    hasUI: mode === 'tui' || mode === 'rpc',
    cwd: options.cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [],
      getEntries: () => [],
      getSessionFile: () => undefined,
    },
    modelRegistry: {},
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => effectivePrompt(systemPromptOptions),
  } as unknown as ExtensionContext;

  const api = {
    __testTrace: { handlers, tools, statusValues, notifications, confirmations, toolTexts },
    on(event: string, handler: Handler): () => void {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter(item => item !== handler));
      };
    },
    registerTool(tool: CapturedTool): void {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;

  async function invoke(eventName: string, event: Record<string, unknown>): Promise<void> {
    for (const handler of handlers.get(eventName) ?? []) await handler(event, context);
  }

  return {
    api,
    async startSession(): Promise<void> {
      await invoke('session_start', { type: 'session_start', reason: 'startup' });
    },
    async beforeAgentStart(prompt: string): Promise<NormalizedBuildSystemPromptOptions> {
      const promptOptions = makePromptOptions(options.cwd);
      const event: Record<string, unknown> = {
        type: 'before_agent_start',
        prompt,
        get systemPrompt() { return effectivePrompt(promptOptions); },
        systemPromptOptions: promptOptions,
      };
      for (const handler of handlers.get('before_agent_start') ?? []) {
        const result = await handler(event, context) as { systemPrompt?: string } | undefined;
        if (result?.systemPrompt !== undefined) promptOptions.forceSystemPrompt = result.systemPrompt;
      }
      systemPromptOptions = promptOptions;
      await invoke('agent_start', { type: 'agent_start' });
      return promptOptions;
    },
    async callTool(args: Record<string, unknown>): Promise<unknown> {
      const tool = tools.get('pi_context');
      if (!tool) throw new Error('The pi_context tool is not registered.');
      const result = await tool.execute(
        'fake-tool-call',
        args as any,
        undefined,
        undefined,
        context,
      );
      const text = result.content.find(item => item.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('The fake tool result has no text envelope.');
      toolTexts.push(text);
      const jsonStart = text.indexOf('{');
      if (jsonStart < 0) throw new Error('The fake tool result has no JSON envelope.');
      return JSON.parse(text.slice(jsonStart)) as unknown;
    },
  };

  function effectivePrompt(value: NormalizedBuildSystemPromptOptions | undefined): string {
    if (!value) return '';
    if (typeof value.forceSystemPrompt === 'string') return value.forceSystemPrompt;
    return Object.entries(value.sections)
      .map(([name, section]) => `<${name}>${section}</${name}>`)
      .join('\n');
  }
}

function makePromptOptions(cwd: string): NormalizedBuildSystemPromptOptions {
  return {
    cwd,
    selectedTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    promptGuidelines: [],
    appendSystemPrompt: '',
    sections: {},
    contextFiles: [],
    skills: [],
  };
}

import { config } from './config.js';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type Msg = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Part[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Strip reasoning blocks some models leak into the content. */
export function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|channel>thought[\s\S]*?<channel\|>/g, '')
    .trim();
}

export async function chatCompletion(
  messages: Msg[],
  tools?: ToolDef[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<Msg> {
  const body: Record<string, unknown> = {
    model: config.llmModel,
    messages,
    temperature: opts.temperature ?? config.temperature,
    max_tokens: opts.maxTokens ?? config.maxTokens,
    stream: false,
  };
  if (tools?.length) body.tools = tools;
  if (!config.thinking) body.chat_template_kwargs = { enable_thinking: false };

  let res: Response;
  try {
    res = await fetch(`${config.llmUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000), // local prefill can be slow
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(
      `Cannot reach the LLM server at ${config.llmUrl} (${cause?.code ?? cause?.message ?? (e as Error).message}). ` +
        'Is llama-server running, on that port, and listening on 0.0.0.0 if the bot runs in Docker?',
    );
  }
  if (!res.ok) throw new Error(`LLM server returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: Msg }[] };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('LLM server returned no message');
  return { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls };
}

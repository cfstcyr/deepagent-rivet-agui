import { actor, setup } from "rivetkit";
import { ChatOpenAI } from "@langchain/openai";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { createEmbedServer, type ThreadSaver } from "@langchain/langgraph-api/experimental/embed";
import { getRuntimeGraphSchema } from "@langchain/langgraph-api/schema";
import { Client } from "@langchain/langgraph-sdk";
import { LangGraphAgent } from "@ag-ui/langgraph";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import { HTTPException } from "hono/http-exception";
import type { Subscription } from "rxjs";

function createAguiAgent() {
  const model = new ChatOpenAI({
    model: "openai/gpt-oss-120b:nitro",
    apiKey: process.env.OPENROUTER_API_KEY,
    configuration: { baseURL: "https://openrouter.ai/api/v1" },
  });
  // .graph is the compiled StateGraph (a Pregel), which is what the embed server and schema helper expect.
  const graph = createDeepAgent({ model, systemPrompt: "You are a concise assistant. Plan with write_todos before answering." }).graph;

  // langgraph-api exports no in-memory ThreadSaver. get() must 404 so @ag-ui/langgraph creates the thread.
  const saved = new Map<string, any>();
  const threads: ThreadSaver = {
    get: async (id) => saved.get(id) ?? Promise.reject(new HTTPException(404)),
    set: async (id, { metadata }) => {
      const thread = { thread_id: id, metadata: { ...saved.get(id)?.metadata, ...metadata } };
      saved.set(id, thread);
      return thread;
    },
    delete: async (id) => void saved.delete(id),
  };
  const app = createEmbedServer({ graph: { agent: graph }, threads, checkpointer: new MemorySaver() });

  // The embed server has no /assistants routes; @ag-ui/langgraph calls these three.
  const assistant = { assistant_id: "agent", graph_id: "agent", config: {} };
  app.post("/assistants/search", (c) => c.json([assistant]));
  app.get("/assistants/:id/graph", async (c) => c.json((await graph.getGraphAsync()).toJSON()));
  app.get("/assistants/:id/schemas", async (c) => {
    const s = await getRuntimeGraphSchema(graph);
    // output_schema also decides which state keys (files, todos) appear in STATE_SNAPSHOT.
    return c.json({ input_schema: s?.input, output_schema: s?.output, config_schema: s?.config });
  });

  // Real SDK client, but its HTTP goes straight into the Hono app (no socket).
  const client = new Client({ apiUrl: "http://embedded", apiKey: null, callerOptions: { fetch: (url: string, init: RequestInit) => app.fetch(new Request(url, init)) } });
  return new LangGraphAgent({ client, graphId: "agent", deploymentUrl: "http://embedded", emitRawEvents: false });
}

const agent = actor({
  options: { sleepTimeout: 10 * 60_000 },
  createVars: () => ({ agui: createAguiAgent() }),
  onRequest: async (c, request) => {
    const input = RunAgentInputSchema.parse(await request.json());
    const encoder = new EventEncoder();
    // clone() per request: LangGraphAgent keeps per-run state on the instance (and is typed as returning any).
    const agui = c.vars.agui.clone() as LangGraphAgent;
    let sub: Subscription;
    const body = new ReadableStream({
      start: (ctrl) => {
        sub = agui.run(input).subscribe({
          next: (event) => ctrl.enqueue(encoder.encodeBinary(event)),
          error: (err) => ctrl.error(err),
          complete: () => ctrl.close(),
        });
      },
      // Client disconnected: cancel the LangGraph run and stop writing to the closed stream.
      cancel: () => { agui.abortRun(); sub.unsubscribe(); },
    });
    return new Response(body, { headers: { "Content-Type": encoder.getContentType() } });
  },
});

export const registry = setup({ use: { agent } });
registry.start();

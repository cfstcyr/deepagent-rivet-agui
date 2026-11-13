# Deep agent in a Rivet Actor, spoken to over AG-UI

Status: done (2026-11-13)

## Question

Can a LangChain deep agent (`deepagents`) run inside a Rivet Actor, one actor per AG-UI `threadId`, with a
plain AG-UI client (`@ag-ui/client` `HttpAgent`) talking to it over POST `RunAgentInput` → SSE, using
libraries for all protocol mapping and only glue code of our own?

## How to run

Node 24 through mise. `.env` must hold `OPENROUTER_API_KEY`.

```sh
mise exec -- npm install
mise exec -- npm run server   # spawns the local Rivet Engine on 127.0.0.1:6420 (data in ./.rivetkit)
mise exec -- npm run client   # in another terminal
```

Stop the server with Ctrl-C: it stops the engine and `rivet-services` too.

Files: `src/server.ts` (76 lines: deep agent, embed server, AG-UI adapter, actor, registry),
`src/client.ts` (21 lines).

## Result

It works end to end. Real client output (unedited):

```
> Use write_todos to plan, then save a random animal and a random color to /pick.txt with write_file. Tell me both in one short sentence.
[tool call] write_file
[tool result] Successfully wrote to '/pick.txt'
Your random animal is an **axolotl** and the random color is **emerald**.

> Without using tools: which animal and color did you pick in your previous answer?
I chose the animal **axolotl** and the color **emerald**.
```

- Text streams as `TEXT_MESSAGE_CONTENT` deltas. Tool calls cross the wire as
  `TOOL_CALL_START/ARGS/END` and `TOOL_CALL_RESULT`. `STEP_*`, `STATE_SNAPSHOT` (includes the deep agent's
  `files`), `MESSAGES_SNAPSHOT`, `RUN_STARTED/FINISHED` and `RAW` events arrive too.
- Memory is server-side: the client builds a new `HttpAgent` for each turn, so turn 2 only sends the new
  question. The answer can only come from the actor's `MemorySaver`.
- The client POSTs straight to the Rivet gateway. The actor key is the thread id, so each thread gets its
  own actor. No proxy needed.
- Everything binds 127.0.0.1: engine 6420 (gateway), 6421 and 6430; `rivet-services` 8642.

## Conclusion

Feasible, with little glue. The chain inside one actor:

```
HttpAgent ──POST /gateway/agent/request/agui?rvt-key=<threadId>──▶ Rivet Engine ──▶ actor onRequest
  RunAgentInputSchema.parse → LangGraphAgent.clone().run(input) → EventEncoder → SSE Response
  LangGraphAgent ── @langchain/langgraph-sdk Client (fetch = embedApp.fetch, no socket) ──▶ createEmbedServer
  createEmbedServer ──▶ deep agent graph + MemorySaver
```

Library vs glue:

| Library (does the protocol work) | Our glue |
|---|---|
| `@ag-ui/langgraph` `LangGraphAgent`: LangGraph stream → AG-UI events, thread/state handling | Map-based `ThreadSaver` (3 lines; none is exported) |
| `@langchain/langgraph-api/experimental/embed`: Agent Server threads/runs routes in-process | 3 `/assistants` routes the embed server lacks. They return the real graph (`getGraphAsync`) and real schemas (`getRuntimeGraphSchema` from `@langchain/langgraph-api/schema`) |
| `@langchain/langgraph-sdk` `Client` | `callerOptions.fetch` pointing at the Hono app |
| `@ag-ui/core/schemas` `RunAgentInputSchema`, `@ag-ui/encoder` `EventEncoder` | Observable → `ReadableStream` → `Response` (8 lines) |
| `rivetkit` actor, gateway routing by key, local engine | `actor({ createVars, onRequest })`, `setup().start()` |
| `@ag-ui/client` `HttpAgent` | the client loop |

No LangGraph event is mapped by hand.

Caveats:

- `createEmbedServer` is `@experimental` and does not follow semver. It also has no `/assistants`
  routes, hence the stub. `@ag-ui/langgraph` calls `assistants.search` (reads `assistant_id`, `graph_id`,
  `config`), `assistants.getGraph` (`nodes` drive the `STEP_*` events, `edges` are used to resume an interrupt) and
  `assistants.getSchemas` (reads `input/output/config/context_schema.properties` keys; `output_schema`
  decides which state keys, such as `files` and `todos`, appear in `STATE_SNAPSHOT`).
- Everything lives in actor `vars`: the graph, the `MemorySaver` and the thread map. They are lost when the
  actor sleeps (`sleepTimeout` raised to 10 min) or crashes. A real version needs a persistent checkpointer
  and thread store, for example on the actor's SQLite `db`.
- The gateway URL format (`/gateway/<actor>/request/<path>?rvt-namespace=…&rvt-method=getOrCreate&rvt-key=…&rvt-token=default`)
  comes from the rivetkit source, not from the docs. `rvt-token=default` only works on the local dev engine.
  The documented route is `client.agent.getOrCreate([threadId]).fetch(...)` from `rivetkit/client`, which
  needs a server-side proxy for a non-Rivet client.
- `LangGraphAgent.clone()` is typed `any`, so we cast it. We clone for each request because the adapter keeps
  per-run state on the instance.
- On client disconnect, the stream's `cancel` calls `abortRun()` (which calls `runs.cancel` on the embed
  server) and unsubscribes. Tested: the server survives a mid-run disconnect. Whether the graph run itself
  stops right away was not checked. Concurrent runs on the same thread are not rejected: the embed
  `/runs/stream` route doesn't check for an active run.
- `emitRawEvents` defaults to true, so every LangGraph event is also sent as `RAW`, which makes the stream
  heavy. Set `emitRawEvents: false` on `LangGraphAgent` to turn it off.
- `openai/gpt-oss-120b` often skips `write_todos`. Sometimes it prints the todo JSON as text instead of
  calling the tool. That comes from the model, not the transport: `write_file` is called reliably. Nothing
  Anthropic-specific got in the way. npm auto-installs `@langchain/anthropic` as a deepagents peer
  dependency, but it is unused.
- By default RivetKit stores engine data in `~/.rivetkit`. The `server` script sets
  `RIVETKIT_STORAGE_PATH=.` to keep it in `./.rivetkit` (gitignored).
- `tsx` doesn't typecheck. `tsc --strict` is clean except for `process`, because `@types/node` isn't
  installed.

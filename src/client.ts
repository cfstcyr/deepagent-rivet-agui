import { HttpAgent } from "@ag-ui/client";

const threadId = crypto.randomUUID();
// Rivet gateway: routes to the "agent" actor whose key is threadId (created on first request).
const url = `http://127.0.0.1:6420/gateway/agent/request/agui?rvt-namespace=default&rvt-method=getOrCreate&rvt-runner=default&rvt-key=${threadId}&rvt-crash-policy=sleep&rvt-token=default`;

for (const content of [
  "Use write_todos to plan, then save a random animal and a random color to /pick.txt with write_file. Tell me both in one short sentence.",
  "Without using tools: which animal and color did you pick in your previous answer?",
]) {
  // New HttpAgent per turn: it only sends the new message, so turn 2 can only remember through the actor's checkpointer.
  const agent = new HttpAgent({ url, threadId });
  console.log(`\n> ${content}`);
  agent.addMessage({ id: crypto.randomUUID(), role: "user", content });
  await agent.runAgent({}, {
    onTextMessageContentEvent: ({ event }) => void process.stdout.write(event.delta),
    onToolCallStartEvent: ({ event }) => void console.log(`[tool call] ${event.toolCallName}`),
    onToolCallResultEvent: ({ event }) => void console.log(`[tool result] ${event.content}`),
  });
  console.log();
}

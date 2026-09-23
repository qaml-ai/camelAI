import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CodeBlock, PageHeader } from "@/components/common";
import { useApi, type Model } from "@/lib/api";
import { Link } from "@/lib/router";

export function QuickstartPage() {
  const available = useApi<Model[]>("/v1/models?available=true");
  const url = location.origin;
  const model = available.data?.find(entry => entry.id === "anthropic/claude-sonnet-5")?.id ?? available.data?.[0]?.id ?? "anthropic/claude-sonnet-5";
  const typescript = `import { AgentRuntime, schema, tool } from "@qaml-ai/agent-runtime/node";

const runtime = new AgentRuntime({
  url: "${url}",
  apiKey: process.env.AGENT_RUNTIME_TOKEN, // an API token from this console
});

const agent = await runtime.createAgent({
  name: "Support triage",
  model: "${model}",
  systemPrompt: "You triage support tickets. Be concise.",
  idempotencyKey: "support-triage", // the same key returns the same agent
  tools: {
    open_tickets: tool({
      description: "List open support tickets",
      input: schema.Object({}),
      execute: () => db.openTickets(), // runs in your process, with your credentials
    }),
  },
  onEvent: event => console.log(event.type),
});

await agent.prompt("Which open tickets look urgent?");
console.log((await agent.history()).messages.at(-1));`;
  const python = `import asyncio, os
from agent_client import AgentRuntime, tool

@tool
async def open_tickets():
    """List open support tickets."""
    return await db.open_tickets()

async def main():
    async with AgentRuntime(url="${url}", api_key=os.environ["AGENT_RUNTIME_TOKEN"]) as runtime:
        agent = await runtime.create_agent(
            name="Support triage", model="${model}",
            system_prompt="You triage support tickets. Be concise.",
            idempotency_key="support-triage", tools=[open_tickets],
        )
        await agent.prompt("Which open tickets look urgent?")

asyncio.run(main())`;
  const rest = `export AGENT_RUNTIME_TOKEN=art_...   # from API tokens

# Add a provider key (checked with the provider, stored encrypted, never returned)
curl -X PUT ${url}/v1/providers/anthropic/key \\
  -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -H "Content-Type: application/json" \\
  -d '{"apiKey": "sk-ant-..."}'

# Models you can use now
curl "${url}/v1/models?available=true" -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN"

# Create an agent (tools run in your app through the SDK; REST-created agents can use code only)
curl -X POST ${url}/v1/agents -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" \\
  -H "Content-Type: application/json" -H "Idempotency-Key: support-triage" \\
  -d '{"name": "Support triage", "model": "${model}", "systemPrompt": "Be concise."}'

# Prompt it, then read the reply
curl -X POST ${url}/v1/agents/<id>/prompt -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" \\
  -H "Content-Type: application/json" -d '{"text": "Hello"}'
curl ${url}/v1/agents/<id>/history -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN"`;
  return (
    <>
      <PageHeader title="Quickstart" description={<>Create an agent from your application. First add a model key under <Link className="underline" to="models">Models &amp; keys</Link> and create an <Link className="underline" to="tokens">API token</Link>.</>} />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>1. Install the SDK</CardTitle>
            <CardDescription>
              The TypeScript SDK is in the qaml-ai GitHub Packages registry. You need access to the qaml-ai/camelAI repository and a GitHub token with <code className="font-mono">read:packages</code>. Requires Node 22+.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <CodeBlock language=".npmrc" code={"@qaml-ai:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}"} />
            <CodeBlock language="shell" code="GITHUB_TOKEN=<github token> npm install @qaml-ai/agent-runtime" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>2. Create an agent with your tools</CardTitle>
            <CardDescription>Your tools are ordinary functions in your process. The runtime runs the model loop, keeps history, and sandboxes model-written code that calls your tools.</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="typescript">
              <TabsList><TabsTrigger value="typescript">TypeScript</TabsTrigger><TabsTrigger value="python">Python</TabsTrigger><TabsTrigger value="rest">REST</TabsTrigger></TabsList>
              <TabsContent value="typescript" className="pt-3"><CodeBlock language="ts" code={typescript} /></TabsContent>
              <TabsContent value="python" className="pt-3"><CodeBlock language="python" code={python} /></TabsContent>
              <TabsContent value="rest" className="pt-3"><CodeBlock language="shell" code={rest} /></TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>3. Change models any time</CardTitle>
            <CardDescription>Switch an agent to another model between turns; its history carries over. Any model marked “Usable” under Models &amp; keys works.</CardDescription>
          </CardHeader>
          <CardContent><CodeBlock language="ts" code={`await agent.configure({ model: "${model}" });`} /></CardContent>
        </Card>
      </div>
    </>
  );
}

---
name: camelai-platform-faq
description: Answer common camelAI platform questions about app access/passwords, workspace resources, deployed links, connections, provider keys/credits, files, and support paths. Use when the user asks how camelAI itself works rather than asking you to build, debug, or analyze something.
---

# camelAI Platform FAQ

Give short, direct answers from this sheet. Do not guess beyond it.

## Getting help

The Get Help button is the question-mark icon at the bottom-left of the side nav. Submitting the form starts an email thread with the camelAI support team; the user gets a confirmation email and can reply to continue the conversation. The current page URL is captured automatically, so the user only needs to describe what they were doing, what happened, and what they expected.

Prompt the user to submit a Get Help request when:

- The question is not answered in this FAQ.
- The answer depends on their account, plan, or billing state.
- They are reporting a bug or something looks broken on camelAI's side.

## FAQs

### What is the difference between a public, private, and password-protected app?

A public app can be viewed by anyone on the internet with the app URL, while a
private app can only be viewed by signed-in members of your organization. This
per-app setting is available on hosted and self-hosted camelAI. A self-host
operator can still apply a deployment-wide ingress policy that requires SSO
before requests reach camelAI.

Password protection is not a separate camelAI visibility mode. An app-level
password gate can be built as an additional check, but it does not replace the
platform's access control.

### What is a workspace?

A workspace is a shared space inside your organization that holds chats, files, projects, connections, and deployed apps. Everything in a workspace is shared: any member with access to the workspace can use everything in it.

### What is the difference between a chat, a project, and an app?

A chat is a conversation with the agent. A project is where code is written and run. An app is the published result with its own URL. Changes to project files do not appear in the live app until it is deployed again.

### Where do my files live?

Files you upload in chat, files saved in the workspace, and files inside a project are separate places; I can copy files between them. Generated reports and downloads are served through workspace links.

### Why doesn't a report or download link work for someone else?

Report and download links are workspace-scoped: they require signing in with
access to the workspace. A public deployed app can be shared outside the
organization unless a self-host operator has applied a deployment-wide ingress
policy. Otherwise, send the file through an approved external channel.

### Can camelAI connect to external services?

Yes. Connections cover databases (Postgres, MySQL, Snowflake, MongoDB, and more), SaaS APIs (Stripe, Notion, GitHub, Slack, and more), and custom APIs. Credentials are stored encrypted and are never exposed in chat or app code. The agent and your apps call connections through secure bindings, so never paste API keys into app code.

### Are connections in chat the same as in deployed apps?

Yes. The agent in chat and your deployed apps use the same workspace connections through the same binding mechanism.

### Can I use camelAI by email, Slack, or Telegram?

Yes, all three. Each workspace has its own email address; emailing it starts a chat in that workspace, and only workspace members can use it. Slack and Telegram are set up per workspace through integrations.

### Can I set defaults for everyone in a workspace?

Model defaults can be set for the organization in settings, and a workspace can override them. For working preferences, such as "always use this database" or "format reports this way," ask me to save them in a workspace file so they persist across chats.

### How do hosted model credits and bring-your-own-key differ?

camelAI-hosted models consume your organization's camelAI credits. If you connect your own provider key (OpenAI, Anthropic, OpenRouter, and others), usage bills to that provider instead and does not consume camelAI credits. Your plan and credit balance are in Settings -> Organization -> Billing.

### Why is my API key or model provider failing?

Check whose limit it is. If the error names a provider (OpenAI, Anthropic, OpenRouter, Bedrock), the problem is on the provider side, such as an invalid key, rate limit, or exhausted provider credits, and is fixed in that provider's dashboard. If camelAI says you are out of credits, check Settings -> Organization -> Billing. If neither fits, submit a Get Help request.

### What if I am not sure about a camelAI product answer?

Say what you know, name the uncertainty, and prompt the user to submit a Get Help request. For app-specific technical failures, inspect the workspace/app state or use the relevant troubleshooting skill before answering.

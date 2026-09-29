/**
 * An OAuth connection that a chat's connection setup prompt started finishes.
 * The old in-DO chat loop waited on such a prompt; threads on the agent
 * runtime never do (prompt_connection_setup sends the user to the connections
 * page instead), so there is nothing left to resume: the connection is made,
 * and the flow goes on as if the prompt had been answered.
 */
export async function completeConnectionSetupPromptContext(
  _env: unknown,
  _context: { requestId: string; threadId: string },
  _integrationId: string,
  _integrationType: string,
  _integrationName: string,
): Promise<boolean> {
  return true;
}

export interface AppChatContextInput {
  scriptName: string;
  appUrl: string;
  projectId?: string | null;
}

/**
 * Hidden context sent when a user starts a chat from an app card. App source is
 * DO-backed project storage; never direct the agent toward retired VM checkouts
 * or Wrangler-file searches.
 */
export function buildAppWorkSystemMessage(input: AppChatContextInput): string {
  const projectId = input.projectId?.trim();
  const sourceInfo = projectId
    ? ` The source project id is "${projectId}". Use list_projects to resolve its project name, then inspect it with location "project".`
    : ' The source project is not linked in app metadata. Use list_projects and, if needed, list_apps from your code tool to match the app to a DO-backed project. Do not search VM or local filesystem paths.';
  return `<camelai system message>I'd like to work on the app "${input.scriptName}" at ${input.appUrl}.${sourceInfo}</camelai system message>`;
}

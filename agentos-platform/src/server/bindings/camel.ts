import { bindings, type Bindings } from "@rivet-dev/agentos-core";
import { z } from "zod";
import type { Platform } from "../platform/index.ts";

export type CamelAskUserPayload = {
  question: string;
  options: string[];
};

export type CreateCamelBindingsContext = {
  platform: Platform;
  orgId: string;
  workspaceId: string;
  projectId: string;
  broadcastAskUser?: (
    payload: CamelAskUserPayload,
  ) => void | Promise<void>;
};

export function createCamelBindings(
  context: CreateCamelBindingsContext,
): Bindings {
  const filesystem = context.platform.projectFilesystem(
    context.workspaceId,
    context.projectId,
  );

  return bindings({
    name: "camel",
    description: "camelAI workspace, deployment, preview, and billing tools",
    bindings: {
      read_file: {
        description: "Read a UTF-8 file from the current project.",
        inputSchema: z.object({ path: z.string().min(1) }),
        execute: ({ path }) => ({ path, content: filesystem.read(path) }),
      },
      write_file: {
        description: "Write a UTF-8 file in the current project.",
        inputSchema: z.object({
          path: z.string().min(1),
          content: z.string(),
        }),
        execute: ({ path, content }) => {
          filesystem.write(path, content);
          return { path, written: true };
        },
      },
      list_files: {
        description: "List files and directories in a project directory.",
        inputSchema: z.object({ path: z.string().optional() }),
        execute: ({ path }) => ({
          path: path ?? ".",
          entries: filesystem.ls(path),
        }),
      },
      ask_user: {
        description: "Queue a clarifying question for the chat UI.",
        inputSchema: z.object({
          question: z.string().min(1),
          options: z.array(z.string().min(1)),
        }),
        execute: async ({ question, options }) => {
          await context.broadcastAskUser?.({ question, options });
          return {
            status: "queued for UI",
            question,
            options,
          };
        },
      },
      deploy_project: {
        description: "Deploy or dry-run the current project.",
        inputSchema: z.object({
          projectId: z.string().min(1).optional(),
          dryRun: z.boolean().optional(),
        }),
        execute: ({ projectId, dryRun }) => {
          const deployedProjectId = projectId ?? context.projectId;
          return {
            projectId: deployedProjectId,
            dryRun: dryRun ?? false,
            url: `https://${deployedProjectId}.apps.local`,
          };
        },
      },
      set_preview: {
        description: "Select the URL displayed in the project preview.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: ({ url }) => ({ previewUrl: url }),
      },
      get_credits: {
        description: "Get the current organization credit balance in cents.",
        inputSchema: z.object({}),
        execute: () => ({
          orgId: context.orgId,
          creditCents: context.platform.billing.getCreditBalance(context.orgId),
        }),
      },
    },
  });
}

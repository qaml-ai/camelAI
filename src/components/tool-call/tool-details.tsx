"use client";

import type { ReactNode } from 'react';
import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { ReadDetails } from './details/read-details';
import { WriteDetails } from './details/write-details';
import { EditDetails } from './details/edit-details';
import { BashDetails } from './details/bash-details';
import { SearchDetails } from './details/search-details';
import { TaskDetails } from './details/task-details';
import { WebDetails } from './details/web-details';
import { TodoDetails } from './details/todo-details';
import { NotebookDetails } from './details/notebook-details';
import { GenericDetails } from './details/generic-details';
import { McpDetails } from './details/mcp-details';
import { SkillDetails } from './details/skill-details';
import { TeamCreateDetails } from './details/team-create-details';
import { AskUserQuestionDetails } from './details/ask-user-question-details';
import { JavaScriptDetails } from './details/javascript-details';
import { isAskUserQuestionToolName, isMcpTool } from './mcp-utils';

interface ToolCallDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  results?: ToolResultBlock[];
  skillSheet?: string;
  status?: 'running' | 'complete' | 'error';
}

function normalizeToolDetailsName(name?: string): string | undefined {
  switch (name) {
    case 'bash':
      return 'Bash';
    case 'write':
      return 'Write';
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'ls':
      return 'LS';
    case 'find':
      return 'Find';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'js_exec':
    case 'codemode':
      return 'JavaScript';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    case 'todo_write':
    case 'update_todo':
      return 'TodoWrite';
    default:
      return name;
  }
}

export function ToolCallDetails({ tool, result, results, skillSheet, status }: ToolCallDetailsProps) {
  const name = normalizeToolDetailsName(tool?.name);

  let content: ReactNode;
  if (tool && isAskUserQuestionToolName(name)) {
    content = <AskUserQuestionDetails tool={tool} result={result} />;
  } else if (tool && name && isMcpTool(name)) {
    content = <McpDetails tool={tool} result={result} />;
  } else switch (name) {
    case 'Skill':
      content = <SkillDetails tool={tool} result={result} skillSheet={skillSheet} />;
      break;
    case 'Read':
      content = <ReadDetails tool={tool} result={result} />;
      break;
    case 'Write':
      content = <WriteDetails tool={tool} />;
      break;
    case 'Edit':
      content = <EditDetails tool={tool} result={result} />;
      break;
    case 'Bash':
      content = <BashDetails tool={tool} result={result} />;
      break;
    case 'Glob':
      content = <SearchDetails tool={tool} result={result} mode="glob" />;
      break;
    case 'Grep':
      content = <SearchDetails tool={tool} result={result} mode="grep" />;
      break;
    case 'Task':
    case 'Agent':
    case 'agent':
    case 'Explore':
    case 'explore':
    case 'Research':
    case 'Oracle':
    case 'TaskOutput':
      content = (
        <TaskDetails
          tool={tool}
          result={result}
          results={results}
          status={status}
        />
      );
      break;
    case 'WebFetch':
      content = <WebDetails tool={tool} result={result} mode="fetch" />;
      break;
    case 'WebSearch':
      content = <WebDetails tool={tool} result={result} mode="search" />;
      break;
    case 'JavaScript':
      content = <JavaScriptDetails tool={tool} result={result} />;
      break;
    case 'TodoWrite':
      content = <TodoDetails tool={tool} result={result} />;
      break;
    case 'NotebookEdit':
      content = <NotebookDetails tool={tool} />;
      break;
    case 'TeamCreate':
      content = <TeamCreateDetails tool={tool} result={result} />;
      break;
    default:
      content = <GenericDetails tool={tool} result={result} />;
  }

  // A result the runtime cut for the model: its whole text is in the thread's scratch space.
  const fullResult = result?.details?.fullResult as { href?: unknown } | undefined;
  return (
    <div className="ml-1 mt-1 border-l border-border/50 pl-4 text-xs text-muted-foreground/80">
      {content}
      {typeof fullResult?.href === 'string' ? (
        <a
          href={fullResult.href}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block underline underline-offset-2 hover:text-foreground"
        >
          View full result
        </a>
      ) : null}
    </div>
  );
}

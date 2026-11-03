import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JavaScriptDetails } from '@/components/tool-call/details/javascript-details';
import type { ToolResultBlock, ToolUseBlock } from '@/types';

describe('JavaScriptDetails', () => {
  it('shows the tool description when provided', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_js_exec',
      name: 'JavaScript',
      input: {
        description: 'checking database connection',
        code: 'return await env.CONNECTIONS.test("postgres");',
      },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_js_exec',
      content: 'ok',
    };

    render(<JavaScriptDetails tool={tool} result={result} />);

    expect(screen.getByText('Description:')).toBeInTheDocument();
    expect(screen.getByText('checking database connection')).toBeInTheDocument();
  });

  it("reads codemode's options line and its Script completed header", () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_codemode',
      name: 'JavaScript',
      input: {
        code: '// @options: {"timeout_ms": 30000, "max_output_tokens": 2000}\nreturn [{ id: 1, name: "a" }];',
      },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_codemode',
      content: [
        { type: 'text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' },
        { type: 'text', text: '[{"id":1,"name":"a"}]' },
      ],
    };

    render(<JavaScriptDetails tool={tool} result={result} />);

    expect(screen.getByText('30000ms')).toBeInTheDocument();
    expect(screen.getByText('2000 tokens')).toBeInTheDocument();
    expect(screen.getByText('0.4 seconds')).toBeInTheDocument();
    // The output after the header is still read as a table.
    expect(screen.getByRole('columnheader', { name: 'name' })).toBeInTheDocument();
  });

  it('renders captured code-mode function calls as nested tool rows', () => {
    const tool: ToolUseBlock = {
      type: 'tool_use',
      id: 'tool_js_exec',
      name: 'JavaScript',
      input: {
        code: 'await tools.send_email({ to: "alice@example.com" });',
      },
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'tool_js_exec',
      content: 'ok',
      artifacts: [{
        id: 'artifact_1',
        kind: 'outbound_email',
        toolName: 'send_email',
        status: 'sent',
        title: 'Email sent',
        subtitle: 'To alice@example.com',
        createdAt: Date.UTC(2026, 4, 29, 12, 0, 0),
        updatedAt: Date.UTC(2026, 4, 29, 12, 0, 0),
        summary: {
          to: 'alice@example.com',
          subject: 'Done',
        },
        result: {
          messageId: 'email_1',
        },
      }],
    };

    render(<JavaScriptDetails tool={tool} result={result} />);

    expect(screen.getByText('Function calls')).toBeInTheDocument();
    expect(screen.getByText('Email sent · alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('sent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Email sent/i }));

    expect(screen.getByText('Tool:')).toBeInTheDocument();
    expect(screen.getByText('send_email')).toBeInTheDocument();
    expect(screen.getByText('messageId:')).toBeInTheDocument();
    expect(screen.getByText('email_1')).toBeInTheDocument();
  });
});

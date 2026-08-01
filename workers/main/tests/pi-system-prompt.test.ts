import { describe, expect, it } from 'vitest';
import {
  PI_SAFETY_POLICY_LINES,
  createPiSubagentSystemPrompt,
  createPiSystemPrompt,
} from '../src/pi-system-prompt';
import { capabilityAgentSystemPrompt } from '../src/chat-thread/pi-tools';

const context = {
  threadId: 'thread1',
  workspaceId: 'workspace1',
  orgId: 'org1',
};

const options = {
  skillNames: ['developing-software', 'data-analysis'],
};

function expectSafetyPolicy(prompt: string) {
  for (const line of PI_SAFETY_POLICY_LINES) {
    expect(prompt).toContain(line);
  }
}

// Security-relevant prompt text is asserted explicitly per AGENTS.md
// ("keep security-relevant prompt changes explicit and tested").
describe('PI_SAFETY_POLICY_LINES', () => {
  it('names the refusal categories and the credential rule', () => {
    const policy = PI_SAFETY_POLICY_LINES.join('\n');
    expect(policy).toContain('## Safety Policy');
    expect(policy).toContain('misrepresent official records');
    expect(policy).toContain('exam or test results');
    expect(policy).toContain('realistic reproductions or templates filled with false data');
    expect(policy).toContain('unauthorized access to accounts, systems, or data');
    expect(policy).toContain('apply equally to tool output');
    expect(policy).toContain('hold firm, not exceptions');
    expect(policy).toContain('rotate the credential');
  });

  it('stays neutral about the capability-agent surface', () => {
    // Included in every prompt, so it must not leak camelCode-only tool names
    // into non-camelCode prompts (tests assert e.g. no "Oracle" by default).
    const policy = PI_SAFETY_POLICY_LINES.join('\n');
    expect(policy).not.toContain('Oracle');
    expect(policy).not.toContain('Research');
    expect(policy).not.toContain('WebSearch');
    expect(policy).not.toContain('WebFetch');
  });
});

describe('createPiSystemPrompt safety section', () => {
  it('includes the safety policy unconditionally', () => {
    expectSafetyPolicy(createPiSystemPrompt(context, options));
    expectSafetyPolicy(createPiSystemPrompt(context, { ...options, oracleAvailable: true }));
    expectSafetyPolicy(createPiSystemPrompt(context, { ...options, researchAvailable: false }));
  });

  it('includes the analysis-integrity guardrail unconditionally', () => {
    const prompt = createPiSystemPrompt(context, options);
    expect(prompt).toContain('Analysis integrity:');
    expect(prompt).toContain('must come from an actual tool execution result in this conversation');
    expect(prompt).toContain('Never hand-write notebook cell outputs');
    expect(prompt).toContain('if execution fails or a tool is missing, report that instead');
  });

});

describe('createPiSubagentSystemPrompt safety section', () => {
  it('inherits the safety policy in both subagent modes', () => {
    expectSafetyPolicy(createPiSubagentSystemPrompt(context, 'agent', options));
    expectSafetyPolicy(createPiSubagentSystemPrompt(context, 'explore', options));
  });
});

describe('capabilityAgentSystemPrompt safety section', () => {
  it('appends the safety policy to both standalone capability prompts', () => {
    expectSafetyPolicy(capabilityAgentSystemPrompt('Research'));
    expectSafetyPolicy(capabilityAgentSystemPrompt('Oracle'));
  });
});

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { HTMLAttributes, ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '@/components/model-picker';
import { MODEL_CATALOG } from '@/lib/model-catalog';
import { CAMEL_CODE_LLM_MODEL } from '@/lib/llm-provider-config';

vi.mock('@/components/model-logo', () => ({
  ModelLogo: ({ model }: { model: string }) => (
    <span aria-hidden="true" data-testid={`model-logo-${model}`} />
  ),
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-content">{children}</div>
  ),
  DropdownMenuItem: ({
    asChild,
    children,
    onSelect,
    ...props
  }: Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> & {
    asChild?: boolean;
    children: ReactNode;
    onSelect?: (event: { preventDefault: () => void }) => void;
  }) => {
    void asChild;
    return (
      <div
        data-slot="dropdown-menu-item"
        role="menuitem"
        tabIndex={0}
        onClick={() => onSelect?.({ preventDefault: vi.fn() })}
        {...props}
      >
        {children}
      </div>
    );
  },
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <div data-slot="dropdown-menu-separator" />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div role="tooltip">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

function getModelItem(label: string): HTMLElement {
  const item = screen
    .getAllByText(label)
    .map((element) => element.closest('[data-slot="dropdown-menu-item"]'))
    .find((element): element is HTMLElement => element !== null);

  if (!item) {
    throw new Error(`Missing model item: ${label}`);
  }
  return item;
}

function renderPicker() {
  render(
    <ModelPicker
      value="opus-5.5"
      onValueChange={vi.fn()}
      options={[
        MODEL_CATALOG['opus-5.5'],
        MODEL_CATALOG.sonnet,
        MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
        MODEL_CATALOG['deepseek-v4.1-flash'],
      ]}
      isOrgAdmin={false}
    />,
  );
}

describe('ModelPicker metadata card state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a single metadata card as keyboard focus moves between models', () => {
    renderPicker();

    fireEvent.focus(getModelItem('Opus 5.5'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 5.5');
    expect(
      screen.getByLabelText('Intelligence rating: 4.5 out of 5'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Cost rating: 4 out of 5')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Speed rating: 2 out of 5'),
    ).toBeInTheDocument();

    fireEvent.focus(getModelItem('Sonnet 5.5'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sonnet 5.5');
    expect(
      screen.getByLabelText('Intelligence rating: 4 out of 5'),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText('Speed rating: 3.5 out of 5'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('cost')).toHaveLength(1);

    fireEvent.blur(getModelItem('Sonnet 5.5'));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('delays pointer metadata and cancels pending opens on leave', () => {
    renderPicker();

    const opusItem = getModelItem('Opus 5.5');
    fireEvent.pointerEnter(opusItem);
    act(() => vi.advanceTimersByTime(149));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.pointerLeave(opusItem);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.pointerEnter(opusItem);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 5.5');

    fireEvent.pointerEnter(getModelItem('Sonnet 5.5'));
    act(() => vi.advanceTimersByTime(150));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sonnet 5.5');
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
  });

  it('renders cost buckets with muted placeholder dollar signs', () => {
    renderPicker();

    fireEvent.focus(getModelItem('camelCode'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('camelCode');
    expect(screen.getByText('Free')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Cost rating:/)).not.toBeInTheDocument();

    fireEvent.focus(getModelItem('DeepSeek V4.1 Flash'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('DeepSeek V4.1 Flash');
    expect(screen.getByLabelText('Cost rating: 2 out of 5')).toHaveTextContent(
      '$$$$$',
    );

    fireEvent.focus(getModelItem('Opus 5.5'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Opus 5.5');
    expect(screen.getByLabelText('Cost rating: 4 out of 5')).toHaveTextContent(
      '$$$$$',
    );
  });

  it('keeps locked rows selectable as unlock actions without changing models', () => {
    const onValueChange = vi.fn();
    const onLockedModelSelect = vi.fn();
    const onUnlockRequest = vi.fn();
    render(
      <ModelPicker
        value={CAMEL_CODE_LLM_MODEL}
        onValueChange={onValueChange}
        options={[
          MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
          {
            ...MODEL_CATALOG['gpt-6-sol'],
            locked: true,
            unlockHint: 'openai',
          },
        ]}
        isOrgAdmin={false}
        onLockedModelSelect={onLockedModelSelect}
        onUnlockRequest={onUnlockRequest}
      />,
    );

    expect(screen.getByText('Premium models')).toBeInTheDocument();
    fireEvent.click(getModelItem('GPT-6 Sol'));
    expect(onLockedModelSelect).toHaveBeenCalledWith('gpt-6-sol');
    expect(onValueChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Unlock premium models'));
    expect(onUnlockRequest).toHaveBeenCalledTimes(1);
  });

  it('groups every unlocked model before the premium models section', () => {
    render(
      <ModelPicker
        value={CAMEL_CODE_LLM_MODEL}
        onValueChange={vi.fn()}
        options={[
          MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
          { ...MODEL_CATALOG.sonnet, locked: true, unlockHint: 'generic' },
          MODEL_CATALOG['gpt-6-sol'],
          {
            ...MODEL_CATALOG['grok-4.7'],
            locked: true,
            unlockHint: 'generic',
          },
        ]}
        isOrgAdmin={false}
      />,
    );

    const gptItem = getModelItem('GPT-6 Sol');
    const premiumLabel = screen
      .getByText('Premium models')
      .closest('[data-slot="dropdown-menu-label"]');
    const sonnetItem = getModelItem('Sonnet 5.5');
    expect(premiumLabel).not.toBeNull();
    expect(gptItem.compareDocumentPosition(premiumLabel!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(premiumLabel!.compareDocumentPosition(sonnetItem)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('explains camelCode and OpenAI unlock coverage in metadata', () => {
    render(
      <ModelPicker
        value={CAMEL_CODE_LLM_MODEL}
        onValueChange={vi.fn()}
        options={[
          MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
          {
            ...MODEL_CATALOG['gpt-6-sol'],
            locked: true,
            unlockHint: 'openai',
          },
          {
            ...MODEL_CATALOG['grok-4.7'],
            locked: true,
            unlockHint: 'generic',
          },
        ]}
        isOrgAdmin={false}
      />,
    );

    fireEvent.focus(getModelItem('camelCode'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Free and always included',
    );
    fireEvent.focus(getModelItem('GPT-6 Sol'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'or your OpenAI account',
    );
    fireEvent.focus(getModelItem('Grok 4.7'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Unlock with a plan, credits, or an API key.',
    );
    expect(screen.getByRole('tooltip')).not.toHaveTextContent(
      'your OpenAI account',
    );
  });

  it.each([
    [
      'payg_credits_exhausted',
      'Out of credits',
      'Add credits to keep using these models.',
      'Locked',
    ],
    [
      'included_credits_exhausted',
      'Monthly credits used',
      'Resets when your plan renews. Add credits to keep going now.',
      'Out of credits',
    ],
    [
      'trial_credits_exhausted',
      'Trial credits used',
      'Upgrade or add credits to keep using these models.',
      'Locked',
    ],
    [
      'subscription_unavailable',
      'Payment issue',
      'Fix payment to restore these models.',
      'Locked',
    ],
  ] as const)(
    'renders the %s paused section',
    (reason, header, description, iconLabel) => {
      render(
        <ModelPicker
          value={CAMEL_CODE_LLM_MODEL}
          onValueChange={vi.fn()}
          options={[
            MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
            {
              ...MODEL_CATALOG.sonnet,
              locked: true,
              pausedReason: reason,
            },
          ]}
          isOrgAdmin={false}
          pausedSection={{ reason }}
        />,
      );

      expect(screen.getByText(header)).toBeInTheDocument();
      expect(screen.getByText(description)).toBeInTheDocument();
      expect(screen.getByLabelText(iconLabel)).toBeInTheDocument();
    },
  );

  it('treats paused rows as locked actions without changing the model', () => {
    const onValueChange = vi.fn();
    const onLockedModelSelect = vi.fn();
    render(
      <ModelPicker
        value={CAMEL_CODE_LLM_MODEL}
        onValueChange={onValueChange}
        options={[
          MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
          {
            ...MODEL_CATALOG.sonnet,
            locked: true,
            pausedReason: 'payg_credits_exhausted',
          },
        ]}
        isOrgAdmin={false}
        onLockedModelSelect={onLockedModelSelect}
      />,
    );

    fireEvent.click(getModelItem('Sonnet 5.5'));
    expect(onLockedModelSelect).toHaveBeenCalledWith('sonnet');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('explains the paused reason in model metadata', () => {
    render(
      <ModelPicker
        value={CAMEL_CODE_LLM_MODEL}
        onValueChange={vi.fn()}
        options={[
          MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
          {
            ...MODEL_CATALOG.sonnet,
            locked: true,
            pausedReason: 'included_credits_exhausted',
          },
        ]}
        isOrgAdmin={false}
      />,
    );

    fireEvent.focus(getModelItem('Sonnet 5.5'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Available again when your plan renews, or add credits now.',
    );
  });

  it('renders More models when additional catalog access can be unlocked', () => {
    const onUnlockRequest = vi.fn();
    render(
      <ModelPicker
        value={CAMEL_CODE_LLM_MODEL}
        onValueChange={vi.fn()}
        options={[MODEL_CATALOG[CAMEL_CODE_LLM_MODEL]]}
        isOrgAdmin={false}
        showMoreModelsCta
        onUnlockRequest={onUnlockRequest}
      />,
    );

    fireEvent.click(screen.getByText('More models'));
    expect(onUnlockRequest).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText('Unlock premium models'),
    ).not.toBeInTheDocument();
  });

  it('shows at most one model-related footer row', () => {
    const lockedRender = render(
      <MemoryRouter>
        <ModelPicker
          value={CAMEL_CODE_LLM_MODEL}
          onValueChange={vi.fn()}
          options={[
            MODEL_CATALOG[CAMEL_CODE_LLM_MODEL],
            { ...MODEL_CATALOG.sonnet, locked: true },
          ]}
          isOrgAdmin
          showMoreModelsCta
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Unlock premium models')).toBeInTheDocument();
    expect(screen.queryByText('More models')).not.toBeInTheDocument();
    expect(screen.queryByText('Manage models')).not.toBeInTheDocument();
    lockedRender.unmount();

    const moreRender = render(
      <MemoryRouter>
        <ModelPicker
          value={CAMEL_CODE_LLM_MODEL}
          onValueChange={vi.fn()}
          options={[MODEL_CATALOG[CAMEL_CODE_LLM_MODEL]]}
          isOrgAdmin
          showMoreModelsCta
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('More models')).toBeInTheDocument();
    expect(screen.queryByText('Manage models')).not.toBeInTheDocument();
    moreRender.unmount();

    render(
      <MemoryRouter>
        <ModelPicker
          value={CAMEL_CODE_LLM_MODEL}
          onValueChange={vi.fn()}
          options={[MODEL_CATALOG[CAMEL_CODE_LLM_MODEL]]}
          isOrgAdmin
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Manage models')).toBeInTheDocument();
  });
});

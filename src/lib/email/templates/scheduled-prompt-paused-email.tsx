import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';

export interface ScheduledPromptPausedEmailTemplateProps {
  scheduleName: string;
  workspaceName: string | null;
  billingError: string;
  automationsUrl: string | null;
}

const containerStyle = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  lineHeight: '1.5',
  color: '#111827',
  margin: '0 auto',
  maxWidth: '560px',
  padding: '24px',
};

const buttonStyle = {
  backgroundColor: '#111827',
  borderRadius: '8px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '14px',
  fontWeight: '600',
  padding: '10px 16px',
  textDecoration: 'none',
};

const errorBoxStyle = {
  backgroundColor: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  color: '#6b7280',
  fontSize: '13px',
  padding: '12px 16px',
};

export function ScheduledPromptPausedEmailTemplate({
  scheduleName,
  workspaceName,
  billingError,
  automationsUrl,
}: ScheduledPromptPausedEmailTemplateProps) {
  return (
    <Html>
      <Head />
      <Preview>{`Your scheduled prompt "${scheduleName}" was paused after repeated billing failures`}</Preview>
      <Body>
        <Container style={containerStyle}>
          <Text>Hi,</Text>
          <Text>
            camelAI paused your scheduled prompt <strong>{scheduleName}</strong>
            {workspaceName ? (
              <>
                {' '}
                in workspace <strong>{workspaceName}</strong>
              </>
            ) : null}{' '}
            because its last several runs failed with a billing error:
          </Text>

          <Section style={errorBoxStyle}>
            <Text style={{ margin: 0 }}>{billingError}</Text>
          </Section>

          <Text>
            The schedule will not run again until you resume it. To get it running again, resolve
            the billing issue (for example by topping up credits or updating your subscription),
            then re-enable the schedule from the Automations page.
          </Text>

          {automationsUrl ? (
            <>
              <Section style={{ margin: '24px 0' }}>
                <Button href={automationsUrl} style={buttonStyle}>
                  Open Automations
                </Button>
              </Section>
              <Text>
                Or copy and paste this link:
                <br />
                <Link href={automationsUrl}>{automationsUrl}</Link>
              </Text>
            </>
          ) : null}

          <Hr />
          <Text>
            You are receiving this because you created this scheduled prompt on camelAI.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

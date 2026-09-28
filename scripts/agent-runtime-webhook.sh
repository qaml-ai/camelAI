#!/usr/bin/env bash
# Point a chiridion deployment's runtime tenant at its /agent-runtime/events
# endpoint, which takes the run, input and usage events
# (routes/agent-runtime-events.ts). Neither the operator token nor a signing
# secret is printed.
#
#   scripts/agent-runtime-webhook.sh register staging|prod
#     Register the endpoint for every event chiridion handles, and store its
#     signing secret as the worker's AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET. Run
#     it once per deployment: each run makes another endpoint.
#
#   scripts/agent-runtime-webhook.sh subscribe-usage staging|prod
#     Move usage off the legacy usage webhook: add usage.recorded to the
#     existing endpoint, then delete the legacy /v1/usage-webhook. Run it right
#     after chiridion with the usage.recorded handler is deployed. Between the
#     two calls both deliver, but the legacy receiver (/agent-runtime/usage) is
#     gone by then, so nothing is counted twice. Deleting the legacy webhook
#     also drops its undelivered events; with the receiver gone those were
#     never going to be recorded. Against a build that still has the legacy
#     receiver, do not run this: that build records usage only from it.
#
# Run from a chiridion checkout (for wrangler), with AWS credentials that can
# read the tenant's operator token (TOKEN_SECRET_ID overrides where it is).
set -euo pipefail

usage() { echo "usage: $0 register|subscribe-usage staging|prod" >&2; exit 2; }
[ $# -eq 2 ] || usage
action="$1"
target="$2"

case "$target" in
  staging)
    ENDPOINT_URL="${ENDPOINT_URL:-https://staging.camelai.dev/agent-runtime/events}"
    TOKEN_SECRET_ID="${TOKEN_SECRET_ID:-camelai/agent-runtime/operator-token/chiridion-staging}"
    WORKER_NAME="chiridion-app-staging"   # staging is its own worker, not a wrangler --env
    ;;
  prod)
    ENDPOINT_URL="${ENDPOINT_URL:-https://camelai.dev/agent-runtime/events}"
    TOKEN_SECRET_ID="${TOKEN_SECRET_ID:-camelai/agent-runtime/operator-token/chiridion-prod}"
    WORKER_NAME="chiridion-app"
    ;;
  *) usage ;;
esac

RUNTIME_URL="${AGENT_RUNTIME_URL:-https://agents.camelai.dev}"
AWS_REGION="${AWS_REGION:-us-west-2}"
EVENTS='["run.started", "run.completed", "run.failed", "input.requested", "input.resolved", "usage.recorded"]'

command -v aws >/dev/null || { echo "aws CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

token="$(aws secretsmanager get-secret-value --region "$AWS_REGION" \
  --secret-id "$TOKEN_SECRET_ID" --query SecretString --output text)"
[ -n "$token" ] || { echo "Could not read $TOKEN_SECRET_ID" >&2; exit 1; }
trap 'unset token' EXIT

runtime() {
  local method="$1" path="$2" body="${3:-}"
  curl -sS --fail-with-body -X "$method" "$RUNTIME_URL$path" \
    -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    ${body:+-d "$body"}
}

case "$action" in
  register)
    response="$(runtime POST /v1/webhooks "$(jq -n --arg url "$ENDPOINT_URL" --arg target "$target" --argjson events "$EVENTS" \
      '{url: $url, events: $events, description: "chiridion \($target): runtime threads (runs, inputs, usage)"}')")" \
      || { echo "Registering the endpoint failed: $(printf '%s' "$response" | jq -r '.error // .' 2>/dev/null)" >&2; exit 1; }
    endpoint_id="$(printf '%s' "$response" | jq -r '.id')"
    printf '%s' "$response" | jq -e -r '.secret | select(startswith("whsec_"))' >/dev/null \
      || { echo "The runtime returned no signing secret" >&2; exit 1; }
    printf '%s' "$response" | jq -j '.secret' \
      | npx wrangler secret put AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET --name "$WORKER_NAME" >/dev/null
    unset response
    echo "Registered endpoint $endpoint_id -> $ENDPOINT_URL"
    echo "Stored its signing secret as AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET on $WORKER_NAME"
    ;;
  subscribe-usage)
    endpoint="$(runtime GET /v1/webhooks | jq -c --arg url "$ENDPOINT_URL" '[.[] | select(.url == $url)] | first // empty')"
    [ -n "$endpoint" ] || { echo "No endpoint for $ENDPOINT_URL; run '$0 register $target' instead" >&2; exit 1; }
    endpoint_id="$(printf '%s' "$endpoint" | jq -r '.id')"
    events="$(printf '%s' "$endpoint" | jq -c '.events + ["usage.recorded"] | unique')"
    runtime PATCH "/v1/webhooks/$endpoint_id" "$(jq -n --argjson events "$events" '{events: $events}')" >/dev/null
    echo "Endpoint $endpoint_id now receives: $(printf '%s' "$events" | jq -r 'join(", ")')"
    if runtime GET /v1/usage-webhook >/dev/null 2>&1; then
      runtime DELETE /v1/usage-webhook >/dev/null
      echo "Deleted the legacy usage webhook"
    else
      echo "No legacy usage webhook to delete"
    fi
    ;;
  *) usage ;;
esac

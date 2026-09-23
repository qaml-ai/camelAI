# Code executor hosts

`js_exec` code is model-written, so treat it as hostile. With executors configured,
the runtime no longer runs it on its own host. It runs on separate EC2 hosts that
hold no provider keys, tenant data, agent state or IAM credentials. If code escapes
QuickJS, then Node, then gVisor, it reaches a machine with nothing on it that is
worth taking, and a network that only lets it talk to the runtime's callback port.

```text
runtime host (agents.camelai.dev)                    executor host (private SG, no IAM role)
  agent process: executeCode()                          docker --runtime=runsc
    ── POST /execute {code, tools, callback} ──────────▶  src/executor/server.ts
    ◀─ NDJSON: output events, then result|error ───────     fresh code-child per execution
  callback listener :8791                                     QuickJS/WASM (same limits)
    ◀─ POST /internal/executions/:id/tools ─────────────   guest tool call
       Bearer <per-execution token>
    validate + quota (same code as local) → ToolBridge
```

- The runtime authenticates to executors with `AGENT_EXECUTOR_TOKEN` (Secrets
  Manager `camelai/agent-runtime/executor-token`).
- Each execution gets a fresh random capability. It reaches only that
  execution's tools, and only until the execution's deadline or its end,
  whichever comes first. The runtime keeps a hash of it and nothing else.
- Every tool call goes through the same validation and quotas as local codemode:
  schema checks, the 256-call limit, 32 concurrent calls, the per-result and
  total transfer limits, and output limits. A compromised executor can't get
  past any of them.
- When the runtime aborts or times out an execution, it disconnects, and the
  executor then kills the child. The executor also kills it after the deadline
  plus 2s, even if the runtime never disconnects.

## Resources

All in `us-west-2`, in the default VPC and the runtime's subnet:

- Security group `camelai-agent-executor`:
  - inbound TCP/8790 from the runtime group only;
  - outbound TCP/8791 to the runtime group only. There is no internet, and no
    other host is reachable.
- The runtime group `camelai-agent-runtime` gains inbound TCP/8791 from the executor group only.
- Security group `camelai-agent-executor-bootstrap`: outbound 80/443, attached
  only while a new host installs Docker, gVisor and the image. `deploy.sh`
  detaches it once the host is healthy.
- Secret `camelai/agent-runtime/executor-token`. The runtime role can read it.
  Executor hosts have no role at all.
- EC2 hosts `camelai-agent-executor` (`t4g.small`, AL2023 arm64). Their settings:
  - no instance profile, no SSH, no SSM;
  - IMDSv2 with a hop limit of 1, turned off entirely after boot;
  - an encrypted, disposable root volume.

  Each host runs `agent-executor.service`, which starts the runtime image under
  `runsc` with these settings:
  - a read-only root and a tmpfs `/tmp`;
  - all capabilities dropped and `no-new-privileges`;
  - memory and PID limits;
  - an environment file holding only `AGENT_EXECUTOR_TOKEN`. The executor reads
    it once and then clears its whole environment. Code children get a fixed
    `PATH`/`HOME`/`TMPDIR`.

Settings live in `../config.sh`:
- `EXECUTOR_INSTANCE_TYPE`
- `EXECUTOR_COUNT`
- `EXECUTOR_PORT` (8790)
- `EXECUTOR_CALLBACK_PORT` (8791)
- `GVISOR_RELEASE`: pin a dated release once it's validated.

## Deploying

```sh
infra/agent-runtime/provision.sh            # adds the executor-token secret to the runtime role
infra/agent-runtime/executor/provision.sh   # token + security groups (idempotent)
infra/agent-runtime/deploy.sh               # runtime image with src/executor + the :8791 publish
infra/agent-runtime/executor/deploy.sh      # new executor hosts, then switch the runtime to them
```

Executor hosts are immutable. Each `executor/deploy.sh` run does the following:
1. Launches `EXECUTOR_COUNT` new hosts with the runtime's current image, or a tag
   passed as the first argument.
2. Waits until the runtime host can reach `/healthz` on each one.
3. Locks them down: detaches the bootstrap group and turns IMDS off.
4. Writes `/opt/agent-runtime/executor.env` on the runtime host, with
   `AGENT_EXECUTOR_URL`, `AGENT_EXECUTOR_CALLBACK_URL` and
   `AGENT_EXECUTOR_CALLBACK_PORT`. `refresh-config.sh` adds the token from
   Secrets Manager.
5. Restarts the runtime. This interrupts running turns, just like `deploy.sh`.
6. Terminates the previous executor hosts.

If the new hosts never become healthy, the script terminates them and leaves the
runtime alone.

A deploy of the runtime alone (`deploy.sh`) keeps the current executors. If you
change `src/executor`, `src/code-child.ts` or the sandbox, run both deploys.

To go back to local execution, delete `/opt/agent-runtime/executor.env` on the
runtime host and run `systemctl restart agent-runtime`.

## Runtime settings

| Variable | Where | Meaning |
|---|---|---|
| `AGENT_EXECUTOR_URL` | runtime | Comma-separated executor origins, e.g. `http://10.0.1.20:8790`. Each execution picks one at random. Unset means local execution. |
| `AGENT_EXECUTOR_TOKEN` | runtime and executor | At least 32 characters. Executors accept only this bearer token. |
| `AGENT_EXECUTOR_CALLBACK_URL` | runtime | Base URL executors use to reach the runtime's callback listener, e.g. `http://<runtime private IP>:8791`. |
| `AGENT_EXECUTOR_CALLBACK_PORT` | runtime | Callback listener port (default 8791). This listener is separate from the public one, and Caddy never proxies it. |
| `PORT`, `HOST` | executor | Listen address. The image sets `0.0.0.0:8790`. |
| `AGENT_EXECUTOR_MAX_CONCURRENCY` | executor | Concurrent executions per host (default 8). Beyond this, requests get a 503. |

## Known limits

- **No health-aware routing.** Each execution picks an executor at random. If a
  host dies, the executions sent to it fail until the next deploy. An internal
  NLB with health checks would fix this once there's more than one host.
- **Executors are shared across tenants.** gVisor contains an escape from the
  executor container. But inside the container, a guest that got out of QuickJS
  and into its Node child runs as the same user as the executor process, and
  could read the executor token from `/proc/<ppid>/environ`. That token only
  lets it submit more executions. Reading other executions' in-flight callback
  tokens would need ptrace-level access to the executor's memory. Per-execution
  containers (one `runsc` sandbox per run) or per-tenant executor pools would
  close this gap.
- **Plain HTTP inside the VPC.** Traffic between runtime and executors is
  confined to two security groups. Add TLS if the network path ever leaves the VPC.
- **User data keeps its secrets.** The executor token (and a 12-hour ECR
  password) stay in the instance's user data. Anyone with
  `ec2:DescribeInstanceAttribute` can read it. The host itself can't read it
  once IMDS is off.
- **No logs.** Executor hosts have no role, so they don't ship logs anywhere.
  For debugging, attach an SSM-only instance profile temporarily, or launch a
  one-off host.

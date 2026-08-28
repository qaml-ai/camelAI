--------------------------- MODULE ChatLifecycle ---------------------------
EXTENDS Naturals, FiniteSets, Sequences

(***************************************************************************
The bounded durable lifecycle. Transport flush, one JIT legacy import,
admission, FIFO alarm ownership, checkpoint recovery, provider batches, and
per-call effects are separate finite state machines. No stream, promise, or
effect-latched call is resumed.
***************************************************************************)

CONSTANTS
  MessageIds, CallIds, NoMessage, NoToken, PayloadBytes,
  AdmissionLimit, QueueLimit, QueueByteLimit,
  TransportDeadline, MigrationDeadline, TurnDeadline,
  ProviderDeadline, ToolDeadline, ToolLimit, CheckpointLimit

ASSUME
  /\ IsFiniteSet(MessageIds) /\ MessageIds # {}
  /\ IsFiniteSet(CallIds) /\ CallIds # {}
  /\ NoMessage \notin MessageIds
  /\ AdmissionLimit \in 1..Cardinality(MessageIds)
  /\ PayloadBytes \in [MessageIds -> Nat \ {0}]
  /\ QueueLimit \in 1..AdmissionLimit
  /\ QueueByteLimit \in Nat \ {0}
  /\ TransportDeadline \in Nat \ {0}
  /\ MigrationDeadline \in Nat \ {0}
  /\ TurnDeadline \in Nat \ {0}
  /\ ProviderDeadline \in Nat \ {0}
  /\ ToolDeadline \in Nat \ {0}
  /\ ToolLimit \in Nat \ {0}
  /\ CheckpointLimit \in Nat \ {0}

TransportStates == {"absent", "pending", "open", "closed"}
MigrationStates == {"unseen", "pending", "complete", "failed"}
TurnStates == {"absent", "queued", "running", "completed", "failed", "interrupted"}
TerminalStates == {"completed", "failed", "interrupted"}
Phases == {"idle", "ready", "provider", "batch", "final"}
MaxAttempts == 2
MaxRecoveries == 1
ProviderLimit == ToolLimit + MaxAttempts
PayloadBytesConfig == [m \in MessageIds |-> 1]

Token(m, attempt) == <<m, attempt>>
TokenSet == {Token(m, a) : m \in MessageIds, a \in 1..MaxAttempts}
MigrationToken(attempt) == <<"legacy", attempt>>

RECURSIVE QueueBytes(_)
QueueBytes(q) ==
  IF Len(q) = 0 THEN 0 ELSE PayloadBytes[Head(q)] + QueueBytes(Tail(q))
SeqToSet(q) == {q[i] : i \in 1..Len(q)}
BatchOrders ==
  {s \in UNION {[1..n -> CallIds] : n \in 1..Cardinality(CallIds)} :
     Cardinality(SeqToSet(s)) = Len(s)}

VARIABLES
  transport, transportRemaining, firstByteSent,
  migrationState, migrationRemaining, migrationAttempts, migrationToken, migrationRequested,
  prearmed, seen, retainedPayload, queue, status, alarmArmed, turnRemaining,
  active, attemptCount, recoveryCount, activeToken,
  phase, providerCallsUsed, providerRemaining, checkpointBytes,
  batchCalls, usedCalls, begunCalls, resultCalls, toolRemaining,
  crashed, abortRequired, isolateAborted, lateFenceObserved

TransportVars == <<transport, transportRemaining, firstByteSent>>
MigrationVars ==
  <<migrationState, migrationRemaining, migrationAttempts, migrationToken, migrationRequested>>
PayloadQueueVars == <<seen, retainedPayload, queue, status, turnRemaining>>
LedgerVars == <<PayloadQueueVars, alarmArmed>>
OwnerVars == <<active, attemptCount, recoveryCount, activeToken>>
ExecutionVars ==
  <<phase, providerCallsUsed, providerRemaining, checkpointBytes,
    batchCalls, usedCalls, begunCalls, resultCalls, toolRemaining>>
FenceVars == <<crashed, abortRequired, isolateAborted, lateFenceObserved>>
vars ==
  <<TransportVars, MigrationVars, prearmed, LedgerVars,
    OwnerVars, ExecutionVars, FenceVars>>
LifecycleVars == <<MigrationVars, prearmed, LedgerVars, OwnerVars, ExecutionVars, FenceVars>>

BatchSet == SeqToSet(batchCalls)
StartedCalls == begunCalls \ resultCalls
BatchClosed == Len(batchCalls) > 0 /\ BatchSet \subseteq resultCalls
NextCallIndex == Cardinality(BatchSet \cap resultCalls) + 1
HasUncertainEffect == StartedCalls # {}
CanonicalHistory == {m \in seen : status[m] = "completed"}
ExcludedHistory == {m \in seen : status[m] \in {"failed", "interrupted"}}

Init ==
  /\ transport = "absent" /\ transportRemaining = 0 /\ firstByteSent = FALSE
  /\ migrationState = "unseen" /\ migrationRemaining = 0
  /\ migrationAttempts = 0 /\ migrationToken = NoToken
  /\ migrationRequested = FALSE
  /\ prearmed = NoMessage
  /\ seen = {} /\ retainedPayload = {} /\ queue = <<>>
  /\ status = [m \in MessageIds |-> "absent"]
  /\ alarmArmed = FALSE /\ turnRemaining = [m \in MessageIds |-> 0]
  /\ active = NoMessage /\ attemptCount = [m \in MessageIds |-> 0]
  /\ recoveryCount = [m \in MessageIds |-> 0] /\ activeToken = NoToken
  /\ phase = "idle" /\ providerCallsUsed = 0 /\ providerRemaining = 0
  /\ checkpointBytes = 0 /\ batchCalls = <<>> /\ usedCalls = {}
  /\ begunCalls = {} /\ resultCalls = {} /\ toolRemaining = 0
  /\ crashed = FALSE /\ abortRequired = NoMessage
  /\ isolateAborted = {} /\ lateFenceObserved = FALSE

(***************************************************************************
Transport decides its first byte before lifecycle work. A caller may time out;
accepted transport is not falsely promised to open in every environment.
***************************************************************************)

RequestTransport ==
  /\ transport \in {"absent", "closed"}
  /\ transport' = "pending" /\ transportRemaining' = TransportDeadline
  /\ firstByteSent' = FALSE /\ UNCHANGED LifecycleVars

FlushTransport ==
  /\ transport = "pending" /\ transportRemaining > 0
  /\ transport' = "open" /\ transportRemaining' = 0
  /\ firstByteSent' = TRUE /\ UNCHANGED LifecycleVars

TimeoutTransport ==
  /\ transport = "pending" /\ transportRemaining = 0
  /\ transport' = "closed" /\ transportRemaining' = 0
  /\ firstByteSent' = FALSE /\ UNCHANGED LifecycleVars

CloseTransport ==
  /\ transport = "open"
  /\ transport' = "closed" /\ transportRemaining' = 0
  /\ firstByteSent' = FALSE /\ UNCHANGED LifecycleVars

(***************************************************************************
One JIT legacy read starts after admission or a durable post-open request. Its
retry shares one absolute budget. A terminal decision fences later reads.
***************************************************************************)

RequestLegacyMigration ==
  /\ transport = "open" /\ firstByteSent /\ migrationState = "unseen"
  /\ ~migrationRequested /\ migrationRequested' = TRUE /\ alarmArmed' = TRUE
  /\ UNCHANGED <<TransportVars, migrationState, migrationRemaining,
       migrationAttempts, migrationToken, prearmed, PayloadQueueVars,
       OwnerVars, ExecutionVars, FenceVars>>

BeginLegacyMigration ==
  /\ (seen # {} \/ migrationRequested)
  /\ migrationState = "unseen" /\ migrationAttempts = 0
  /\ migrationState' = "pending"
  /\ migrationAttempts' = 1 /\ migrationToken' = MigrationToken(1)
  /\ migrationRequested' = FALSE
  /\ migrationRemaining' = MigrationDeadline
  /\ alarmArmed' = TRUE
  /\ UNCHANGED
       <<TransportVars, prearmed, PayloadQueueVars, OwnerVars,
         ExecutionVars, FenceVars>>

RetryLegacyMigration ==
  /\ migrationState = "pending" /\ migrationAttempts = 1
  /\ migrationRemaining > 0
  /\ migrationAttempts' = 2 /\ migrationToken' = MigrationToken(2)
  /\ UNCHANGED
       <<transport, transportRemaining, firstByteSent,
         migrationState, migrationRemaining, migrationRequested, prearmed, LedgerVars,
         OwnerVars, ExecutionVars, FenceVars>>

CompleteLegacyMigration ==
  /\ migrationState = "pending" /\ migrationRemaining > 0
  /\ migrationState' = "complete" /\ migrationRemaining' = 0
  /\ migrationToken' = NoToken
  /\ UNCHANGED
       <<transport, transportRemaining, firstByteSent, migrationAttempts, migrationRequested,
         prearmed, LedgerVars, OwnerVars, ExecutionVars, FenceVars>>

FailLegacyMigration ==
  /\ migrationState = "pending" /\ migrationAttempts \in 1..2
  /\ migrationState' = "failed" /\ migrationRemaining' = 0
  /\ migrationToken' = NoToken
  /\ UNCHANGED
       <<transport, transportRemaining, firstByteSent, migrationAttempts, migrationRequested,
         prearmed, LedgerVars, OwnerVars, ExecutionVars, FenceVars>>

MigrationTimeoutFail ==
  migrationState = "pending" /\ migrationRemaining = 0 /\ FailLegacyMigration

(***************************************************************************
Admission pre-arms an alarm. DurablyAdmit is the server ACK decision. Payload
pruning never removes the permanent, capped idempotency tombstone.
***************************************************************************)

ClientPost(m) ==
  /\ m \in MessageIds /\ prearmed = NoMessage /\ abortRequired = NoMessage
  /\ prearmed' = m /\ alarmArmed' = TRUE
  /\ UNCHANGED
       <<TransportVars, MigrationVars, PayloadQueueVars, OwnerVars,
         ExecutionVars, FenceVars>>

DurablyAdmit(m) ==
  /\ m = prearmed /\ m \in MessageIds \ seen
  /\ Cardinality(seen) < AdmissionLimit /\ Len(queue) < QueueLimit
  /\ QueueBytes(queue) + PayloadBytes[m] <= QueueByteLimit
  /\ seen' = seen \cup {m} /\ retainedPayload' = retainedPayload \cup {m}
  /\ queue' = Append(queue, m) /\ status' = [status EXCEPT ![m] = "queued"]
  /\ turnRemaining' = [turnRemaining EXCEPT ![m] = TurnDeadline]
  /\ prearmed' = NoMessage
  /\ UNCHANGED
       <<TransportVars, MigrationVars, alarmArmed, OwnerVars,
         ExecutionVars, FenceVars>>

RejectDuplicate ==
  /\ prearmed \in seen /\ prearmed' = NoMessage
  /\ UNCHANGED <<TransportVars, MigrationVars, LedgerVars, OwnerVars, ExecutionVars, FenceVars>>

RejectThreadFull ==
  /\ prearmed \in MessageIds \ seen /\ Cardinality(seen) = AdmissionLimit
  /\ prearmed' = NoMessage
  /\ UNCHANGED <<TransportVars, MigrationVars, LedgerVars, OwnerVars, ExecutionVars, FenceVars>>

RejectQueueBound ==
  /\ prearmed \in MessageIds \ seen /\ Cardinality(seen) < AdmissionLimit
  /\ (Len(queue) >= QueueLimit \/
       QueueBytes(queue) + PayloadBytes[prearmed] > QueueByteLimit)
  /\ prearmed' = NoMessage
  /\ UNCHANGED <<TransportVars, MigrationVars, LedgerVars, OwnerVars, ExecutionVars, FenceVars>>

ConsumeSpuriousAlarm ==
  /\ alarmArmed /\ active = NoMessage /\ Len(queue) = 0
  /\ prearmed = NoMessage /\ migrationState # "pending" /\ ~migrationRequested
  /\ alarmArmed' = FALSE
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, PayloadQueueVars,
         OwnerVars, ExecutionVars, FenceVars>>

PrunePayload(m) ==
  /\ m \in retainedPayload /\ status[m] \in TerminalStates
  /\ retainedPayload' = retainedPayload \ {m}
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, seen, queue, status,
         alarmArmed, turnRemaining, OwnerVars, ExecutionVars, FenceVars>>

(***************************************************************************
The alarm selects one FIFO head. Provider responses checkpoint an ordered,
atomic batch. Every call latches before execution and records one result.
***************************************************************************)

StartSelectedTurn ==
  /\ alarmArmed /\ abortRequired = NoMessage
  /\ migrationState \in {"complete", "failed"}
  /\ active = NoMessage /\ Len(queue) > 0 /\ turnRemaining[Head(queue)] > 0
  /\ LET m == Head(queue) IN
       /\ status' = [status EXCEPT ![m] = "running"]
       /\ active' = m /\ attemptCount' = [attemptCount EXCEPT ![m] = 1]
       /\ activeToken' = Token(m, 1) /\ queue' = Tail(queue)
  /\ phase' = "ready" /\ providerCallsUsed' = 0 /\ providerRemaining' = 0
  /\ checkpointBytes' = 0 /\ batchCalls' = <<>> /\ usedCalls' = {}
  /\ begunCalls' = {} /\ resultCalls' = {} /\ toolRemaining' = 0
  /\ crashed' = FALSE
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, seen, retainedPayload,
         alarmArmed, turnRemaining, recoveryCount, abortRequired,
         isolateAborted, lateFenceObserved>>

StartNextInference(m, t) ==
  /\ m = active /\ t = activeToken /\ ~crashed
  /\ status[m] = "running" /\ turnRemaining[m] > 0
  /\ providerCallsUsed < ProviderLimit
  /\ (phase = "ready" \/ (phase = "batch" /\ BatchClosed))
  /\ providerCallsUsed' = providerCallsUsed + 1
  /\ providerRemaining' = ProviderDeadline /\ phase' = "provider"
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         checkpointBytes, batchCalls, usedCalls, begunCalls, resultCalls,
         toolRemaining, FenceVars>>

CheckpointProviderBatch(m, t, calls) ==
  /\ m = active /\ t = activeToken /\ ~crashed /\ phase = "provider"
  /\ status[m] = "running" /\ turnRemaining[m] > 0 /\ providerRemaining > 0
  /\ calls \in BatchOrders /\ SeqToSet(calls) \cap usedCalls = {}
  /\ Cardinality(usedCalls) + Len(calls) <= ToolLimit
  /\ checkpointBytes + Len(calls) + 1 <= CheckpointLimit
  /\ batchCalls' = calls /\ usedCalls' = usedCalls \cup SeqToSet(calls)
  /\ checkpointBytes' = checkpointBytes + Len(calls) + 1
  /\ phase' = "batch" /\ providerRemaining' = 0 /\ toolRemaining' = 0
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         providerCallsUsed, begunCalls, resultCalls, FenceVars>>

CheckpointProviderFinal(m, t) ==
  /\ m = active /\ t = activeToken /\ ~crashed /\ phase = "provider"
  /\ status[m] = "running" /\ turnRemaining[m] > 0 /\ providerRemaining > 0
  /\ checkpointBytes < CheckpointLimit
  /\ checkpointBytes' = checkpointBytes + 1
  /\ providerRemaining' = 0 /\ phase' = "final"
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         providerCallsUsed, batchCalls, usedCalls, begunCalls, resultCalls,
         toolRemaining, FenceVars>>

BeginEffect(m, t, c) ==
  /\ m = active /\ t = activeToken /\ ~crashed /\ phase = "batch"
  /\ NextCallIndex <= Len(batchCalls)
  /\ c = batchCalls[NextCallIndex] /\ c \notin begunCalls
  /\ status[m] = "running" /\ turnRemaining[m] > 0
  /\ begunCalls' = begunCalls \cup {c} /\ toolRemaining' = ToolDeadline
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         phase, providerCallsUsed, providerRemaining, checkpointBytes,
         batchCalls, usedCalls, resultCalls, FenceVars>>

RecordToolResult(m, t, c) ==
  /\ m = active /\ t = activeToken /\ ~crashed /\ phase = "batch"
  /\ c \in BatchSet /\ c \in begunCalls \ resultCalls
  /\ status[m] = "running" /\ turnRemaining[m] > 0 /\ toolRemaining > 0
  /\ checkpointBytes < CheckpointLimit
  /\ resultCalls' = resultCalls \cup {c}
  /\ checkpointBytes' = checkpointBytes + 1 /\ toolRemaining' = 0
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         phase, providerCallsUsed, providerRemaining, batchCalls, usedCalls,
         begunCalls, FenceVars>>

(***************************************************************************
One recovery gets a fresh fence while retaining the original absolute budget,
provider/tool counters, completed results, and bounded durable checkpoint.
***************************************************************************)

RecoveryEligible(m) ==
  /\ m = active /\ m \in MessageIds /\ crashed
  /\ attemptCount[m] = 1 /\ recoveryCount[m] = 0
  /\ turnRemaining[m] > 0 /\ ~HasUncertainEffect
  /\ phase \in {"ready", "provider", "batch", "final"}
  /\ (phase # "provider" \/ providerCallsUsed < ProviderLimit)

RecoverFromCheckpoint(m, t) ==
  /\ t = activeToken /\ RecoveryEligible(m)
  /\ attemptCount' = [attemptCount EXCEPT ![m] = 2]
  /\ recoveryCount' = [recoveryCount EXCEPT ![m] = 1]
  /\ activeToken' = Token(m, 2) /\ crashed' = FALSE
  /\ providerRemaining' = IF phase = "provider" THEN 0 ELSE providerRemaining
  /\ phase' = IF phase = "provider" THEN "ready" ELSE phase
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, active,
         providerCallsUsed, checkpointBytes, batchCalls, usedCalls,
         begunCalls, resultCalls, toolRemaining, abortRequired,
         isolateAborted, lateFenceObserved>>

ResetExecution ==
  /\ active' = NoMessage /\ activeToken' = NoToken /\ phase' = "idle"
  /\ providerCallsUsed' = 0 /\ providerRemaining' = 0
  /\ checkpointBytes' = 0 /\ batchCalls' = <<>> /\ usedCalls' = {}
  /\ begunCalls' = {} /\ resultCalls' = {} /\ toolRemaining' = 0
  /\ crashed' = FALSE

CompleteTurn(m, t) ==
  /\ m = active /\ t = activeToken /\ ~crashed /\ phase = "final"
  /\ status[m] = "running" /\ turnRemaining[m] > 0
  /\ status' = [status EXCEPT ![m] = "completed"]
  /\ turnRemaining' = [turnRemaining EXCEPT ![m] = 0]
  /\ alarmArmed' = (Len(queue) > 0 \/ prearmed # NoMessage)
  /\ ResetExecution
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, seen, retainedPayload, queue,
         attemptCount, recoveryCount, abortRequired, isolateAborted,
         lateFenceObserved>>

ProviderMayFail(m) ==
  phase = "provider" /\ turnRemaining[m] > 0
ProviderTimedOut == phase = "provider" /\ providerRemaining = 0
ToolTimedOut == phase = "batch" /\ StartedCalls # {} /\ toolRemaining = 0

FailTurn(m, t) ==
  /\ m = active /\ t = activeToken /\ ~crashed /\ status[m] = "running"
  /\ (ProviderMayFail(m) \/ ToolTimedOut)
  /\ status' = [status EXCEPT ![m] = "failed"]
  /\ turnRemaining' = [turnRemaining EXCEPT ![m] = 0]
  /\ abortRequired' = IF ProviderTimedOut \/ ToolTimedOut THEN m ELSE NoMessage
  /\ alarmArmed' = (Len(queue) > 0 \/ prearmed # NoMessage)
  /\ ResetExecution
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, seen, retainedPayload, queue,
         attemptCount, recoveryCount, isolateAborted, lateFenceObserved>>

ExpireOperation ==
  /\ \/ /\ active \in MessageIds /\ turnRemaining[active] = 0
     \/ /\ active = NoMessage /\ Len(queue) > 0
           /\ turnRemaining[Head(queue)] = 0
  /\ IF active \in MessageIds
     THEN LET m == active IN
       /\ status' = [status EXCEPT ![m] = "interrupted"]
       /\ turnRemaining' = [turnRemaining EXCEPT ![m] = 0]
       /\ abortRequired' = m
       /\ alarmArmed' = (Len(queue) > 0 \/ prearmed # NoMessage)
       /\ ResetExecution /\ UNCHANGED queue
     ELSE LET m == Head(queue) IN
       /\ status' = [status EXCEPT ![m] = "failed"]
       /\ queue' = Tail(queue)
       /\ turnRemaining' = [turnRemaining EXCEPT ![m] = 0]
       /\ alarmArmed' =
            (Len(Tail(queue)) > 0 \/ prearmed # NoMessage \/
             migrationState = "pending" \/ migrationRequested)
       /\ UNCHANGED <<OwnerVars, ExecutionVars, crashed, abortRequired>>
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, seen, retainedPayload,
         attemptCount, recoveryCount, isolateAborted, lateFenceObserved>>

Crash ==
  /\ active \in MessageIds /\ status[active] = "running" /\ ~crashed
  /\ crashed' = TRUE
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         ExecutionVars, abortRequired, isolateAborted, lateFenceObserved>>

ReconcileCrashedTurn ==
  /\ active \in MessageIds /\ crashed /\ ~RecoveryEligible(active)
  /\ status' = [status EXCEPT ![active] = "interrupted"]
  /\ turnRemaining' = [turnRemaining EXCEPT ![active] = 0]
  /\ alarmArmed' = (Len(queue) > 0 \/ prearmed # NoMessage)
  /\ ResetExecution
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, seen, retainedPayload, queue,
         attemptCount, recoveryCount, abortRequired, isolateAborted,
         lateFenceObserved>>

AbortIsolate ==
  /\ abortRequired \in MessageIds /\ status[abortRequired] \in TerminalStates
  /\ isolateAborted' = isolateAborted \cup {abortRequired}
  /\ abortRequired' = NoMessage
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         ExecutionVars, crashed, lateFenceObserved>>

ObserveLateToken(m, t) ==
  /\ m \in seen /\ t \in {Token(m, 1), Token(m, 2)}
  /\ t # activeToken /\ ~lateFenceObserved
  /\ lateFenceObserved' = TRUE
  /\ UNCHANGED
       <<TransportVars, MigrationVars, prearmed, LedgerVars, OwnerVars,
         ExecutionVars, crashed, abortRequired, isolateAborted>>

Tick ==
  /\ \/ (transport = "pending" /\ transportRemaining > 0)
     \/ (migrationState = "pending" /\ migrationRemaining > 0)
     \/ (\E m \in MessageIds :
           status[m] \in {"queued", "running"} /\ turnRemaining[m] > 0)
     \/ (phase = "provider" /\ providerRemaining > 0)
     \/ (StartedCalls # {} /\ toolRemaining > 0)
  /\ transportRemaining' =
       IF transport = "pending" /\ transportRemaining > 0
       THEN transportRemaining - 1 ELSE transportRemaining
  /\ migrationRemaining' =
       IF migrationState = "pending" /\ migrationRemaining > 0
       THEN migrationRemaining - 1 ELSE migrationRemaining
  /\ turnRemaining' = [m \in MessageIds |->
       IF status[m] \in {"queued", "running"} /\ turnRemaining[m] > 0
       THEN turnRemaining[m] - 1 ELSE turnRemaining[m]]
  /\ providerRemaining' =
       IF phase = "provider" /\ providerRemaining > 0
       THEN providerRemaining - 1 ELSE providerRemaining
  /\ toolRemaining' =
       IF StartedCalls # {} /\ toolRemaining > 0
       THEN toolRemaining - 1 ELSE toolRemaining
  /\ UNCHANGED
       <<transport, firstByteSent, migrationState, migrationAttempts,
         migrationToken, migrationRequested,
         prearmed, seen, retainedPayload, queue, status, alarmArmed,
         OwnerVars, phase, providerCallsUsed, checkpointBytes, batchCalls,
         usedCalls, begunCalls, resultCalls, FenceVars>>

AdmitPending == \E m \in MessageIds : DurablyAdmit(m)
RecoverAny == \E m \in MessageIds, t \in TokenSet : RecoverFromCheckpoint(m, t)
TimeoutFail ==
  \E m \in MessageIds, t \in TokenSet :
    m = active /\ t = activeToken /\
      (ProviderTimedOut \/ ToolTimedOut) /\ FailTurn(m, t)

Next ==
  \/ RequestTransport \/ FlushTransport \/ TimeoutTransport \/ CloseTransport
  \/ RequestLegacyMigration \/ BeginLegacyMigration \/ RetryLegacyMigration
  \/ CompleteLegacyMigration \/ FailLegacyMigration
  \/ (\E m \in MessageIds : ClientPost(m)) \/ AdmitPending
  \/ RejectDuplicate \/ RejectThreadFull \/ RejectQueueBound
  \/ ConsumeSpuriousAlarm \/ (\E m \in MessageIds : PrunePayload(m))
  \/ StartSelectedTurn
  \/ (\E m \in MessageIds, t \in TokenSet : StartNextInference(m, t))
  \/ (\E m \in MessageIds, t \in TokenSet, calls \in BatchOrders :
        CheckpointProviderBatch(m, t, calls))
  \/ (\E m \in MessageIds, t \in TokenSet : CheckpointProviderFinal(m, t))
  \/ (\E m \in MessageIds, t \in TokenSet, c \in CallIds : BeginEffect(m, t, c))
  \/ (\E m \in MessageIds, t \in TokenSet, c \in CallIds : RecordToolResult(m, t, c))
  \/ RecoverAny
  \/ (\E m \in MessageIds, t \in TokenSet : CompleteTurn(m, t) \/ FailTurn(m, t))
  \/ ExpireOperation \/ Crash \/ ReconcileCrashedTurn \/ AbortIsolate
  \/ (\E m \in MessageIds, t \in TokenSet : ObserveLateToken(m, t))
  \/ Tick

Fairness ==
  /\ WF_vars(FlushTransport) /\ WF_vars(TimeoutTransport) /\ WF_vars(Tick)
  /\ WF_vars(RequestLegacyMigration) /\ WF_vars(BeginLegacyMigration)
  /\ WF_vars(MigrationTimeoutFail)
  /\ WF_vars(AdmitPending) /\ WF_vars(RejectDuplicate)
  /\ WF_vars(RejectThreadFull) /\ WF_vars(RejectQueueBound)
  /\ WF_vars(ConsumeSpuriousAlarm) /\ WF_vars(StartSelectedTurn)
  /\ WF_vars(ExpireOperation) /\ WF_vars(RecoverAny)
  /\ WF_vars(ReconcileCrashedTurn) /\ WF_vars(AbortIsolate)
  /\ WF_vars(TimeoutFail)
  /\ (\A m \in MessageIds, t \in TokenSet : WF_vars(StartNextInference(m, t)))
  /\ (\A m \in MessageIds, t \in TokenSet, c \in CallIds :
       WF_vars(BeginEffect(m, t, c)))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************
Safety and liveness checked by TLC.
***************************************************************************)

TypeOK ==
  /\ transport \in TransportStates /\ transportRemaining \in 0..TransportDeadline
  /\ firstByteSent \in BOOLEAN /\ migrationState \in MigrationStates
  /\ migrationRequested \in BOOLEAN
  /\ migrationRemaining \in 0..MigrationDeadline /\ migrationAttempts \in 0..2
  /\ migrationToken \in {NoToken, MigrationToken(1), MigrationToken(2)}
  /\ prearmed \in MessageIds \cup {NoMessage}
  /\ seen \subseteq MessageIds /\ retainedPayload \subseteq MessageIds
  /\ queue \in Seq(MessageIds) /\ status \in [MessageIds -> TurnStates]
  /\ alarmArmed \in BOOLEAN /\ turnRemaining \in [MessageIds -> 0..TurnDeadline]
  /\ active \in MessageIds \cup {NoMessage}
  /\ attemptCount \in [MessageIds -> 0..MaxAttempts]
  /\ recoveryCount \in [MessageIds -> 0..MaxRecoveries]
  /\ activeToken \in TokenSet \cup {NoToken} /\ phase \in Phases
  /\ providerCallsUsed \in 0..ProviderLimit
  /\ providerRemaining \in 0..ProviderDeadline
  /\ checkpointBytes \in 0..CheckpointLimit
  /\ batchCalls \in BatchOrders \cup {<<>>}
  /\ usedCalls \subseteq CallIds /\ begunCalls \subseteq CallIds
  /\ resultCalls \subseteq CallIds /\ toolRemaining \in 0..ToolDeadline
  /\ crashed \in BOOLEAN /\ abortRequired \in MessageIds \cup {NoMessage}
  /\ isolateAborted \subseteq MessageIds /\ lateFenceObserved \in BOOLEAN

TransportConsistency ==
  /\ (transport = "open") <=> firstByteSent
  /\ (transport = "pending") =>
       (ENABLED FlushTransport \/ ENABLED TimeoutTransport)

MigrationConsistency ==
  /\ (migrationState = "unseen") =>
       (migrationAttempts = 0 /\ migrationRemaining = 0 /\
        migrationToken = NoToken)
  /\ migrationRequested => (migrationState = "unseen" /\ alarmArmed)
  /\ (migrationState = "pending") =>
       (migrationAttempts \in 1..2 /\
        migrationToken = MigrationToken(migrationAttempts) /\
        ~migrationRequested /\ active = NoMessage /\ alarmArmed)
  /\ (migrationState \in {"complete", "failed"}) =>
       (migrationAttempts \in 1..2 /\ migrationRemaining = 0 /\
        migrationToken = NoToken /\
        ~ENABLED BeginLegacyMigration /\ ~ENABLED RetryLegacyMigration)

AdmissionConsistency ==
  /\ retainedPayload \subseteq seen /\ Cardinality(seen) <= AdmissionLimit
  /\ \A m \in MessageIds : (m \in seen) <=> (status[m] # "absent")
  /\ \A m \in seen \ retainedPayload : status[m] \in TerminalStates

QueueConsistency ==
  /\ Len(queue) <= QueueLimit /\ QueueBytes(queue) <= QueueByteLimit
  /\ Cardinality(SeqToSet(queue)) = Len(queue)
  /\ SeqToSet(queue) = {m \in MessageIds : status[m] = "queued"}

OwnershipConsistency ==
  /\ (active = NoMessage) <=> (activeToken = NoToken)
  /\ (active = NoMessage) <=> (phase = "idle")
  /\ (active # NoMessage) =>
       (status[active] = "running" /\
        activeToken = Token(active, attemptCount[active]) /\
        attemptCount[active] \in 1..MaxAttempts)
  /\ \A m \in MessageIds :
       recoveryCount[m] = 0 \/ (recoveryCount[m] = 1 /\ attemptCount[m] = 2)
  /\ crashed => (active \in MessageIds /\ status[active] = "running")
  /\ ((active \in MessageIds \/ Len(queue) > 0 \/ prearmed \in MessageIds \/
       migrationState = "pending") => alarmArmed)

BatchConsistency ==
  /\ Cardinality(BatchSet) = Len(batchCalls)
  /\ resultCalls \subseteq begunCalls /\ begunCalls \subseteq usedCalls
  /\ BatchSet \subseteq usedCalls /\ usedCalls \ BatchSet \subseteq resultCalls
  /\ Cardinality(usedCalls) <= ToolLimit /\ Cardinality(StartedCalls) <= 1
  /\ \A i \in 1..Len(batchCalls) :
       /\ (batchCalls[i] \in resultCalls) =>
            (\A j \in 1..i : batchCalls[j] \in resultCalls)
       /\ (batchCalls[i] \in StartedCalls) => i = NextCallIndex
  /\ (phase = "idle") => usedCalls = {}
  /\ (phase = "provider" /\ Len(batchCalls) > 0) => BatchClosed
  /\ (phase = "final") => StartedCalls = {}
  /\ (StartedCalls # {}) => phase = "batch"

RecoveryAndContextConsistency ==
  /\ CanonicalHistory \cap ExcludedHistory = {}
  /\ CanonicalHistory \subseteq {m \in seen : status[m] = "completed"}
  /\ ExcludedHistory \subseteq {m \in seen : status[m] \in TerminalStates}
  /\ \A m \in MessageIds :
       attemptCount[m] <= MaxAttempts /\ recoveryCount[m] <= MaxRecoveries /\
       ((recoveryCount[m] = 1) => attemptCount[m] = 2)
  /\ (abortRequired \in MessageIds) =>
       (status[abortRequired] \in TerminalStates /\ active # abortRequired)

FiniteBounds ==
  /\ Cardinality(seen) <= AdmissionLimit
  /\ Len(queue) <= QueueLimit /\ QueueBytes(queue) <= QueueByteLimit
  /\ migrationAttempts <= 2 /\ migrationRemaining <= MigrationDeadline
  /\ providerCallsUsed <= ProviderLimit /\ providerRemaining <= ProviderDeadline
  /\ Cardinality(usedCalls) <= ToolLimit /\ checkpointBytes <= CheckpointLimit
  /\ toolRemaining <= ToolDeadline /\ transportRemaining <= TransportDeadline
  /\ \A m \in MessageIds : turnRemaining[m] <= TurnDeadline

TransportPendingEventuallyDecides ==
  (transport = "pending") ~> (transport \in {"open", "closed"})

MigrationPendingEventuallyTerminates ==
  (migrationState = "pending") ~> (migrationState \in {"complete", "failed"})

SeenEventuallyTerminal ==
  \A m \in MessageIds : (m \in seen) ~> (status[m] \in TerminalStates)

ActiveEventuallyReleased ==
  \A m \in MessageIds : (active = m) ~> (active # m)

SafeCrashEventuallyRecoversOrTerminates ==
  \A m \in MessageIds :
    (crashed /\ RecoveryEligible(m)) ~> (~crashed \/ active = NoMessage)

AbortEventuallyPerformed ==
  \A m \in MessageIds : (abortRequired = m) ~> (m \in isolateAborted)

AdmissionLedgerNeverShrinks ==
  \A m \in MessageIds : [](m \in seen => [](m \in seen))

MigrationDecisionImmutable ==
  \A s \in {"complete", "failed"} :
    [](migrationState = s => [](migrationState = s))

TerminalOutcomeImmutable ==
  \A m \in MessageIds, s \in TerminalStates :
    [](status[m] = s => [](status[m] = s))

=============================================================================

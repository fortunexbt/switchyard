import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode, RefObject } from "react";
import {
  useControlPlane,
  type Connection,
  type RunTrace,
} from "../hooks/useControlPlane";
import {
  DEMO_MODE,
  type ActionResponse,
  type DemoResult,
  type Receipt,
  type SystemState,
} from "../lib/api";
import { CHECKPOINT_MS, INSPECTION_MS, type RouteEvent } from "../lib/engine";

const DEFAULT_COMMAND =
  "Trace a recovery route for the orbital relay drill.";
const SOURCE_URL = "https://github.com/fortunexbt/switchyard";
const GATE_CHECKS = [
  "capability.allowlisted",
  "executor.synthetic",
  "stop.open-or-control",
  "writes.denied",
];
const STATUS_FILTERS = ["completed", "stopped", "blocked", "failed"] as const;
const RECEIPT_SCHEMA: [keyof Receipt, string][] = [
  ["receipt_id", "rcpt_ and 32 hex characters"],
  ["created_at", "ISO 8601 time"],
  ["status", "completed, stopped, blocked or failed"],
  ["action_kind", "fixture.replay, stop.enable or stop.reset"],
  ["capability", "allowlisted capability"],
  ["policy_code", "gate decision"],
  ["stop_generation", "stop counter when recorded"],
  ["request_fingerprint", "SHA-256 of the request"],
  ["result_fingerprint", "SHA-256 of the result, or null"],
  ["synthetic", "true for the fixture executor"],
];
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

type Tone = "neutral" | "live" | "ok" | "stop" | "warn";
type Phase =
  | "idle"
  | "pending"
  | "planned"
  | "gated"
  | "replaying"
  | Receipt["status"];
type StageState = "idle" | "active" | "done" | "held" | "skipped";
type Mark<S extends RouteEvent["stage"]> = Extract<RouteEvent, { stage: S }> & {
  at: number;
};

const STATUS_TONE: Record<Receipt["status"], Tone> = {
  completed: "ok",
  stopped: "stop",
  blocked: "warn",
  failed: "stop",
};

function App() {
  const plane = useControlPlane();
  const { system, receipts, outcome, busy, run, controlBusy, connection } =
    plane;
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  const [confirmReset, setConfirmReset] = useState(false);
  // The newest run's receipt opens in the ledger until the operator picks another.
  const [picked, setPicked] = useState<{
    run: string | null;
    id: string | null;
  }>({
    run: null,
    id: null,
  });
  const resetDialog = useRef<HTMLDialogElement>(null);
  const replayStage = useRef<HTMLLIElement>(null);
  const connected = connection === "connected";
  const latched = connected && (system?.stop.enabled ?? false);
  const phase = phaseOf(busy, run, outcome);
  const running = busy && !outcome;
  const canDispatch =
    connected &&
    !latched &&
    !busy &&
    !controlBusy &&
    command.trim().length >= 3;
  const runReceipt = outcome?.receipt.receipt_id ?? null;
  const openReceipt = picked.run === runReceipt ? picked.id : runReceipt;
  // Between the stop latching and the next checkpoint the run is draining.
  const stopping = running && (controlBusy || latched);
  const status = runStatus(phase, connection, latched, stopping);

  useEffect(() => {
    if (confirmReset) resetDialog.current?.showModal();
    else resetDialog.current?.close();
  }, [confirmReset]);

  function dispatch(event?: FormEvent) {
    event?.preventDefault();
    if (!canDispatch) return;
    void plane.dispatch(command);
    // On a phone the replay window sits below the fold. Bring it up so the run
    // can be watched and stopped from the sticky controls.
    const stage = replayStage.current?.getBoundingClientRect();
    if (stage && stage.bottom > window.innerHeight)
      window.scrollBy({
        top: stage.bottom - window.innerHeight + 16,
        behavior: reducedMotion() ? "instant" : "smooth",
      });
  }

  function toggleReceipt(id: string) {
    setPicked({ run: runReceipt, id: openReceipt === id ? null : id });
  }

  function showReceipt(id: string) {
    setPicked({ run: runReceipt, id });
    const row = document.getElementById(`receipt-${id}`);
    row?.scrollIntoView({
      block: "nearest",
      behavior: reducedMotion() ? "instant" : "smooth",
    });
    row?.querySelector("button")?.focus({ preventScroll: true });
  }

  return (
    <div className="page">
      <a className="skip-link" href="#run">
        Skip to the run
      </a>
      <header className="topbar">
        <h1 className="brand">
          <BrandMark />
          Switchyard
        </h1>
        <p className="topbar-about">
          Switchyard puts a policy gate, a stop and a hash-only receipt in
          front of the tools an agent calls. This page runs that gateway in
          your browser against an invented incident drill.
        </p>
        <nav className="topbar-links" aria-label="Page">
          <span className={`gateway ${connection}`}>
            {connection === "connected"
              ? DEMO_MODE
                ? "Gateway in this browser"
                : "Local backend connected"
              : connection === "connecting"
                ? "Connecting"
                : "Backend unavailable"}
          </span>
          <a href="#rules">Rules</a>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source
          </a>
        </nav>
      </header>

      <main className="console">
        <section className="panel run" id="run" aria-labelledby="run-title">
          <div className="run-head">
            <div className="run-heading">
              <h2 id="run-title">Orbital relay recovery</h2>
              <p className="run-meta">
                <Badge tone={status.tone}>{status.label}</Badge>
                <span className="run-generation">
                  Stop generation{" "}
                  <code>{connected ? system?.stop.generation : "?"}</code>
                </span>
              </p>
            </div>
            <div className="run-actions">
              <button
                className="button primary"
                type="submit"
                form="instruction-form"
                disabled={!canDispatch}
              >
                <Icon name="play" />
                Replay
              </button>
              {latched && !running ? (
                <button
                  key="reset"
                  className="button"
                  onClick={() => setConfirmReset(true)}
                  disabled={controlBusy}
                >
                  <Icon name="reset" />
                  Reset
                </button>
              ) : (
                <button
                  key="stop"
                  className={`button stop ${running ? "armed" : ""}`}
                  onClick={() => void plane.stopNow()}
                  disabled={controlBusy || latched}
                >
                  <Icon name="stop" />
                  {stopping ? "Stopping" : "Stop"}
                </button>
              )}
            </div>
          </div>

          {!connected && (
            <div className="run-alert" role="alert">
              <p>
                {connection === "connecting"
                  ? "Connecting to the gateway. Replay starts once it answers."
                  : "Boundary state unconfirmed. Replay stays paused until the backend answers."}
              </p>
              {connection === "unavailable" && (
                <button className="button" onClick={() => void plane.refresh()}>
                  Retry
                </button>
              )}
            </div>
          )}

          <Route
            run={phase === "idle" ? null : run}
            phase={phase}
            outcome={outcome}
            replayStage={replayStage}
            onShowReceipt={showReceipt}
          >
            <form
              id="instruction-form"
              className="instruction"
              onSubmit={dispatch}
            >
              <label className="visually-hidden" htmlFor="instruction">
                Instruction
              </label>
              <input
                id="instruction"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                maxLength={500}
                disabled={busy}
                spellCheck={false}
                autoComplete="off"
                aria-describedby="instruction-hint"
                aria-invalid={command.trim().length < 3}
              />
              <p
                id="instruction-hint"
                className={command.trim().length < 3 ? "invalid" : ""}
              >
                {command.trim().length < 3
                  ? "Enter at least 3 characters."
                  : "Only a hash of this text is kept. The replay is the same whatever you type."}
              </p>
            </form>
          </Route>

          {outcome && <Release outcome={outcome} />}

          <p className="visually-hidden" role="status">
            {plane.notice}
          </p>
        </section>

        <Ledger
          receipts={receipts}
          connection={connection}
          openId={openReceipt}
          onToggle={toggleReceipt}
        />
      </main>

      <Rules system={system} />

      <dialog
        ref={resetDialog}
        className="reset-dialog"
        aria-labelledby="reset-title"
        onClose={() => setConfirmReset(false)}
      >
        <h2 id="reset-title">Reset the stop?</h2>
        <p>
          New replays will be admitted again. Tokens issued before the stop stay
          invalid, and the reset writes its own receipt.
        </p>
        <div className="dialog-actions">
          <button
            className="button"
            autoFocus
            onClick={() => setConfirmReset(false)}
          >
            Keep stopped
          </button>
          <button
            className="button primary"
            disabled={controlBusy || !latched}
            onClick={() => {
              setConfirmReset(false);
              void plane.resetStop();
            }}
          >
            Reset stop
          </button>
        </div>
      </dialog>
    </div>
  );
}

function mark<S extends RouteEvent["stage"]>(
  run: RunTrace | null,
  stage: S,
): Mark<S> | null {
  return (
    (run?.events.find((event) => event.stage === stage) as Mark<S>) ?? null
  );
}

function phaseOf(
  busy: boolean,
  run: RunTrace | null,
  outcome: ActionResponse | null,
): Phase {
  if (outcome) return outcome.receipt.status;
  if (!busy) return "idle";
  if (mark(run, "executing")) return "replaying";
  if (mark(run, "gated")) return "gated";
  if (mark(run, "planned")) return "planned";
  return "pending";
}

function runStatus(
  phase: Phase,
  connection: Connection,
  latched: boolean,
  stopping: boolean,
): { tone: Tone; label: string } {
  if (connection === "unavailable")
    return { tone: "warn", label: "Unconfirmed" };
  if (connection === "connecting")
    return { tone: "neutral", label: "Connecting" };
  if (stopping) return { tone: "stop", label: "Stopping" };
  if (phase === "idle")
    return latched
      ? { tone: "stop", label: "Stop latched" }
      : { tone: "neutral", label: "Ready" };
  if (phase === "pending" || phase === "planned" || phase === "gated")
    return { tone: "live", label: "Starting" };
  if (phase === "replaying") return { tone: "live", label: "Replaying" };
  return {
    tone: STATUS_TONE[phase],
    label: phase.charAt(0).toUpperCase() + phase.slice(1),
  };
}

function Route({
  run,
  phase,
  outcome,
  replayStage,
  onShowReceipt,
  children,
}: {
  run: RunTrace | null;
  phase: Phase;
  outcome: ActionResponse | null;
  replayStage: RefObject<HTMLLIElement | null>;
  onShowReceipt: (id: string) => void;
  children: ReactNode;
}) {
  const idle = phase === "idle";
  const planned = mark(run, "planned");
  const gated = mark(run, "gated");
  const executing = mark(run, "executing");
  const action = planned?.action ?? outcome?.plan.actions[0] ?? null;
  // A stop during the replay means the gate had already admitted the run, so
  // every gate check passed even though the final decision is a hold.
  const interrupted = outcome?.policy.code === "denied.stop-during-execution";
  const gatePolicy =
    gated?.policy ?? (outcome && !interrupted ? outcome.policy : null);
  const admitted = interrupted || (gatePolicy?.allowed ?? false);
  const checks = interrupted
    ? GATE_CHECKS.map((code) => ({ code, passed: true }))
    : (gatePolicy?.checks ?? null);
  // Over HTTP a stopped receipt carries the generation after the stop, not the
  // one its token was issued at.
  const tokenGeneration =
    gated?.generation ??
    (interrupted ? undefined : outcome?.receipt.stop_generation);

  const instruction: StageState = idle ? "idle" : action ? "done" : "active";
  const gate: StageState = idle
    ? "idle"
    : gatePolicy || interrupted
      ? admitted
        ? "done"
        : "held"
      : action
        ? "active"
        : "idle";
  const fixture: StageState =
    phase === "replaying"
      ? "active"
      : phase === "completed"
        ? "done"
        : interrupted
          ? "held"
          : outcome
            ? "skipped"
            : "idle";

  return (
    <ol className="route" aria-label="Route">
      <Stage
        state={instruction}
        title="Instruction"
        label={idle ? "Not sent" : action ? "Planned" : "Submitted"}
        at={since(run, planned?.at)}
      >
        {children}
        {action && (
          <dl className="facts">
            <div>
              <dt>Action</dt>
              <dd>
                <code>{action.action_id}</code>
              </dd>
            </div>
            <div>
              <dt>Kind</dt>
              <dd>
                <code>{action.kind}</code>
              </dd>
            </div>
            <div>
              <dt>Capability</dt>
              <dd>
                <code>{action.capability}</code>
              </dd>
            </div>
            <div>
              <dt>Risk</dt>
              <dd>
                <code>{action.risk}</code>
              </dd>
            </div>
          </dl>
        )}
      </Stage>
      <Stage
        state={gate}
        title="Policy gate"
        label={
          gate === "idle"
            ? "4 checks"
            : gate === "active"
              ? "Checking"
              : admitted
                ? "Passed"
                : "Denied"
        }
        at={since(run, gated?.at)}
      >
        <ul className="checks">
          {(checks ?? GATE_CHECKS.map((code) => ({ code, passed: null }))).map(
            (check) => (
              <li
                key={check.code}
                className={
                  check.passed === null ? "" : check.passed ? "pass" : "fail"
                }
              >
                <Icon
                  name={
                    check.passed === null
                      ? "dot"
                      : check.passed
                        ? "check"
                        : "cross"
                  }
                />
                <code>{check.code}</code>
                <span className="visually-hidden">
                  {check.passed === null
                    ? "not run"
                    : check.passed
                      ? "passed"
                      : "failed"}
                </span>
              </li>
            ),
          )}
        </ul>
        {(gatePolicy || interrupted) && (
          <p>
            {admitted ? (
              tokenGeneration === undefined ? (
                "Admitted before the stop latched."
              ) : (
                <>
                  Admitted with a token at stop generation{" "}
                  <code>{tokenGeneration}</code>
                </>
              )
            ) : (
              <>
                Denied by <code>{gatePolicy?.code}</code>
              </>
            )}
          </p>
        )}
      </Stage>
      <Stage
        state={fixture}
        title="Fixture replay"
        label={
          fixture === "active"
            ? "Replaying"
            : fixture === "done"
              ? "Read"
              : fixture === "held"
                ? "Held"
                : fixture === "skipped"
                  ? "Not run"
                  : idle
                    ? `${INSPECTION_MS / 1000} s window`
                    : "Waiting"
        }
        at={since(run, executing?.at)}
        stageRef={replayStage}
      >
        <ReplayWindow
          windowMs={executing?.inspectionMs ?? INSPECTION_MS}
          startedAt={executing?.at ?? null}
          stopAt={run?.stopAt ?? null}
          endedAt={run?.settledAt ?? null}
          state={fixture}
          remote={phase === "pending"}
        />
      </Stage>
      <Stage
        state={outcome ? "done" : "idle"}
        title="Receipt"
        label={outcome ? "Recorded" : "Pending"}
        at={since(run, outcome ? run?.settledAt : null)}
      >
        {outcome ? (
          <p className="receipt-line">
            <code>{outcome.receipt.receipt_id}</code>
            <Badge tone={STATUS_TONE[outcome.receipt.status]}>
              {outcome.receipt.status}
            </Badge>
            <button
              className="link-button"
              onClick={() => onShowReceipt(outcome.receipt.receipt_id)}
            >
              Show in ledger
            </button>
          </p>
        ) : (
          <p>Written when the run ends, including a stopped run.</p>
        )}
      </Stage>
    </ol>
  );
}

function since(run: RunTrace | null, at: number | null | undefined) {
  if (!run || at == null) return null;
  return `+${formatDuration(at - run.startedAt)}`;
}

function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function Stage({
  state,
  title,
  label,
  at,
  stageRef,
  children,
}: {
  state: StageState;
  title: string;
  label: string;
  at: string | null;
  stageRef?: RefObject<HTMLLIElement | null>;
  children: ReactNode;
}) {
  return (
    <li className={`stage ${state}`} ref={stageRef}>
      <span className="stage-mark" aria-hidden="true">
        {state === "done" ? (
          <Icon name="check" />
        ) : state === "held" ? (
          <Icon name="stop" />
        ) : null}
      </span>
      <div className="stage-body">
        <div className="stage-head">
          <h3>{title}</h3>
          <span className="stage-state">{label}</span>
          {at && <span className="stage-time">{at}</span>}
        </div>
        {children}
      </div>
    </li>
  );
}

function ReplayWindow({
  windowMs,
  startedAt,
  stopAt,
  endedAt,
  state,
  remote,
}: {
  windowMs: number;
  startedAt: number | null;
  stopAt: number | null;
  endedAt: number | null;
  state: StageState;
  remote: boolean;
}) {
  const now = useNow(
    state === "active" && startedAt !== null && endedAt === null,
  );
  const total = Math.round(windowMs / CHECKPOINT_MS);
  const elapsed =
    state === "done"
      ? windowMs
      : startedAt === null
        ? 0
        : Math.max(0, Math.min(windowMs, (endedAt ?? now) - startedAt));
  const reached =
    state === "done"
      ? total
      : Math.min(total, Math.floor(elapsed / CHECKPOINT_MS));
  const seconds = windowMs / 1000;
  const marks = Array.from({ length: Math.floor(seconds) + 1 }, (_, i) => i);

  let caption: ReactNode;
  if (state === "held" && startedAt !== null && endedAt !== null)
    caption =
      stopAt !== null ? (
        <>
          Stop latched at {formatSeconds(stopAt - startedAt)}. The next
          checkpoint rejected the token at {formatSeconds(endedAt - startedAt)}{" "}
          and nothing was read.
        </>
      ) : (
        <>
          The token went stale and the run was held at{" "}
          {formatSeconds(endedAt - startedAt)}. Nothing was read.
        </>
      );
  else if (state === "held")
    caption =
      "A stop invalidated the token during the replay. Nothing was read.";
  else if (state === "done")
    caption = "Every checkpoint passed, then the fixture was read.";
  else if (state === "skipped")
    caption = "The gate denied the run, so the fixture was not read.";
  else if (remote)
    caption = "Paced on the server. Progress isn't streamed over HTTP.";
  else
    caption = `Paced so you can stop it. The stop token is checked every ${CHECKPOINT_MS} ms.`;

  return (
    <div className={`replay-window ${state}`}>
      <div className="window-readout">
        <span className="window-elapsed">
          {startedAt === null && state === "held"
            ? "Untimed"
            : `${(elapsed / 1000).toFixed(1)} s`}
        </span>
        <span>of {seconds.toFixed(1)} s</span>
      </div>
      <div
        className="checkpoints"
        role="progressbar"
        aria-label="Replay window"
        aria-valuemin={0}
        aria-valuemax={windowMs}
        aria-valuenow={Math.round(elapsed)}
        aria-valuetext={`${(elapsed / 1000).toFixed(1)} of ${seconds.toFixed(1)} seconds`}
        style={{ "--checkpoints": total } as CSSProperties}
      >
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={
              index < reached
                ? "ran"
                : state === "held" && startedAt !== null
                  ? index === reached
                    ? "hit"
                    : "drained"
                  : ""
            }
            style={{ "--i": index - reached } as CSSProperties}
          />
        ))}
      </div>
      <div className="window-axis" aria-hidden="true">
        {marks.map((mark) => (
          <span key={mark}>{mark} s</span>
        ))}
      </div>
      <p>{caption}</p>
    </div>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    let frame = requestAnimationFrame(function tick() {
      setNow(performance.now());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return now;
}

function Release({ outcome }: { outcome: ActionResponse }) {
  if (!outcome.result)
    return (
      <section className="release held" aria-labelledby="release-title">
        <h3 id="release-title">Nothing released</h3>
        <p>
          {outcome.policy.code === "denied.stop-during-execution"
            ? "The stopped run returned no result and no source records. Its receipt is the only output."
            : "The gate denied the run before it started. Its receipt is the only output."}
        </p>
      </section>
    );
  return <Evidence result={outcome.result} sources={outcome.sources} />;
}

function Evidence({
  result,
  sources,
}: {
  result: DemoResult;
  sources: ActionResponse["sources"];
}) {
  return (
    <section className="release" aria-labelledby="release-title">
      <h3 id="release-title">Released evidence</h3>
      <p>{result.summary}</p>
      <dl className="signals">
        {result.signals.map((signal) => (
          <div key={signal.label}>
            <dt>{signal.label}</dt>
            <dd>
              <span className={`signal ${signal.state}`}>{signal.state}</span>
              {signal.value}
            </dd>
          </div>
        ))}
      </dl>
      <h4>Recommended sequence</h4>
      <ol className="sequence">
        {result.recommended_sequence.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <h4>Source records</h4>
      <ul className="sources">
        {sources.map((source) => (
          <li key={source.source_id}>
            <span>{source.label}</span>
            <time dateTime={source.captured_at}>
              {source.captured_at.slice(0, 16).replace("T", " ")} UTC
            </time>
            <code title={source.fingerprint}>
              {shortHash(source.fingerprint)}
            </code>
          </li>
        ))}
      </ul>
      <p className="note">
        These recommendations come from the fixture and were not carried out.
      </p>
    </section>
  );
}

function Ledger({
  receipts,
  connection,
  openId,
  onToggle,
}: {
  receipts: Receipt[];
  connection: Connection;
  openId: string | null;
  onToggle: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | Receipt["status"]>("all");
  // Rows already loaded on first contact skip the arrival highlight.
  const known = useRef<Set<string> | null>(null);
  if (known.current === null && connection !== "connecting")
    known.current = new Set(receipts.map((receipt) => receipt.receipt_id));
  const shown = receipts.filter(
    (receipt) => filter === "all" || receipt.status === filter,
  );

  return (
    <section className="panel ledger" aria-labelledby="ledger-title">
      <div className="ledger-head">
        <h2 id="ledger-title">Receipt ledger</h2>
        <span className="count">{receipts.length}</span>
        <label className="visually-hidden" htmlFor="ledger-filter">
          Filter by status
        </label>
        <select
          id="ledger-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value as typeof filter)}
        >
          <option value="all">All statuses</option>
          {STATUS_FILTERS.map((status) => (
            <option key={status} value={status}>
              {status} ({receipts.filter((r) => r.status === status).length})
            </option>
          ))}
        </select>
      </div>
      {receipts.length === 0 ? (
        <div className="ledger-empty">
          <p>
            {connection === "unavailable"
              ? "Receipts can't be loaded until the backend answers."
              : "No receipts yet. Each replay, stop and reset writes one with these fields."}
          </p>
          <dl className="fields schema">
            {RECEIPT_SCHEMA.map(([field, description]) => (
              <div key={field}>
                <dt>{field}</dt>
                <dd>{description}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <ul className="receipts">
          {receipts.map((receipt) => (
            <ReceiptRow
              key={receipt.receipt_id}
              receipt={receipt}
              hidden={!shown.includes(receipt)}
              fresh={
                known.current !== null && !known.current.has(receipt.receipt_id)
              }
              open={openId === receipt.receipt_id}
              onToggle={() => onToggle(receipt.receipt_id)}
            />
          ))}
          {shown.length === 0 && (
            <li className="ledger-none">No {filter} receipts.</li>
          )}
        </ul>
      )}
      <p className="ledger-note">
        {DEMO_MODE
          ? "Kept in this tab's memory and cleared on reload."
          : "The latest receipts from your local backend."}{" "}
        Receipts hold metadata and fingerprints, never the instruction or
        result.
      </p>
    </section>
  );
}

function ReceiptRow({
  receipt,
  hidden,
  fresh,
  open,
  onToggle,
}: {
  receipt: Receipt;
  hidden: boolean;
  fresh: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const detail = `receipt-fields-${receipt.receipt_id}`;
  return (
    <li
      id={`receipt-${receipt.receipt_id}`}
      className={`receipt ${receipt.status} ${fresh ? "fresh" : ""}`}
      hidden={hidden}
    >
      <button
        className="receipt-row"
        aria-expanded={open}
        aria-controls={detail}
        onClick={onToggle}
      >
        <Badge tone={STATUS_TONE[receipt.status]}>{receipt.status}</Badge>
        <code className="receipt-kind">{receipt.action_kind}</code>
        <time dateTime={receipt.created_at}>
          {formatTime(receipt.created_at)}
        </time>
        <code className="receipt-policy">{receipt.policy_code}</code>
        <code className="receipt-hash" aria-label="Request fingerprint">
          {receipt.request_fingerprint.slice(0, 8)}
        </code>
      </button>
      {open && (
        <dl className="fields" id={detail}>
          <Field name="receipt_id" value={receipt.receipt_id} />
          <Field name="created_at" value={receipt.created_at} />
          <Field name="status" value={receipt.status} />
          <Field name="action_kind" value={receipt.action_kind} />
          <Field name="capability" value={receipt.capability} />
          <Field name="policy_code" value={receipt.policy_code} />
          <Field
            name="stop_generation"
            value={String(receipt.stop_generation)}
          />
          <Field
            name="request_fingerprint"
            value={receipt.request_fingerprint}
          />
          <Field
            name="result_fingerprint"
            value={receipt.result_fingerprint ?? "null"}
            note={receipt.result_fingerprint ? undefined : "nothing released"}
          />
          <Field name="synthetic" value={String(receipt.synthetic)} />
        </dl>
      )}
    </li>
  );
}

function Field({
  name,
  value,
  note,
}: {
  name: string;
  value: string;
  note?: string;
}) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <code>{value}</code>
        {note && <span className="field-note">{note}</span>}
      </dd>
    </div>
  );
}

function Rules({ system }: { system: SystemState | null }) {
  return (
    <section className="rules" id="rules" aria-labelledby="rules-title">
      <h2 id="rules-title">Operating rules</h2>
      <div className="rules-grid">
        <div className="rules-block wide">
          <h3>Allowed actions</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Capability</th>
                  <th scope="col">Risk</th>
                  <th scope="col">Effect</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "fixture.replay",
                    "fixtures.read",
                    "read_only",
                    "Replays the incident drill",
                  ],
                  [
                    "stop.enable",
                    "control.stop",
                    "safety_control",
                    "Latches the stop and invalidates issued tokens",
                  ],
                  [
                    "stop.reset",
                    "control.reset",
                    "safety_control",
                    "Reopens the boundary after an explicit acknowledgement",
                  ],
                ].map(([kind, capability, risk, effect]) => (
                  <tr key={kind}>
                    <td>
                      <code>{kind}</code>
                    </td>
                    <td>
                      <code>{capability}</code>
                    </td>
                    <td>
                      <code>{risk}</code>
                    </td>
                    <td>{effect}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Anything else is denied, including writes and live executors.
            {system && (
              <>
                {" "}
                The gateway reports{" "}
                {system.capabilities.map((capability, index) => (
                  <span key={capability}>
                    {index > 0 &&
                      (index === system.capabilities.length - 1
                        ? " and "
                        : ", ")}
                    <code>{capability}</code>
                  </span>
                ))}
                .
              </>
            )}
          </p>
        </div>
        <div className="rules-block">
          <h3>Gate checks</h3>
          <dl className="rule-list">
            <dt>
              <code>capability.allowlisted</code>
            </dt>
            <dd>Action, capability and risk match one row above.</dd>
            <dt>
              <code>executor.synthetic</code>
            </dt>
            <dd>The executor is the embedded fixture, not a live system.</dd>
            <dt>
              <code>stop.open-or-control</code>
            </dt>
            <dd>The stop isn't latched, or the action is a stop or reset.</dd>
            <dt>
              <code>writes.denied</code>
            </dt>
            <dd>The action carries no write risk.</dd>
            <dt>
              <code>stop.token-current</code>
            </dt>
            <dd>
              Checked every {CHECKPOINT_MS} ms during the replay. A stop makes
              the token stale and holds the run.
            </dd>
          </dl>
        </div>
        <div className="rules-block">
          <h3>Receipt contents</h3>
          <dl className="rule-list">
            <dt>Stored</dt>
            <dd>
              Status, action, capability, gate decision, time, stop generation,
              and SHA-256 fingerprints of the request and result.
            </dd>
            <dt>Not stored</dt>
            <dd>The instruction text, source content or result body.</dd>
            <dt>Reset</dt>
            <dd>
              Needs an explicit acknowledgement and writes its own receipt.
              Tokens issued before the stop stay invalid.
            </dd>
          </dl>
        </div>
        <div className="rules-block">
          <h3>Known limits</h3>
          <ul className="limits">
            {(
              system?.limitations ?? [
                "No network providers or live integrations are implemented.",
                "Receipts prove local processing metadata, not external-world truth.",
              ]
            ).map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
          <a
            href={`${SOURCE_URL}/blob/main/SECURITY.md`}
            target="_blank"
            rel="noreferrer"
          >
            Security model
          </a>
        </div>
      </div>
    </section>
  );
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

type IconName = "play" | "stop" | "reset" | "check" | "cross" | "dot";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    play: <path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none" />,
    stop: (
      <rect
        x="4"
        y="4"
        width="8"
        height="8"
        rx="1"
        fill="currentColor"
        stroke="none"
      />
    ),
    reset: (
      <>
        <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3" />
        <path d="M4.5 2v3h3" />
      </>
    ),
    check: <path d="m4 8.5 2.5 2.5L12 5.5" />,
    cross: <path d="m5 5 6 6M11 5l-6 6" />,
    dot: <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />,
  };
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="7" fill="currentColor" />
      <path
        d="M10 6v20M22 6v20M10 11c8 0 4 10 12 10M10 21c8 0 4-10 12-10"
        stroke="var(--surface)"
        strokeWidth="2"
      />
    </svg>
  );
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : formatSeconds(ms);
}

function formatSeconds(ms: number) {
  return `${(ms / 1000).toFixed(2)} s`;
}

function shortHash(value: string) {
  return `${value.slice(0, 12)}…`;
}

function formatTime(value: string) {
  return timeFormatter.format(new Date(value));
}

export default App;

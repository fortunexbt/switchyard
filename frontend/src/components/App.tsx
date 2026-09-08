import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useControlPlane } from "../hooks/useControlPlane";
import type {
  ActionResponse,
  DemoResult,
  Receipt,
  SystemState,
} from "../lib/api";

type View = "dispatch" | "receipts" | "policy";
type ReceiptFilter = "all" | Receipt["status"];
const RECEIPT_FILTERS: ReceiptFilter[] = [
  "all",
  "completed",
  "blocked",
  "stopped",
  "failed",
];
const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
});
type IconName =
  | "route"
  | "ledger"
  | "shield"
  | "arrow"
  | "stop"
  | "check"
  | "refresh"
  | "external"
  | "file"
  | "close";
const DEFAULT_COMMAND =
  "Trace the safest recovery route for the captured orbital relay incident.";
const VIEWS: { id: View; label: string }[] = [
  { id: "dispatch", label: "Dispatch" },
  { id: "receipts", label: "Receipt ledger" },
  { id: "policy", label: "Operating rules" },
];
const CHECK_LABELS: Record<string, string> = {
  "capability.allowlisted": "Capability allowlisted",
  "executor.synthetic": "Synthetic executor",
  "stop.open-or-control": "Stop boundary clear",
  "writes.denied": "External writes denied",
  "stop.token-current": "Execution token current",
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    route: (
      <>
        <path d="M5 4v16M19 4v4c0 5-14 3-14 9M12 4v16" />
        <path d="m16 5 3-3 3 3" />
      </>
    ),
    ledger: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    check: <path d="m5 12 4 4L19 6" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M5.5 7a7 7 0 0 1 11.7-2L20 8M4 16l2.8 3A7 7 0 0 0 18.5 17" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14" />
        <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      </>
    ),
    file: (
      <>
        <path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
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
      <path
        d="M7 3v26M25 3v26M7 9c12 0 6 14 18 14M7 23c12 0 6-14 18-14"
        stroke="currentColor"
        strokeWidth="2.5"
      />
    </svg>
  );
}

function App() {
  const plane = useControlPlane();
  const { system, receipts, outcome, busy, controlBusy, connection, notice } =
    plane;
  const [view, setView] = useState<View>("dispatch");
  const [command, setCommand] = useState(DEFAULT_COMMAND);
  const [confirmReset, setConfirmReset] = useState(false);
  const [ledgerQuery, setLedgerQuery] = useState("");
  const resetDialog = useRef<HTMLDialogElement>(null);
  const connected = connection === "connected";
  const stopped = system?.stop.enabled ?? false;
  const canDispatch =
    connected &&
    !stopped &&
    !busy &&
    !controlBusy &&
    command.trim().length >= 3;

  useEffect(() => {
    if (confirmReset) resetDialog.current?.showModal();
    else resetDialog.current?.close();
  }, [confirmReset]);

  function navigate(next: View) {
    setLedgerQuery("");
    setView(next);
    clearResultAnchor();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function inspectReceipt(receipt: Receipt) {
    setLedgerQuery(receipt.receipt_id);
    setView("receipts");
    clearResultAnchor();
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function dispatch(event?: FormEvent) {
    event?.preventDefault();
    if (canDispatch) void plane.dispatch(command);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="masthead">
        <button
          className="brand"
          onClick={() => navigate("dispatch")}
          aria-label="Switchyard dispatch"
        >
          <BrandMark />
          <span>Switchyard</span>
        </button>
        <span className="masthead-caption">
          Offline execution lab
          <br />
          Policy. Stop. Record.
        </span>
        <div className="runtime-status">
          <span className={`connection ${connection}`}>
            <i />
            {connected
              ? "Connected locally"
              : connection === "connecting"
                ? "Connecting…"
                : "Backend unavailable"}
          </span>
          <span className="runtime-mode">
            Offline fixture · No live systems
          </span>
        </div>
        <button
          className={`stop-control ${connected && stopped ? "latched" : ""}`}
          onClick={() =>
            connected && stopped ? setConfirmReset(true) : void plane.stopNow()
          }
          disabled={controlBusy}
          aria-label={
            connected && stopped ? "Review stop reset" : "Stop execution"
          }
        >
          <Icon name={connected && stopped ? "refresh" : "stop"} size={16} />
          {controlBusy
            ? "Confirming…"
            : connected && stopped
              ? "Reset stop"
              : "Stop execution"}
        </button>
      </header>
      <nav className="workspace-nav" aria-label="Workspace">
        {VIEWS.map((item, index) => (
          <button
            key={item.id}
            aria-current={view === item.id ? "page" : undefined}
            className={view === item.id ? "active" : ""}
            onClick={() => navigate(item.id)}
          >
            <span>0{index + 1}</span>
            {item.label}
            {item.id === "receipts" && (
              <span className="nav-count">{receipts.length}</span>
            )}
          </button>
        ))}
        <a
          href="https://github.com/fortunexbt/switchyard"
          target="_blank"
          rel="noreferrer"
        >
          Source
          <Icon name="external" size={14} />
        </a>
      </nav>
      <main id="workspace" tabIndex={-1}>
        <div className="page-heading">
          <div>
            <p className="overline">
              {view === "dispatch"
                ? "INSPECTION DRILL / 2026.07.1"
                : view === "receipts"
                  ? "THE RECORD"
                  : "THE CONTRACT"}
            </p>
            <h1>
              {view === "dispatch" ? (
                <>
                  Orbital relay
                  <br />
                  <span>recovery.</span>
                </>
              ) : view === "receipts" ? (
                <>
                  Receipt
                  <br />
                  <span>ledger.</span>
                </>
              ) : (
                <>
                  Operating
                  <br />
                  <span>rules.</span>
                </>
              )}
            </h1>
          </div>
          <div className="page-context">
            {view === "dispatch" && (
              <div className="incident-reading">
                <strong>
                  17<span>s</span>
                </strong>
                <span>
                  HEARTBEAT JITTER
                  <br />
                  RELAY 07 · CAPTURED
                </span>
              </div>
            )}
            <p>
              {view === "dispatch"
                ? "A drifting relay. An overlapping maintenance window. Investigate the captured evidence inside a read-only boundary."
                : view === "receipts"
                  ? "A local record of replays, stops, and resets. Expand a row to inspect the full receipt."
                  : "One fixed incident. Three allowed capabilities. Everything else is denied."}
            </p>
            <span>
              {view === "dispatch"
                ? "SYNTHETIC CAPTURE · 21 JUL 2026"
                : "LOCAL PROCESSING METADATA ONLY"}
            </span>
          </div>
        </div>
        {!connected && (
          <div className="connection-banner" role="status">
            <div>
              <strong>
                {connection === "connecting"
                  ? "Connecting to the local backend"
                  : "The boundary state is unconfirmed."}
              </strong>
              <p>Dispatch stays paused until the backend responds.</p>
            </div>
            <button
              className="text-button"
              onClick={() => void plane.refresh()}
            >
              Retry connection
              <Icon name="arrow" size={17} />
            </button>
          </div>
        )}
        {connected && stopped && (
          <div className="stop-banner" role="status">
            <div>
              <strong>Execution is stopped.</strong>
              <p>
                Issued tokens are invalid. Reset explicitly to allow another
                replay.
              </p>
            </div>
            <button
              className="text-button"
              onClick={() => setConfirmReset(true)}
              disabled={controlBusy}
            >
              Review reset
              <Icon name="arrow" size={17} />
            </button>
          </div>
        )}
        {view === "dispatch" && (
          <>
            <section
              className="dispatch-workbench"
              aria-label="Incident replay"
            >
              <form className="dispatch-form" onSubmit={dispatch}>
                <p className="section-label">
                  <span>01</span> Dispatch
                </p>
                <h2>Replay it. Try stopping it.</h2>
                <p className="dispatch-description">
                  The replay is deliberately paced so you can interrupt it. A
                  completed run releases evidence. A stopped run releases only a
                  receipt.
                </p>
                <button
                  className="primary-button run-button"
                  type="submit"
                  disabled={!canDispatch}
                >
                  {busy
                    ? "Replay pending…"
                    : stopped && connected
                      ? "Execution stopped"
                      : "Replay incident"}
                  <Icon name="arrow" size={22} />
                </button>
                <div className="dispatch-feedback">
                  {command.trim().length < 3 && (
                    <p className="form-validation" role="alert">
                      The receipt annotation needs at least 3 characters.
                    </p>
                  )}
                  {busy && (
                    <p className="inspection-hint">
                      <span className="pending-mark" aria-hidden="true" />
                      Use <strong>Stop execution</strong> before the replay
                      finishes.
                    </p>
                  )}
                  {outcome && !busy && (
                    <a className="result-jump" href="#run-result">
                      {outcome.result
                        ? "Inspect the captured result"
                        : "Inspect the held run"}
                      <span aria-hidden="true">↓</span>
                    </a>
                  )}
                </div>
                <details className="instruction-details">
                  <summary>
                    Receipt annotation<span>+</span>
                  </summary>
                  <label htmlFor="operator-command">Operator instruction</label>
                  <textarea
                    id="operator-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    maxLength={500}
                    rows={3}
                    disabled={busy}
                    spellCheck={false}
                    aria-describedby="command-help"
                    onKeyDown={(event) => {
                      if (
                        (event.metaKey || event.ctrlKey) &&
                        event.key === "Enter"
                      ) {
                        event.preventDefault();
                        dispatch();
                      }
                    }}
                  />
                  <p id="command-help">
                    {command.length} / 500 · Fingerprinted, never stored. This
                    text does not change the fixed replay.
                  </p>
                </details>
              </form>
              <div className="route-surface">
                <div className="section-label">
                  <span>02</span> Execution route
                  <strong className={stopped && connected ? "held-label" : ""}>
                    {!connected
                      ? "Unconfirmed"
                      : stopped
                        ? "Stop latched"
                        : busy
                          ? "Request pending"
                          : "Boundary open"}
                  </strong>
                </div>
                <RouteDiagram
                  outcome={outcome}
                  busy={busy}
                  stopped={connected && stopped}
                />
                <div className="route-reading">
                  <span>
                    {busy
                      ? "Paced replay requested. Waiting for the backend receipt."
                      : outcome
                        ? outcome.receipt.status === "completed"
                          ? "Last replay completed. Its receipt is recorded below."
                          : `Execution held: ${outcome.policy.code}`
                        : "The gate checks the capability, executor, and stop token."}
                  </span>
                  <code>
                    GEN{" "}
                    {connected
                      ? String(system?.stop.generation).padStart(2, "0")
                      : "—"}
                  </code>
                </div>
                <details className="policy-disclosure">
                  <summary>
                    Inspect policy checks<span>+</span>
                  </summary>
                  <PolicyInspector outcome={outcome} busy={busy} />
                </details>
              </div>
            </section>
            <p className="activity-notice" role="status">
              <span>↳</span>
              {notice}
            </p>
            {outcome?.result && (
              <ResultPanel
                outcome={outcome}
                result={outcome.result}
                onInspect={() => inspectReceipt(outcome.receipt)}
              />
            )}
            {outcome && !outcome.result && (
              <HeldResult
                outcome={outcome}
                onInspect={() => inspectReceipt(outcome.receipt)}
              />
            )}
            <div className="section-heading recent-heading">
              <div>
                <span className="section-number">03</span>
                <h2>Recent receipts</h2>
              </div>
              <button
                className="text-button"
                onClick={() => navigate("receipts")}
              >
                Open ledger
                <Icon name="arrow" size={17} />
              </button>
            </div>
            <ReceiptList
              receipts={receipts.slice(0, 4)}
              unavailable={!connected}
            />
          </>
        )}
        {view !== "dispatch" && (
          <p className="activity-notice" role="status">
            <span>↳</span>
            {notice}
          </p>
        )}
        {view === "receipts" && (
          <Ledger
            key={ledgerQuery}
            initialQuery={ledgerQuery}
            receipts={receipts}
            connected={connected}
            refresh={plane.refresh}
            onDispatch={() => navigate("dispatch")}
          />
        )}
        {view === "policy" && (
          <OperatingRules system={system} connected={connected} />
        )}
        <footer className="page-footer">
          <span>SWITCHYARD</span>
          <p>Commands are temporary. The record is metadata.</p>
          <a
            href="https://github.com/fortunexbt/switchyard"
            target="_blank"
            rel="noreferrer"
          >
            Source <Icon name="external" size={12} />
          </a>
        </footer>
      </main>
      <dialog
        ref={resetDialog}
        className="reset-dialog"
        aria-labelledby="reset-title"
        onCancel={() => setConfirmReset(false)}
        onClose={() => setConfirmReset(false)}
      >
        <span className="dialog-icon">
          <Icon name="refresh" size={24} />
        </span>
        <h2 id="reset-title">Reset the stop boundary?</h2>
        <p>
          This permits new synthetic fixture replays. Previously issued tokens
          stay invalid, and the reset is recorded in the receipt ledger.
        </p>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            autoFocus
            onClick={() => setConfirmReset(false)}
          >
            Keep stopped
          </button>
          <button
            className="primary-button"
            disabled={controlBusy || !connected || !stopped}
            onClick={() => {
              setConfirmReset(false);
              void plane.resetStop();
            }}
          >
            Acknowledge & reset
            <Icon name="arrow" size={16} />
          </button>
        </div>
      </dialog>
    </div>
  );
}

function RouteDiagram({
  outcome,
  busy,
  stopped,
}: {
  outcome: ActionResponse | null;
  busy: boolean;
  stopped: boolean;
}) {
  const complete = outcome?.receipt.status === "completed";
  const admitted = outcome?.policy.allowed;
  const nodes = [
    { x: 68, title: "Instruction", sub: "DECLARE" },
    { x: 244, title: "Policy gate", sub: "CHECK" },
    { x: 420, title: "Fixture", sub: "REPLAY" },
    { x: 596, title: "Receipt", sub: "RECORD" },
  ];
  return (
    <svg
      className={`route-diagram ${busy ? "is-pending" : ""}`}
      viewBox="0 0 664 220"
      role="img"
      aria-label={`Route: instruction, policy gate, fixture replay, receipt. ${busy ? "Request pending; individual stage progress is not available." : outcome ? `Last request ${outcome.receipt.status}.` : "No request dispatched."} ${stopped ? "Stop boundary latched." : ""}`}
    >
      <g className={stopped ? "stop-track latched" : "stop-track"}>
        <path d="M244 112V48H420V112" />
        <rect x="284" y="33" width="96" height="29" />
        <text x="332" y="52" textAnchor="middle">
          {stopped ? "STOPPED" : "STOP TOKEN"}
        </text>
      </g>
      <path className="track-base" d="M68 112H596" />
      <path
        className={`track-active ${outcome ? "has-outcome" : ""}`}
        d={complete ? "M68 112H596" : "M68 112H244"}
      />
      <g className="track-arrows">
        <path d="m151 107 5 5-5 5m176-10 5 5-5 5m176-10 5 5-5 5" />
      </g>
      {nodes.map((node, index) => {
        const done =
          !!outcome &&
          (index === 0 ||
            (index === 1 && admitted) ||
            (index === 2 && complete) ||
            index === 3);
        const held =
          !!outcome &&
          ((index === 1 && !admitted) || (index === 2 && !complete));
        return (
          <g
            key={node.title}
            className={`diagram-node ${done ? "done" : ""} ${held ? "held" : ""}`}
          >
            <rect
              className="node-core"
              x={node.x - 19}
              y="93"
              width="38"
              height="38"
            />
            {done ? (
              <path className="node-check" d={`m${node.x - 6} 112 4 4 8-9`} />
            ) : (
              <text
                className="node-number"
                x={node.x}
                y="117"
                textAnchor="middle"
              >
                {String(index + 1).padStart(2, "0")}
              </text>
            )}
            <text className="node-title" x={node.x} y="164" textAnchor="middle">
              {node.title}
            </text>
            <text className="node-sub" x={node.x} y="186" textAnchor="middle">
              {node.sub}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function PolicyInspector({
  outcome,
  busy,
}: {
  outcome: ActionResponse | null;
  busy: boolean;
}) {
  return (
    <section
      className="policy-inspector"
      aria-labelledby="policy-inspector-title"
    >
      <div className="section-heading">
        <div>
          <h2 id="policy-inspector-title">Policy gate</h2>
        </div>
        <span className="subtle-tag">V1</span>
      </div>
      <p className="inspector-description">
        Every check must pass before the fixture can execute.
      </p>
      <ul className="check-list">
        {(
          outcome?.policy.checks.map(({ code }) => [
            code,
            CHECK_LABELS[code] ?? code,
          ]) ??
          Object.entries(CHECK_LABELS).filter(
            ([code]) => code !== "stop.token-current",
          )
        ).map(([code, label]) => {
          const check = outcome?.policy.checks.find(
            (item) => item.code === code,
          );
          return (
            <li key={code}>
              <span
                className={`check-icon ${check ? (check.passed ? "pass" : "fail") : ""}`}
              >
                {check ? (
                  check.passed ? (
                    <Icon name="check" size={13} />
                  ) : (
                    <Icon name="close" size={13} />
                  )
                ) : (
                  <span />
                )}
              </span>
              <span>{label}</span>
              <span className="check-status">
                {check ? (check.passed ? "PASS" : "HELD") : "—"}
              </span>
            </li>
          );
        })}
      </ul>
      <div
        className={`policy-verdict ${outcome?.policy.allowed ? "allowed" : ""}`}
      >
        <span className="mini-label">
          {busy
            ? "AWAITING RESPONSE"
            : outcome
              ? "LAST POLICY DECISION"
              : "POLICY DECISION"}
        </span>
        <strong>
          {outcome
            ? outcome.policy.allowed
              ? "Admitted"
              : "Denied"
            : "Awaiting dispatch"}
        </strong>
        <code>{outcome?.policy.code ?? "switchyard-policy/1"}</code>
      </div>
    </section>
  );
}

function ResultPanel({
  outcome,
  result,
  onInspect,
}: {
  outcome: ActionResponse;
  result: DemoResult;
  onInspect: () => void;
}) {
  return (
    <section
      className="result-panel"
      id="run-result"
      tabIndex={-1}
      aria-labelledby="result-title"
    >
      <div className="result-heading">
        <div>
          <p className="overline">CAPTURED OUTPUT · {result.fixture_version}</p>
          <h2 id="result-title">Recovery drill complete</h2>
          <p>{result.summary}</p>
        </div>
        <button type="button" className="result-badge" onClick={onInspect}>
          <Icon name="check" size={15} />
          Inspect receipt <Icon name="arrow" size={15} />
        </button>
      </div>
      <div className="signal-grid">
        {result.signals.map((signal) => (
          <div key={signal.label}>
            <span>
              <i className={`status-dot ${signal.state}`} />
              {signal.label}
            </span>
            <strong>{signal.value}</strong>
          </div>
        ))}
      </div>
      <div className="evidence-grid">
        <div>
          <h3>Recommended sequence</h3>
          <p className="detail-caption">
            Captured recommendations; no actions executed.
          </p>
          <ol>
            {result.recommended_sequence.map((item, index) => (
              <li key={item}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {item}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h3>
            Source evidence
            <span className="subtle-tag">{outcome.sources.length} RECORDS</span>
          </h3>
          <div className="source-list">
            {outcome.sources.map((source) => (
              <details key={source.source_id}>
                <summary>
                  <Icon name="file" size={16} />
                  <span>
                    {source.label}
                    <small>
                      {formatDate(source.captured_at)} · Embedded fixture
                    </small>
                  </span>
                  <span className="disclosure-arrow">+</span>
                </summary>
                <div className="source-detail">
                  <span>SHA-256 fingerprint</span>
                  <code>{source.fingerprint}</code>
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>
      <p className="result-disclosure">
        <Icon name="shield" size={14} />
        {result.disclosure}
      </p>
    </section>
  );
}

function HeldResult({
  outcome,
  onInspect,
}: {
  outcome: ActionResponse;
  onInspect: () => void;
}) {
  const interrupted = outcome.policy.code === "denied.stop-during-execution";
  return (
    <section
      className="held-result"
      id="run-result"
      tabIndex={-1}
      aria-labelledby="held-title"
    >
      <div className="held-result-heading">
        <div>
          <p className="overline">
            {interrupted ? "STOP CHECKPOINT / VERIFIED" : "EXECUTION HELD"}
          </p>
          <h2 id="held-title">
            {interrupted
              ? "Interrupted. Nothing released."
              : "The boundary held."}
          </h2>
          <p>
            {interrupted
              ? "The issued token was invalidated while the replay was running. The backend returned no result and no source records."
              : "The policy gate denied this replay. The request still has an inspectable receipt."}
          </p>
        </div>
        <Icon name="stop" size={35} />
      </div>
      <dl className="held-facts">
        <div>
          <dt>Result</dt>
          <dd>Not emitted</dd>
        </div>
        <div>
          <dt>Source records</dt>
          <dd>{outcome.sources.length}</dd>
        </div>
        <div>
          <dt>Stop generation</dt>
          <dd>{outcome.receipt.stop_generation}</dd>
        </div>
        <div>
          <dt>Policy decision</dt>
          <dd>{outcome.policy.code}</dd>
        </div>
      </dl>
      <button className="text-button" onClick={onInspect}>
        Inspect this receipt
        <Icon name="arrow" size={17} />
      </button>
    </section>
  );
}

function ReceiptList({
  receipts,
  emptyAction,
  filtered = false,
  unavailable = false,
  revealReceiptId,
}: {
  receipts: Receipt[];
  emptyAction?: () => void;
  filtered?: boolean;
  unavailable?: boolean;
  revealReceiptId?: string;
}) {
  if (!receipts.length && unavailable && !filtered)
    return (
      <div className="ledger-empty">
        <h3>Receipt history unavailable.</h3>
        <p>Reconnect to load the local ledger.</p>
      </div>
    );
  if (!receipts.length)
    return (
      <div className="ledger-empty">
        <Icon name="ledger" size={25} />
        <h3>{filtered ? "No matching receipts" : "No receipts yet."}</h3>
        <p>
          {filtered
            ? "Try a different status or search term."
            : "Replay the incident to create the first record."}
        </p>
        {emptyAction && (
          <button className="text-button" onClick={emptyAction}>
            Go to dispatch
            <Icon name="arrow" size={15} />
          </button>
        )}
      </div>
    );
  return (
    <div className="receipt-list">
      <div className="receipt-columns" aria-hidden="true">
        <span>ACTION / STATUS</span>
        <span>POLICY DECISION</span>
        <span>REQUEST FINGERPRINT</span>
        <span>RECORDED</span>
        <span />
      </div>
      {receipts.map((receipt) => (
        <details
          className="receipt-row"
          key={receipt.receipt_id}
          open={receipt.receipt_id === revealReceiptId ? true : undefined}
        >
          <summary>
            <span className="receipt-action">
              <span className={`receipt-symbol ${receipt.status}`}>
                <Icon
                  name={
                    receipt.action_kind === "fixture.replay"
                      ? "route"
                      : receipt.action_kind === "stop.enable"
                        ? "stop"
                        : "refresh"
                  }
                  size={16}
                />
              </span>
              <span>
                <strong>{actionLabel(receipt.action_kind)}</strong>
                <small>
                  <i className={`status-dot ${receipt.status}`} />
                  {receipt.status}
                </small>
              </span>
            </span>
            <code className="receipt-policy">{receipt.policy_code}</code>
            <code className="receipt-hash">
              {shortHash(receipt.request_fingerprint)}
            </code>
            <time
              dateTime={receipt.created_at}
              title={formatDate(receipt.created_at)}
            >
              {formatTime(receipt.created_at)}
              <small>{formatDate(receipt.created_at)}</small>
            </time>
            <span className="disclosure-arrow">+</span>
          </summary>
          <div className="receipt-details">
            <div>
              <span>Receipt ID</span>
              <code>{receipt.receipt_id}</code>
            </div>
            <div>
              <span>Capability</span>
              <code>{receipt.capability}</code>
            </div>
            <div>
              <span>Stop generation</span>
              <code>{receipt.stop_generation}</code>
            </div>
            <div>
              <span>Synthetic</span>
              <code>{receipt.synthetic ? "Yes" : "No"}</code>
            </div>
            <div className="full">
              <span>Policy decision</span>
              <code>{receipt.policy_code}</code>
            </div>
            <div className="full">
              <span>Action kind</span>
              <code>{receipt.action_kind}</code>
            </div>
            <div className="full">
              <span>Request fingerprint · SHA-256</span>
              <code>{receipt.request_fingerprint}</code>
            </div>
            <div className="full">
              <span>Result fingerprint · SHA-256</span>
              <code>{receipt.result_fingerprint ?? "No result emitted"}</code>
            </div>
            <p>
              Metadata only. Command and result bodies cannot be recovered from
              this receipt.
            </p>
          </div>
        </details>
      ))}
    </div>
  );
}

function Ledger({
  receipts,
  connected,
  refresh,
  onDispatch,
  initialQuery = "",
}: {
  receipts: Receipt[];
  connected: boolean;
  refresh: () => Promise<void>;
  onDispatch: () => void;
  initialQuery?: string;
}) {
  const [filter, setFilter] = useState<ReceiptFilter>("all");
  const [search, setSearch] = useState(initialQuery);
  const normalizedSearch = search.trim().toLowerCase();
  const shown = receipts.filter(
    (receipt) =>
      (filter === "all" || receipt.status === filter) &&
      [
        receipt.receipt_id,
        receipt.action_kind,
        actionLabel(receipt.action_kind),
        receipt.policy_code,
        receipt.request_fingerprint,
      ].some((value) => value.toLowerCase().includes(normalizedSearch)),
  );
  return (
    <section className="ledger-view">
      <div className="ledger-toolbar">
        <div className="filter-list" aria-label="Filter receipts by status">
          {RECEIPT_FILTERS.map((value) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={filter === value ? "selected" : ""}
            >
              {value === "all" ? "All receipts" : value}
              <span>
                {value === "all"
                  ? receipts.length
                  : receipts.filter((receipt) => receipt.status === value)
                      .length}
              </span>
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          aria-label="Refresh receipts"
          onClick={() => void refresh()}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      <div className="ledger-search">
        <input
          type="search"
          aria-label="Search receipts"
          placeholder="Search action, policy, ID or fingerprint…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <span>
          {shown.length} of {receipts.length} loaded
          {!connected ? " · last known records" : ""}
        </span>
      </div>
      <ReceiptList
        receipts={shown}
        revealReceiptId={initialQuery}
        filtered={receipts.length > 0}
        unavailable={!connected}
        emptyAction={receipts.length ? undefined : onDispatch}
      />
      <p className="ledger-footnote">
        The latest receipts returned by your local backend. Records contain
        metadata and fingerprints only.
      </p>
    </section>
  );
}

function OperatingRules({
  system,
  connected,
}: {
  system: SystemState | null;
  connected: boolean;
}) {
  return (
    <div className="rules-layout">
      <section className="rules-panel">
        <div className="section-heading">
          <div>
            <Icon name="shield" />
            <h2>Capability allowlist</h2>
          </div>
          <span className="subtle-tag">DENY BY DEFAULT</span>
        </div>
        <p className="rules-intro">
          A route is admitted only when its action, capability, and risk match
          an explicit rule.
        </p>
        {[
          ["fixtures.read", "Replay the captured incident", "Read only"],
          ["control.stop", "Invalidate execution tokens", "Safety control"],
          ["control.reset", "Explicitly reset the boundary", "Safety control"],
        ].map(([capability, description, risk]) => (
          <div className="capability-row" key={capability}>
            <Icon name="check" size={17} />
            <div>
              <code>{capability}</code>
              <p>{description}</p>
            </div>
            <span>{risk}</span>
          </div>
        ))}
        <p className="runtime-capabilities">
          <strong>
            {connected
              ? "Runtime declared capabilities"
              : "Runtime capability state unconfirmed"}
          </strong>
          <code>
            {connected
              ? system?.capabilities.join(" · ")
              : "Reconnect to inspect the current backend state."}
          </code>
        </p>
      </section>
      <section className="rules-panel">
        <div className="section-heading">
          <div>
            <h2>Data & evidence</h2>
          </div>
        </div>
        <dl className="data-rules">
          <dt>Stored</dt>
          <dd>
            Status, capability, policy decision, timestamps, token generation,
            and SHA-256 fingerprints.
          </dd>
          <dt>Not stored</dt>
          <dd>Operator commands, source content, and result bodies.</dd>
          <dt>Fixture behavior</dt>
          <dd>
            One versioned orbital relay incident. Instructions are fingerprinted
            but do not alter the deterministic result.
          </dd>
          <dt>Stop behavior</dt>
          <dd>
            Invalidates issued tokens. Reset requires acknowledgement and
            creates its own receipt. Stop state resets when the backend process
            restarts.
          </dd>
        </dl>
      </section>
      <section className="rules-panel limitations-panel">
        <span className="mini-label">OPERATING LIMITS</span>
        <h2>Local proof, with a defined scope.</h2>
        <ul>
          {(
            system?.limitations ?? [
              "No network providers or live integrations are implemented.",
              "Voice input and output are not implemented.",
              "Receipts prove local processing metadata, not external-world truth.",
            ]
          ).map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
        <a
          className="text-button"
          href="https://github.com/fortunexbt/switchyard/blob/main/SECURITY.md"
          target="_blank"
          rel="noreferrer"
        >
          Read the security model
          <Icon name="external" size={14} />
        </a>
      </section>
    </div>
  );
}

function shortHash(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function clearResultAnchor() {
  if (window.location.hash === "#run-result") {
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }
}
function actionLabel(kind: string) {
  return (
    (
      {
        "fixture.replay": "Recovery replay",
        "stop.enable": "Execution stopped",
        "stop.reset": "Stop boundary reset",
      } as Record<string, string>
    )[kind] ?? kind
  );
}
function formatTime(value: string) {
  return timeFormatter.format(new Date(value));
}
function formatDate(value: string) {
  return dateFormatter.format(new Date(value));
}
export default App;

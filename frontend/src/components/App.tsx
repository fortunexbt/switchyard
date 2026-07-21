import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'

type StopState = {
  enabled: boolean
  reason_code: string | null
  generation: number
}

type SystemState = {
  mode: 'offline-proof'
  stop: StopState
  capabilities: string[]
  limitations: string[]
}

type GateCheck = { code: string; passed: boolean }
type PolicyDecision = {
  allowed: boolean
  code: string
  policy_version: string
  checks: GateCheck[]
}

type PlannedAction = {
  action_id: string
  kind: string
  capability: string
  risk: string
  synthetic: boolean
  summary: string
}

type DemoSignal = {
  label: string
  value: string
  state: 'nominal' | 'watch' | 'held'
}

type DemoResult = {
  fixture_id: string
  fixture_version: string
  headline: string
  summary: string
  signals: DemoSignal[]
  recommended_sequence: string[]
  disclosure: string
}

type SourceProof = {
  source_id: string
  label: string
  captured_at: string
  fingerprint: string
  kind: 'embedded_fixture'
}

type Receipt = {
  receipt_id: string
  created_at: string
  status: 'completed' | 'blocked' | 'stopped' | 'failed'
  action_kind: string
  capability: string
  policy_code: string
  stop_generation: number
  request_fingerprint: string
  result_fingerprint: string | null
  synthetic: boolean
}

type ActionResponse = {
  plan: { plan_id: string; actions: PlannedAction[] }
  policy: PolicyDecision
  result: DemoResult | null
  sources: SourceProof[]
  receipt: Receipt
}

type ControlResponse = {
  state: StopState
  policy: PolicyDecision
  receipt: Receipt
}

const DEFAULT_COMMAND = 'Trace the safest recovery route for the captured orbital relay incident.'
const API_BASE = resolveApiBase()

function App() {
  const [command, setCommand] = useState(DEFAULT_COMMAND)
  const [system, setSystem] = useState<SystemState | null>(null)
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [outcome, setOutcome] = useState<ActionResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [controlBusy, setControlBusy] = useState(false)
  const [notice, setNotice] = useState('Ready for an embedded fixture replay.')

  const refresh = useCallback(async () => {
    try {
      const [nextState, nextReceipts] = await Promise.all([
        requestJson('/api/state', isSystemState),
        requestJson('/api/receipts', isReceiptPage),
      ])
      setSystem(nextState)
      setReceipts(nextReceipts.receipts)
    } catch {
      setNotice('Local control plane unavailable. Start the backend, then retry.')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 6_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const routeStatus = useMemo(() => {
    if (!outcome) return ['idle', 'idle', 'idle', 'idle']
    const admitted = outcome.policy.allowed
    const completed = outcome.receipt.status === 'completed'
    return [
      'complete',
      admitted ? 'complete' : 'held',
      completed ? 'complete' : 'held',
      'complete',
    ]
  }, [outcome])

  async function dispatch(event: FormEvent) {
    event.preventDefault()
    if (command.trim().length < 3 || busy) return
    setBusy(true)
    setNotice('Routing through the policy gate…')
    try {
      const response = await fetch(`${API_BASE}/api/actions`, {
        method: 'POST',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command.trim(), fixture_id: 'orbital-relay-recovery' }),
      })
      const payload: unknown = await response.json()
      if (!isActionResponse(payload)) throw new Error('invalid action response')
      setOutcome(payload)
      setNotice(
        payload.receipt.status === 'completed'
          ? 'Route complete. Receipt sealed without storing the command body.'
          : `Route held: ${payload.policy.code}.`,
      )
      await refresh()
    } catch {
      setNotice('The request failed safely. Check the local backend and receipt ledger.')
    } finally {
      setBusy(false)
    }
  }

  async function stopNow() {
    if (controlBusy || system?.stop.enabled) return
    setControlBusy(true)
    setNotice('Latching the stop boundary…')
    try {
      const response = await requestJson(
        '/api/stop',
        isControlResponse,
        { method: 'POST', body: JSON.stringify({ reason: 'operator console stop' }) },
      )
      setSystem((current) => current ? { ...current, stop: response.state } : current)
      setNotice('Stop latched. Started work will fail its next generation checkpoint.')
      await refresh()
    } catch {
      setNotice('Stop request could not be confirmed. Treat the console as unsafe until inspected.')
    } finally {
      setControlBusy(false)
    }
  }

  async function resetStop() {
    if (controlBusy || !system?.stop.enabled) return
    const confirmed = window.confirm('Reset the local stop boundary and permit synthetic fixture execution?')
    if (!confirmed) return
    setControlBusy(true)
    try {
      const response = await requestJson(
        '/api/stop/reset',
        isControlResponse,
        { method: 'POST', body: JSON.stringify({ acknowledge: 'resume synthetic execution' }) },
      )
      setSystem((current) => current ? { ...current, stop: response.state } : current)
      setNotice('Stop reset explicitly. A control receipt was added to the ledger.')
      await refresh()
    } catch {
      setNotice('Reset failed safely; assume the stop remains latched.')
    } finally {
      setControlBusy(false)
    }
  }

  const stopped = system?.stop.enabled ?? false

  return (
    <div className="app-shell">
      <header className="masthead">
        <a className="brand" href="#top" aria-label="Switchyard home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>
            <strong>Switchyard</strong>
            <small>local operator console</small>
          </span>
        </a>
        <div className="mode-cluster" aria-label="Runtime mode">
          <span className="mode-dot" />
          <span>OFFLINE PROOF</span>
          <span className="slash">/</span>
          <span>NO SECRETS</span>
        </div>
      </header>

      <div className={`boundary-strip ${stopped ? 'is-stopped' : ''}`} role="status">
        <span>BOUNDARY {stopped ? 'LATCHED' : 'OPEN'}</span>
        <span>GENERATION {system?.stop.generation ?? '—'}</span>
        <span>{stopped ? 'EXECUTION HELD' : 'SYNTHETIC ROUTES ONLY'}</span>
      </div>

      <main id="top">
        <section className="hero-grid" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">CONTROL WITHOUT THE THEATER</p>
            <h1 id="hero-title">Route actions through a gate you can actually stop.</h1>
            <p className="hero-lede">
              A local-first operator console where execution is planned, policy-checked,
              stoppable, and sealed with a body-free audit receipt.
            </p>
            <div className="proof-points" aria-label="Proof mode guarantees">
              <span>01 / deterministic fixture</span>
              <span>02 / deny-by-default policy</span>
              <span>03 / generation stop token</span>
            </div>
          </div>

          <aside className={`stop-panel ${stopped ? 'is-stopped' : ''}`} aria-labelledby="stop-title">
            <div className="panel-index">SAFETY CONTROL / A</div>
            <h2 id="stop-title">Stop boundary</h2>
            <p>
              Invalidates every issued execution token. Reset is a separate, explicit,
              audited action.
            </p>
            <button
              className="stop-button"
              type="button"
              onClick={() => void stopNow()}
              disabled={controlBusy || stopped}
            >
              <span className="stop-button-core">{stopped ? 'STOPPED' : 'STOP NOW'}</span>
            </button>
            <button
              className="reset-button"
              type="button"
              onClick={() => void resetStop()}
              disabled={controlBusy || !stopped}
            >
              Reset with acknowledgement
            </button>
          </aside>
        </section>

        <section className="operations-grid">
          <form className="dispatch-card" onSubmit={(event) => void dispatch(event)}>
            <div className="card-heading">
              <div>
                <p className="eyebrow">DISPATCH DESK / 01</p>
                <h2>Route a recovery drill</h2>
              </div>
              <span className="fixture-tag">FIXTURE 2026.07.1</span>
            </div>
            <label htmlFor="operator-command">Operator instruction</label>
            <textarea
              id="operator-command"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              maxLength={500}
              rows={4}
              spellCheck="false"
              disabled={busy}
            />
            <div className="dispatch-footer">
              <p>Command is fingerprinted for the receipt, then discarded. No network call is available.</p>
              <button className="route-button" disabled={busy || stopped || command.trim().length < 3}>
                {busy ? 'Routing…' : stopped ? 'Held by stop' : 'Route through gate'}
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </form>

          <section className="route-card" aria-labelledby="route-title">
            <div className="card-heading compact">
              <div>
                <p className="eyebrow">ROUTE TRACE / 02</p>
                <h2 id="route-title">Execution boundary</h2>
              </div>
              <span className={outcome?.policy.allowed ? 'signal admitted' : 'signal'}>
                {outcome ? outcome.policy.code : 'awaiting route'}
              </span>
            </div>
            <ol className="route-line">
              {[
                ['PLAN', 'Declare one exact capability'],
                ['GATE', 'Apply the offline allowlist'],
                ['EXECUTE', 'Replay embedded evidence'],
                ['RECEIPT', 'Persist hashes, never bodies'],
              ].map(([title, detail], index) => (
                <li className={routeStatus[index]} key={title}>
                  <span className="rail-node">{index + 1}</span>
                  <div><strong>{title}</strong><small>{detail}</small></div>
                </li>
              ))}
            </ol>
            <div className="gate-checks">
              {(outcome?.policy.checks ?? []).map((check) => (
                <span className={check.passed ? 'pass' : 'fail'} key={check.code}>
                  {check.passed ? '✓' : '×'} {check.code}
                </span>
              ))}
              {!outcome && <span className="pending">Gate checks appear after dispatch.</span>}
            </div>
          </section>
        </section>

        <p className="console-notice" aria-live="polite">{notice}</p>

        {outcome?.result && (
          <section className="result-deck" aria-labelledby="result-title">
            <div className="result-heading">
              <div>
                <p className="eyebrow">CAPTURED OUTPUT / 03</p>
                <h2 id="result-title">{outcome.result.headline}</h2>
                <p>{outcome.result.summary}</p>
              </div>
              <div className="receipt-stamp">
                <span>SEALED</span>
                <strong>{shortHash(outcome.receipt.result_fingerprint)}</strong>
              </div>
            </div>

            <div className="signal-grid">
              {outcome.result.signals.map((signal) => (
                <article key={signal.label}>
                  <span className={`signal-lamp ${signal.state}`} />
                  <small>{signal.label}</small>
                  <strong>{signal.value}</strong>
                </article>
              ))}
            </div>

            <div className="evidence-grid">
              <div>
                <h3>Recommended sequence</h3>
                <ol className="recommendations">
                  {outcome.result.recommended_sequence.map((item) => <li key={item}>{item}</li>)}
                </ol>
              </div>
              <div>
                <h3>Embedded source proofs</h3>
                <ul className="source-list">
                  {outcome.sources.map((source) => (
                    <li key={source.source_id}>
                      <span>{source.label}</span>
                      <code>{shortHash(source.fingerprint)}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="disclosure">{outcome.result.disclosure}</p>
          </section>
        )}

        <section className="ledger" aria-labelledby="ledger-title">
          <div className="ledger-heading">
            <div>
              <p className="eyebrow">AUDIT LEDGER / 04</p>
              <h2 id="ledger-title">Receipts, not transcripts</h2>
            </div>
            <p>Only status, capability, policy code, generation, timestamps, and fingerprints persist.</p>
          </div>
          <div className="ledger-table" role="table" aria-label="Recent audit receipts">
            <div className="ledger-row ledger-header" role="row">
              <span>Status</span><span>Action</span><span>Policy</span><span>Request fingerprint</span><span>Time</span>
            </div>
            {receipts.length === 0 && <p className="empty-ledger">No receipts yet. Route the embedded drill to create one.</p>}
            {receipts.map((receipt) => (
              <div className="ledger-row" role="row" key={receipt.receipt_id}>
                <span><i className={`status-pip ${receipt.status}`} />{receipt.status}</span>
                <span>{receipt.action_kind}</span>
                <span>{receipt.policy_code}</span>
                <code>{shortHash(receipt.request_fingerprint)}</code>
                <time dateTime={receipt.created_at}>{formatTime(receipt.created_at)}</time>
              </div>
            ))}
          </div>
        </section>

        <section className="truth-strip" aria-label="Known limitations">
          <strong>HONEST OPERATING ENVELOPE</strong>
          <p>{system?.limitations.join(' ') ?? 'Loading declared limitations…'}</p>
        </section>
      </main>

      <footer>
        <span>SWITCHYARD / OFFLINE PROOF MODE</span>
        <span>FastAPI + React · MIT</span>
      </footer>
    </div>
  )
}

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_BASE?.trim()
  if (!configured) return ''
  const url = new URL(configured, window.location.origin)
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !local) {
    throw new Error('VITE_API_BASE must use HTTPS unless it targets loopback')
  }
  return url.href.replace(/\/$/, '')
}

async function requestJson<T>(
  path: string,
  validate: (value: unknown) => value is T,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  const payload: unknown = await response.json()
  if (!response.ok || !validate(payload)) throw new Error('control plane request failed')
  return payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSystemState(value: unknown): value is SystemState {
  return isRecord(value) && value.mode === 'offline-proof' && isRecord(value.stop) && Array.isArray(value.limitations)
}

function isReceipt(value: unknown): value is Receipt {
  return isRecord(value) && typeof value.receipt_id === 'string' && typeof value.status === 'string'
}

function isReceiptPage(value: unknown): value is { receipts: Receipt[] } {
  return isRecord(value) && Array.isArray(value.receipts) && value.receipts.every(isReceipt)
}

function isControlResponse(value: unknown): value is ControlResponse {
  return isRecord(value) && isRecord(value.state) && isReceipt(value.receipt)
}

function isActionResponse(value: unknown): value is ActionResponse {
  return isRecord(value) && isRecord(value.plan) && isRecord(value.policy) && isReceipt(value.receipt) && Array.isArray(value.sources)
}

function shortHash(value: string | null): string {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : 'not emitted'
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value))
}

export default App

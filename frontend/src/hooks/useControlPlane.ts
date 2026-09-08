import { useCallback, useEffect, useRef, useState } from "react";
import {
  isControlResponse,
  isReceiptPage,
  isSystemState,
  requestAction,
  requestJson,
  type ActionResponse,
  type Receipt,
  type SystemState,
} from "../lib/api.ts";

export type Connection = "connecting" | "connected" | "unavailable";

export function useControlPlane() {
  const [system, setSystem] = useState<SystemState | null>(null);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [outcome, setOutcome] = useState<ActionResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [notice, setNotice] = useState(
    "Connecting to the local control plane…",
  );
  const mounted = useRef(true);
  const currentSystem = useRef<SystemState | null>(null);
  const currentConnection = useRef<Connection>("connecting");
  const dispatchLock = useRef(false);
  const controlLock = useRef(false);
  const revision = useRef(0);
  const noticeOwner = useRef(0);
  const noticeKind = useRef<"connection" | "operation">("connection");
  const refreshRunning = useRef<Promise<void> | null>(null);
  const refreshRequested = useRef(false);

  const updateConnection = useCallback((value: Connection) => {
    currentConnection.current = value;
    if (mounted.current) setConnection(value);
  }, []);

  const updateSystem = useCallback((value: SystemState) => {
    currentSystem.current = value;
    if (mounted.current) setSystem(value);
  }, []);

  const operationNotice = useCallback((owner: number, message: string) => {
    if (!mounted.current || owner !== noticeOwner.current) return;
    noticeKind.current = "operation";
    setNotice(message);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    refreshRequested.current = true;
    if (refreshRunning.current) return refreshRunning.current;
    const run = async () => {
      while (refreshRequested.current && mounted.current) {
        refreshRequested.current = false;
        const startedAt = revision.current;
        try {
          const [nextSystem, nextReceipts] = await Promise.all([
            requestJson("/api/state", isSystemState),
            requestJson("/api/receipts", isReceiptPage),
          ]);
          if (!mounted.current) return;
          // Mutations invalidate the whole snapshot, including the ledger. A fresh
          // sequential poll may have a lower generation after a backend restart.
          if (startedAt !== revision.current) {
            refreshRequested.current = true;
            continue;
          }
          updateSystem(nextSystem);
          setReceipts(nextReceipts.receipts);
          updateConnection("connected");
          if (noticeKind.current === "connection") {
            setNotice(
              nextSystem.stop.enabled
                ? "Stop boundary latched. Reset requires acknowledgement."
                : "Local control plane connected. Fixture replay is available.",
            );
          }
        } catch {
          if (!mounted.current) return;
          if (startedAt !== revision.current) {
            refreshRequested.current = true;
            continue;
          }
          updateConnection("unavailable");
          noticeKind.current = "connection";
          setNotice(
            "Local control plane unavailable. Boundary state is unconfirmed. Retry when the backend is running.",
          );
        }
      }
    };
    const pending = run();
    refreshRunning.current = pending;
    try {
      await pending;
    } finally {
      if (refreshRunning.current === pending) refreshRunning.current = null;
    }
  }, [updateConnection, updateSystem]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => {
      // A slow read must finish before polling can schedule another. Explicit
      // mutation refreshes still queue the fresh snapshot they require.
      if (!refreshRunning.current) void refresh();
    }, 6_000);
    return () => {
      mounted.current = false;
      revision.current += 1;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const dispatch = useCallback(
    async (command: string): Promise<void> => {
      const trimmed = command.trim();
      if (
        dispatchLock.current ||
        controlLock.current ||
        currentConnection.current !== "connected" ||
        !currentSystem.current ||
        currentSystem.current.stop.enabled ||
        trimmed.length < 3 ||
        trimmed.length > 500
      )
        return;
      dispatchLock.current = true;
      revision.current += 1;
      const owner = ++noticeOwner.current;
      setBusy(true);
      setOutcome(null);
      operationNotice(
        owner,
        "Dispatch submitted. Waiting for the policy decision and receipt…",
      );
      try {
        const response = await requestAction(trimmed);
        revision.current += 1;
        if (!mounted.current) return;
        setOutcome(response);
        setReceipts((current) => [
          response.receipt,
          ...current.filter(
            (receipt) => receipt.receipt_id !== response.receipt.receipt_id,
          ),
        ]);
        operationNotice(
          owner,
          response.receipt.status === "completed"
            ? "Replay complete. The receipt contains fingerprints; the command body was not stored."
            : `Dispatch held: ${response.policy.code}. A receipt was recorded.`,
        );
      } catch {
        revision.current += 1;
        if (!mounted.current) return;
        updateConnection("unavailable");
        operationNotice(
          owner,
          "Dispatch could not be confirmed. Check the refreshed ledger before trying again.",
        );
      } finally {
        if (mounted.current) await refresh();
        dispatchLock.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [operationNotice, refresh, updateConnection],
  );

  const performControl = useCallback(
    async (kind: "stop" | "reset"): Promise<void> => {
      if (controlLock.current) return;
      if (
        kind === "stop" &&
        currentConnection.current === "connected" &&
        currentSystem.current?.stop.enabled
      )
        return;
      if (
        kind === "reset" &&
        (currentConnection.current !== "connected" ||
          !currentSystem.current?.stop.enabled)
      )
        return;
      controlLock.current = true;
      revision.current += 1;
      const owner = ++noticeOwner.current;
      setControlBusy(true);
      operationNotice(
        owner,
        kind === "stop"
          ? "Latching the stop boundary…"
          : "Submitting the acknowledged reset…",
      );
      try {
        const response = await requestJson(
          kind === "stop" ? "/api/stop" : "/api/stop/reset",
          isControlResponse,
          {
            method: "POST",
            body: JSON.stringify(
              kind === "stop"
                ? { reason: "operator console stop" }
                : { acknowledge: "resume synthetic execution" },
            ),
          },
        );
        revision.current += 1;
        if (!mounted.current) return;
        // A control response can arrive after a newer state read. Keep the newer
        // generation until the following fresh poll can also establish a restart.
        if (
          currentSystem.current &&
          response.state.generation >= currentSystem.current.stop.generation
        ) {
          updateSystem({ ...currentSystem.current, stop: response.state });
        }
        setReceipts((current) => [
          response.receipt,
          ...current.filter(
            (receipt) => receipt.receipt_id !== response.receipt.receipt_id,
          ),
        ]);
        if (
          !response.policy.allowed ||
          response.receipt.status !== "completed"
        ) {
          operationNotice(
            owner,
            `Control request held: ${response.policy.code}.`,
          );
        } else if (response.state.enabled !== (kind === "stop")) {
          throw new Error("Control state did not confirm the request");
        } else {
          operationNotice(
            owner,
            kind === "stop"
              ? "Stop latched. Previously issued execution tokens are invalid."
              : "Stop reset. A control receipt records the acknowledgement.",
          );
        }
      } catch {
        revision.current += 1;
        if (!mounted.current) return;
        updateConnection("unavailable");
        operationNotice(
          owner,
          kind === "stop"
            ? "Stop could not be confirmed. Boundary state must be checked before further dispatch."
            : "Reset could not be confirmed. Check the boundary state before further dispatch.",
        );
      } finally {
        if (mounted.current) await refresh();
        controlLock.current = false;
        if (mounted.current) setControlBusy(false);
      }
    },
    [operationNotice, refresh, updateConnection, updateSystem],
  );

  const stopNow = useCallback(() => performControl("stop"), [performControl]);
  const resetStop = useCallback(
    () => performControl("reset"),
    [performControl],
  );

  return {
    system,
    receipts,
    outcome,
    busy,
    controlBusy,
    connection,
    notice,
    refresh,
    dispatch,
    stopNow,
    resetStop,
  };
}

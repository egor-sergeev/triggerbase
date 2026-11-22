import WebSocket from "ws";
import { openSignalSocket, pull } from "./cloud.js";
import type { Store } from "./store.js";

const minute = 60_000;
const tickMs = 3_000;

// The socket is a hint. HTTPS and the durable inbox remain the delivery protocol.
export function startRelayFeed(store: Store) {
  let socket: WebSocket | undefined;
  let generation = 0,
    pairing = "",
    stopped = false;
  let lastTick = Date.now(),
    nextConnect = 0,
    nextPoll = 0,
    reconnectDelay = minute;
  let nextPing = 0,
    pongDeadline = 0,
    connecting = false;
  let pulling = false,
    requested = false,
    retryPull = false;

  async function sync() {
    requested = true;
    if (pulling) return;
    pulling = true;
    try {
      while (requested && !stopped) {
        requested = false;
        nextPoll = Date.now() + minute;
        if (await pull(store)) requested = true; // A full batch can have a successor.
        retryPull = false;
        store.set("relayError", null);
      }
    } catch (err) {
      retryPull = true;
      store.set("relayError", { error: String(err) });
    } finally {
      pulling = false;
    }
  }

  function reset() {
    generation++;
    socket?.terminate();
    socket = undefined;
    connecting = false;
    pongDeadline = 0;
    nextConnect = nextPoll = 0;
    reconnectDelay = minute;
  }

  async function connect(relay: string, version: number) {
    connecting = true;
    nextConnect = Date.now() + reconnectDelay;
    try {
      const ws = await openSignalSocket(relay);
      ws.on("error", () => ws.terminate());
      if (version !== generation) {
        ws.terminate();
        return;
      }
      socket = ws;
      ws.on("open", () => {
        if (ws !== socket) return;
        reconnectDelay = minute;
        nextPing = Date.now() + minute;
        void sync(); // Includes events committed before the subscription opened.
      });
      ws.on("message", (data) => {
        if (ws === socket && data.toString() === "pending") void sync();
      });
      ws.on("pong", () => {
        if (ws === socket) pongDeadline = 0;
      });
      ws.on("close", () => {
        if (ws !== socket) return;
        socket = undefined;
        pongDeadline = 0;
      });
    } catch {
      // HTTPS polling also reports Keychain and authorization errors in the journal.
    } finally {
      if (version === generation) connecting = false;
    }
  }

  function tick() {
    const now = Date.now();
    const relay = store.get("relay", "");
    const current = JSON.stringify([relay, store.get("relayPairing", "")]);
    // Wall time advances while macOS suspends JS timers, including short sleeps.
    if (current !== pairing || now - lastTick > 2 * tickMs || now < lastTick) {
      reset();
      pairing = current;
    }
    lastTick = now;
    if (!relay) return;
    if (pongDeadline && now >= pongDeadline) {
      reset();
    }
    if (socket?.readyState === WebSocket.OPEN) {
      if (!pongDeadline && now >= nextPing) {
        nextPing = now + minute;
        pongDeadline = now + 15_000;
        socket.ping();
      }
    } else if (!socket && !connecting && now >= nextConnect) {
      void connect(relay, generation);
      reconnectDelay = Math.min(15 * minute, reconnectDelay * 2);
    }
    if ((socket?.readyState !== WebSocket.OPEN || retryPull) && now >= nextPoll)
      void sync();
  }

  tick();
  const timer = setInterval(tick, tickMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    reset();
  };
}

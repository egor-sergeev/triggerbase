import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { openSignalSocket, pull } from "../src/cloud.js";
import { startRelayFeed } from "../src/relay-feed.js";
import type { Store } from "../src/store.js";
vi.mock("../src/cloud.js", () => ({
  openSignalSocket: vi.fn(),
  pull: vi.fn(),
}));
const store = {
  get: (key: string) => (key === "relay" ? "https://relay.example" : ""),
  set: vi.fn(),
} as unknown as Store;
const sockets: Signal[] = [];
class Signal extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  open() {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
  ping() {
    this.emit("pong");
  }
  terminate() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}
let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(pull).mockReset().mockResolvedValue(false);
  vi.mocked(openSignalSocket)
    .mockReset()
    .mockImplementation(async () => {
      const socket = new Signal();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
  sockets.length = 0;
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});
test("connected runner pulls on notification and after a wall-clock sleep gap, without idle polling", async () => {
  stop = startRelayFeed(store);
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(pull).mockClear();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(pull).not.toHaveBeenCalled();
  sockets[0].emit("message", Buffer.from("pending"));
  await vi.advanceTimersByTimeAsync(0);
  expect(pull).toHaveBeenCalledTimes(1);
  vi.setSystemTime(Date.now() + 20_000);
  await vi.advanceTimersByTimeAsync(3000);
  expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
  expect(openSignalSocket).toHaveBeenCalledTimes(2);
  expect(pull).toHaveBeenCalledTimes(2);
});
test("unsupported push uses a minute interval and retries a failed HTTPS pull", async () => {
  vi.mocked(openSignalSocket).mockRejectedValue(Error("unavailable"));
  vi.mocked(pull).mockRejectedValueOnce(Error("offline"));
  stop = startRelayFeed(store);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(pull).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(pull).toHaveBeenCalledTimes(2);
  expect(store.set).toHaveBeenLastCalledWith("relayError", null);
});
test("coalesces notifications during a pull and continues past a full batch", async () => {
  stop = startRelayFeed(store);
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  let release!: (full: boolean) => void;
  const fetch = vi.mocked(pull).mockClear();
  fetch.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  fetch.mockResolvedValueOnce(true);
  for (let i = 0; i < 3; i++)
    sockets[0].emit("message", Buffer.from("pending"));
  expect(fetch).toHaveBeenCalledTimes(1);
  release(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("an unresponsive open socket reconnects and checks the queue", async () => {
  stop = startRelayFeed(store);
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].open();
  vi.spyOn(sockets[0], "ping").mockImplementation(() => {});
  await vi.advanceTimersByTimeAsync(0);
  vi.mocked(pull).mockClear();
  await vi.advanceTimersByTimeAsync(75_000);
  expect(sockets[0].readyState).toBe(WebSocket.CLOSED);
  expect(openSignalSocket).toHaveBeenCalledTimes(2);
  expect(pull).toHaveBeenCalledTimes(1);
});

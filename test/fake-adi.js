const { WebSocketServer } = require("ws");

/*
 * Имитатор ADI (gate-service) для тестов агента: принимает hello с токеном,
 * решает по проходу через decide(), подтверждает события, шлёт команды.
 */
function createFakeAdi({ token = "good-token", decide = () => ({ allow: true }) } = {}) {
  const state = { hellos: [], requests: [], events: [], results: new Map(), sockets: new Set() };
  let wss;
  const api = {
    state,
    decide,
    delayMs: 0,
    listen: () =>
      new Promise((resolve) => {
        wss = new WebSocketServer({ port: 0, host: "127.0.0.1" }, () => resolve(wss.address().port));
        wss.on("connection", (ws) => {
          state.sockets.add(ws);
          ws.on("close", () => state.sockets.delete(ws));
          ws.on("message", (raw) => {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "hello") {
              state.hellos.push(msg);
              if (msg.token !== token) ws.send(JSON.stringify({ type: "error", code: "unauthorized" }));
              else ws.send(JSON.stringify({ type: "welcome", agentId: "agent-1" }));
            } else if (msg.type === "ping") ws.send('{"type":"pong"}');
            else if (msg.type === "access.request") {
              state.requests.push(msg);
              const answer = () => ws.send(JSON.stringify({ type: "access.decision", id: msg.id, ...api.decide(msg) }));
              if (api.delayMs) setTimeout(answer, api.delayMs);
              else answer();
            } else if (msg.type === "event") {
              state.events.push(msg);
              ws.send(JSON.stringify({ type: "ack", id: msg.id }));
            } else if (msg.type === "cmd.result") state.results.set(msg.id, msg);
          });
        });
      }),
    command: (cmd, args = {}, id = `c${Math.random().toString(16).slice(2)}`) => {
      for (const ws of state.sockets) ws.send(JSON.stringify({ type: "cmd", id, cmd, args }));
      return id;
    },
    close: () =>
      new Promise((r) => {
        for (const ws of state.sockets) ws.terminate();
        wss.close(r);
      }),
  };
  return api;
}

module.exports = { createFakeAdi };

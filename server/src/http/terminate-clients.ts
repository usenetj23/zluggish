/**
Drop every WebSocket connection at once so the HTTP listener can close.

During shutdown `server.close()` waits for every connection to end, and an upgraded WebSocket only ends
when the client leaves, so an open browser tab would hang the graceful shutdown. A close handshake is
pointless here: the process is going away and a browser reconnects on its own, so `terminate()` (RST,
immediate) is the right tool.
*/
export function terminateClients(server: { clients: Iterable<{ terminate(): void }> }): number {
  // Snapshot first: `terminate()` removes the client from the set while we iterate it.
  const clients = [...server.clients];

  for (const client of clients) {
    client.terminate();
  }

  return clients.length;
}

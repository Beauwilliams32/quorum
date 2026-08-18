// Central store: collectors write here, every websocket client gets diffs.
export class State {
  constructor() {
    this.data = {}
    this.feed = []
    this.clients = new Set()
  }

  // Set a key and broadcast it (optionally broadcast a lighter payload than what's stored).
  update(key, value, broadcastValue) {
    this.data[key] = value
    this.broadcast({ type: 'update', key, data: broadcastValue !== undefined ? broadcastValue : value })
  }

  // Append to the event feed ring and broadcast.
  event(item) {
    item.ts = Date.now()
    this.feed.push(item)
    if (this.feed.length > 200) this.feed.shift()
    this.broadcast({ type: 'event', item })
  }

  snapshot() {
    return { type: 'snapshot', data: this.data, feed: this.feed }
  }

  broadcast(msg) {
    const s = JSON.stringify(msg)
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s)
  }
}

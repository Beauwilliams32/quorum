#!/usr/bin/env node
import { createRemoteGateway } from '../src/remote-gateway.js'

const bind = process.env.QUORUM_REMOTE_BIND || '127.0.0.1'
const port = Number(process.env.QUORUM_REMOTE_PORT || 4789)
const upstream = process.env.QUORUM_REMOTE_UPSTREAM || `http://127.0.0.1:${process.env.PORT || 4747}`
const gateway = createRemoteGateway({ upstream })

gateway.server.listen(port, bind, () => {
  console.log(`Quorum remote gateway listening on http://${bind}:${port}; upstream remains loopback`)
})

const shutdown = () => gateway.close()
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyProcess, normalizeProcess, platformCapabilities, ProcessController } from '../src/platform-control.js'

test('platform capabilities are explicit and never imply untested host acceptance', () => {
  assert.equal(platformCapabilities('darwin').serviceManager, 'launchd')
  assert.equal(platformCapabilities('linux').hostAccepted, false)
  assert.equal(platformCapabilities('win32').processSignals, false)
})

test('process normalization classifies ownership without exposing arguments', () => {
  const user = normalizeProcess({ pid: 88, ppid: 1, uid: 501, command: '/usr/bin/node /private/app.js --token secret', rssMB: 10 }, { uid: 501, platform: 'darwin' })
  assert.equal(user.ownership, 'user-owned')
  assert.equal(user.executable, '/usr/bin/node')
  assert.equal(JSON.stringify(user).includes('secret'), false)
  assert.equal(classifyProcess({ pid: 1, uid: 0, command: '/sbin/launchd' }, { uid: 501 }).protected, true)
})

test('process actions require an expiring preview and reject protected targets', () => {
  let signal
  const controller = new ProcessController({ clock: () => 1000, kill: (pid, value) => { signal = [pid, value] } })
  const processRecord = { id: 'process:42', pid: 42, name: 'worker', ownership: 'user-owned', protected: false }
  const preview = controller.preview({ action: 'pause', reason: 'test' }, processRecord)
  assert.equal(preview.requiresConfirmation, true)
  const action = controller.confirm(preview.id)
  assert.deepEqual(signal, [42, 'SIGSTOP'])
  assert.equal(action.status, 'executed')
  assert.throws(() => controller.confirm(preview.id), /consumed preview/)
  assert.throws(() => controller.preview({ action: 'terminate' }, { ...processRecord, protected: true }), /privileged broker/)
})

test('process action rejects PID reuse between preview and confirmation', () => {
  const processRecord = { id: 'process:42', pid: 42, name: 'worker', executable: '/usr/bin/worker', ownership: 'user-owned', protected: false }
  const controller = new ProcessController({ kill: () => assert.fail('signal must not be sent'), resolveProcess: () => ({ ...processRecord, name: 'replacement' }) })
  const preview = controller.preview({ action: 'terminate' }, processRecord)
  assert.throws(() => controller.confirm(preview.id), /identity changed/)
  assert.equal(controller.snapshot().audit.at(-1).verification, 'pid-identity-changed')
})

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_PATH = path.join(os.homedir(), '.quorum', 'missions.json')
const MAX_EVENTS = 200
const MAX_TASKS = 80

const id = prefix => `${prefix}-${crypto.randomBytes(6).toString('hex')}`
const text = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)

function read(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function now() { return new Date().toISOString() }

function cleanTask(input, index) {
  const taskId = text(input?.id, 80) || `task-${index + 1}`
  return {
    id: taskId,
    title: text(input?.title || input?.subject, 180) || `Task ${index + 1}`,
    description: text(input?.description, 1200),
    agentId: text(input?.agentId || input?.agent, 60) || null,
    runtimeId: text(input?.runtimeId || input?.runtime, 60) || null,
    modelRef: text(input?.modelRef, 160) || null,
    packId: text(input?.packId, 60) || null,
    roomId: text(input?.roomId, 80) || null,
    worktree: text(input?.worktree, 400) || null,
    branch: text(input?.branch, 180) || null,
    dependsOn: Array.isArray(input?.dependsOn || input?.dependencies) ? [...new Set((input.dependsOn || input.dependencies).map(value => text(value, 80)).filter(Boolean))].slice(0, 20) : [],
    status: ['queued', 'ready', 'working', 'blocked', 'failed', 'cancelled', 'completed'].includes(input?.status) ? input.status : 'queued',
    ptyId: null,
    error: null,
    startedAt: null,
    completedAt: null,
    updatedAt: now(),
  }
}

function normalizeMission(mission) {
  const tasks = Array.isArray(mission.tasks) ? mission.tasks.slice(0, MAX_TASKS) : []
  return {
    id: text(mission.id, 80) || id('mission'),
    title: text(mission.title, 180) || 'Untitled mission',
    objective: text(mission.objective, 4000),
    status: ['planning', 'active', 'blocked', 'completed', 'failed', 'cancelled'].includes(mission.status) ? mission.status : 'planning',
    workspace: text(mission.workspace, 260) || null,
    repository: text(mission.repository, 260) || null,
    branch: text(mission.branch, 180) || null,
    tasks,
    artifacts: Array.isArray(mission.artifacts) ? mission.artifacts.slice(0, 100) : [],
    events: Array.isArray(mission.events) ? mission.events.slice(-MAX_EVENTS) : [],
    createdAt: mission.createdAt || now(),
    updatedAt: mission.updatedAt || now(),
    completedAt: mission.completedAt || null,
  }
}

export class MissionStore {
  constructor(file = process.env.QUORUM_MISSIONS_PATH || DEFAULT_PATH) {
    this.file = path.resolve(file)
    const saved = read(this.file)
    this.missions = new Map(Object.values(saved.missions || {}).map(item => {
      const mission = normalizeMission(item)
      return [mission.id, mission]
    }))
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    const missions = Object.fromEntries([...this.missions].map(([key, mission]) => [key, mission]))
    fs.writeFileSync(temp, JSON.stringify({ version: 1, missions }) + '\n', { mode: 0o600 })
    fs.renameSync(temp, this.file)
  }

  list() {
    return [...this.missions.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  get(missionId) { return this.missions.get(String(missionId)) || null }

  create(input = {}) {
    if (!text(input.title, 180) || !text(input.objective, 4000)) throw new Error('mission title and objective are required')
    const mission = normalizeMission({
      id: id('mission'),
      title: input.title,
      objective: input.objective,
      workspace: input.workspace,
      repository: input.repository,
      branch: input.branch,
      status: 'planning',
      tasks: Array.isArray(input.tasks) ? input.tasks.map(cleanTask) : [],
      events: [{ type: 'MISSION_CREATED', at: now(), detail: 'mission created in Quorum' }],
    })
    const taskIds = new Set()
    for (const task of mission.tasks) {
      if (taskIds.has(task.id)) throw new Error(`duplicate task id: ${task.id}`)
      taskIds.add(task.id)
      if (task.dependsOn.includes(task.id)) throw new Error(`task cannot depend on itself: ${task.id}`)
    }
    for (const task of mission.tasks) for (const dependency of task.dependsOn)
      if (!taskIds.has(dependency)) throw new Error(`unknown task dependency: ${dependency}`)
    this.missions.set(mission.id, mission)
    this.save()
    return mission
  }

  update(missionId, patch = {}) {
    const mission = this.get(missionId)
    if (!mission) throw new Error(`unknown mission: ${missionId}`)
    if (patch.title !== undefined) mission.title = text(patch.title, 180)
    if (patch.objective !== undefined) mission.objective = text(patch.objective, 4000)
    if (patch.status && ['planning', 'active', 'blocked', 'completed', 'failed', 'cancelled'].includes(patch.status)) mission.status = patch.status
    if (patch.workspace !== undefined) mission.workspace = text(patch.workspace, 260) || null
    if (patch.repository !== undefined) mission.repository = text(patch.repository, 260) || null
    if (patch.branch !== undefined) mission.branch = text(patch.branch, 180) || null
    mission.updatedAt = now()
    if (mission.status === 'completed') mission.completedAt = mission.completedAt || mission.updatedAt
    this.save()
    return mission
  }

  task(missionId, taskId) {
    const mission = this.get(missionId)
    const task = mission?.tasks.find(item => item.id === String(taskId))
    if (!mission || !task) throw new Error(`unknown mission task: ${taskId}`)
    return { mission, task }
  }

  readyTasks(missionId) {
    const mission = this.get(missionId)
    if (!mission) throw new Error(`unknown mission: ${missionId}`)
    const completed = new Set(mission.tasks.filter(task => task.status === 'completed').map(task => task.id))
    return mission.tasks.filter(task => ['queued', 'ready'].includes(task.status) && task.dependsOn.every(dep => completed.has(dep)))
  }

  setTask(missionId, taskId, patch = {}) {
    const { mission, task } = this.task(missionId, taskId)
    if (patch.status && ['queued', 'ready', 'working', 'blocked', 'failed', 'cancelled', 'completed'].includes(patch.status)) task.status = patch.status
    if (patch.ptyId !== undefined) task.ptyId = text(patch.ptyId, 100) || null
    if (patch.worktree !== undefined) task.worktree = text(patch.worktree, 400) || null
    if (patch.branch !== undefined) task.branch = text(patch.branch, 180) || null
    if (patch.error !== undefined) task.error = text(patch.error, 1000) || null
    if (patch.startedAt !== undefined) task.startedAt = patch.startedAt
    if (patch.completedAt !== undefined) task.completedAt = patch.completedAt
    task.updatedAt = now()
    if (task.status === 'working') mission.status = 'active'
    if (task.status === 'completed') task.completedAt = task.completedAt || task.updatedAt
    if (mission.tasks.length && mission.tasks.every(item => item.status === 'completed')) {
      mission.status = 'completed'
      mission.completedAt = mission.completedAt || task.updatedAt
    } else if (mission.tasks.some(item => item.status === 'failed')) mission.status = 'failed'
    else if (mission.tasks.some(item => item.status === 'blocked')) mission.status = 'blocked'
    mission.updatedAt = task.updatedAt
    this.save()
    return { mission, task }
  }

  event(missionId, type, detail = '') {
    const mission = this.get(missionId)
    if (!mission) throw new Error(`unknown mission: ${missionId}`)
    mission.events.push({ type: text(type, 80), detail: text(detail, 600), at: now() })
    mission.events = mission.events.slice(-MAX_EVENTS)
    mission.updatedAt = now()
    this.save()
    return mission
  }
}

export function publicMission(mission) {
  if (!mission) return null
  return JSON.parse(JSON.stringify(mission))
}

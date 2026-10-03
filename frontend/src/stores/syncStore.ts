import { createStore } from 'zustand/vanilla'
import type {
  BatchJob,
  CollectPoint,
  FungusRecord,
  IdentifyLog,
  MergeConflict,
  SporePrint,
  SyncBatch,
  SyncOp
} from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { planMerge, validateBatchShape, type LocalData, type PlanResult } from '@/utils/syncPlanner'
import { hasDeviceIdentity, jobIdOf, sourceLabelOf } from '@/utils/syncBatch'
import { recordStore } from '@/stores/recordStore'
import { sporeStore } from '@/stores/sporeStore'
import { pointStore } from '@/stores/pointStore'
import { identifyStore } from '@/stores/identifyStore'

export interface ImportPreview {
  fileName: string
  batch: SyncBatch | null
  legacy: boolean
  sourceLabel: string
  deviceName: string | null
  batchId: string | null
  exportedAt: string | null
  errors: string[]
  conflicts: MergeConflict[]
  plan: PlanResult | null
}

export interface SyncState {
  jobs: BatchJob[]
  loaded: boolean
  runningJobId: string | null
  hydrate: () => Promise<void>
  previewFile: (fileName: string, text: string) => Promise<ImportPreview>
  commitPreview: (preview: ImportPreview) => Promise<{ duplicated: boolean; job?: BatchJob }>
  archiveBlocked: (preview: ImportPreview) => Promise<BatchJob | null>
  resume: (jobId: string) => Promise<void>
  removeJob: (jobId: string) => Promise<void>
  refreshAfterRun: () => Promise<void>
}

async function readLocal(): Promise<LocalData> {
  const [points, records, spores, identifies] = await Promise.all([
    syncAll<CollectPoint>(db.points),
    syncAll<FungusRecord>(db.records),
    syncAll<SporePrint>(db.spores),
    syncAll<IdentifyLog>(db.identifies)
  ])
  return { points, records, spores, identifies }
}

/** 单条写入；upsert 与 append 均按主键确定，重放天然幂等、不重复写 */
async function applyOp(op: SyncOp): Promise<void> {
  switch (op.table) {
    case 'points':
      await db.points.put(op.row as CollectPoint)
      break
    case 'records':
      await db.records.put(op.row as FungusRecord)
      break
    case 'spores':
      await db.spores.put(op.row as SporePrint)
      break
    case 'identifies':
      // 鉴定留痕只追加；op.id 带的是新 id，已防重复追加
      await db.identifies.add(op.row as IdentifyLog)
      break
  }
}

/** 全局只允许一个批次在写，避免两批交叉推进断点 */
let runningId: string | null = null

function emptyPreview(fileName: string, errors: string[]): ImportPreview {
  return {
    fileName,
    batch: null,
    legacy: false,
    sourceLabel: '—',
    deviceName: null,
    batchId: null,
    exportedAt: null,
    errors,
    conflicts: [],
    plan: null
  }
}

export const syncStore = createStore<SyncState>((set, get) => ({
  jobs: [],
  loaded: false,
  runningJobId: null,

  hydrate: async () => {
    const jobs = await syncAll<BatchJob>(db.batchJobs)
    // 写入中途崩溃（页面关闭等）：未写完的任务按暂停处理，等待从断点继续
    jobs.forEach((job) => {
      if (job.status !== 'blocked' && job.doneOpIds.length < job.ops.length) {
        job.status = 'paused'
      }
    })
    jobs.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
    set({ jobs, loaded: true })
  },

  previewFile: async (fileName, text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return emptyPreview(fileName, ['文件不是合法 JSON，无法解析为离线批次'])
    }
    const { errors, batch } = validateBatchShape(parsed)
    if (!batch || errors.length > 0) {
      return emptyPreview(fileName, errors)
    }

    const local = await readLocal()
    const plan = planMerge(batch, local)
    return {
      fileName,
      batch,
      legacy: !hasDeviceIdentity(batch),
      sourceLabel: sourceLabelOf(batch),
      deviceName: batch.deviceName?.trim() || batch.deviceId?.trim() || null,
      batchId: batch.batchId?.trim() || null,
      exportedAt: batch.exportedAt ?? null,
      errors: plan.errors,
      conflicts: plan.conflicts,
      plan: plan.errors.length > 0 ? null : plan
    }
  },

  commitPreview: async (preview) => {
    const batch = preview.batch
    if (!batch || preview.errors.length > 0 || preview.conflicts.length > 0 || !preview.plan) {
      return { duplicated: false }
    }

    const id = jobIdOf(batch)
    const existing = get().jobs.find((job) => job.id === id)
    // 同一设备同一批次 / 同一份旧设备文件已导完：不新建、不混入、不重复写
    if (existing && existing.status === 'done') {
      return { duplicated: true, job: existing }
    }

    const now = new Date().toISOString()
    const job: BatchJob = existing
      ? { ...existing }
      : {
          id,
          legacy: !hasDeviceIdentity(batch),
          deviceId: batch.deviceId?.trim() || null,
          deviceName: batch.deviceName?.trim() || null,
          batchId: batch.batchId?.trim() || null,
          sourceLabel: sourceLabelOf(batch),
          fileName: preview.fileName,
          exportedAt: batch.exportedAt ?? null,
          importedAt: now,
          updatedAt: now,
          status: 'paused',
          conflicts: [],
          ops: preview.plan.ops,
          doneOpIds: [],
          lastError: '',
          summary: preview.plan.summary
        }

    // 冲突解除后同一批次重新预检：替换待写操作；已完成断点仅保留仍存在于新规划中的项
    const validOpIds = new Set(preview.plan.ops.map((op) => op.id))
    job.ops = preview.plan.ops
    job.doneOpIds = job.doneOpIds.filter((opId) => validOpIds.has(opId))
    job.conflicts = []
    job.summary = preview.plan.summary
    job.fileName = preview.fileName
    job.exportedAt = batch.exportedAt ?? null
    job.updatedAt = now
    job.status = 'paused'
    job.lastError = ''

    await db.batchJobs.put(job)
    await get().hydrate()
    void get().resume(id)
    return { duplicated: false, job: (await db.batchJobs.get(id)) ?? job }
  },

  /** 把存在冲突的批次也留档（blocked），便于回看冲突清单；绝不写入任何业务表 */
  archiveBlocked: async (preview: ImportPreview): Promise<BatchJob | null> => {
    const batch = preview.batch
    if (!batch || preview.conflicts.length === 0) return null
    const id = jobIdOf(batch)
    const now = new Date().toISOString()
    const existing = get().jobs.find((job) => job.id === id)
    const job: BatchJob = {
      id,
      legacy: !hasDeviceIdentity(batch),
      deviceId: batch.deviceId?.trim() || null,
      deviceName: batch.deviceName?.trim() || null,
      batchId: batch.batchId?.trim() || null,
      sourceLabel: sourceLabelOf(batch),
      fileName: preview.fileName,
      exportedAt: batch.exportedAt ?? null,
      importedAt: existing?.importedAt ?? now,
      updatedAt: now,
      status: 'blocked',
      conflicts: preview.conflicts,
      ops: [],
      doneOpIds: [],
      lastError: `存在 ${preview.conflicts.length} 处冲突，整批已挡住`,
      summary: preview.plan?.summary ?? { points: 0, records: 0, spores: 0, identifies: 0 }
    }
    await db.batchJobs.put(job)
    await get().hydrate()
    return job
  },

  resume: async (jobId) => {
    if (runningId && runningId !== jobId) return
    runningId = jobId
    set({ runningJobId: jobId })
    try {
      const job = await db.batchJobs.get(jobId)
      if (!job || job.status === 'done' || job.status === 'blocked' || job.conflicts.length > 0) return

      const done = new Set(job.doneOpIds)
      for (const op of job.ops) {
        if (done.has(op.id)) continue
        try {
          // 写入与断点分两步提交：写失败不打断点；按主键重放幂等，重试不重复写入
          await applyOp(op)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await db.batchJobs.update(jobId, {
            status: 'paused',
            lastError: `操作 ${op.id}（${op.table}）写入失败：${message}`,
            updatedAt: new Date().toISOString()
          })
          await get().hydrate()
          return
        }
        done.add(op.id)
        await db.batchJobs.update(jobId, { doneOpIds: [...done] })
      }

      await db.batchJobs.update(jobId, {
        status: 'done',
        lastError: '',
        updatedAt: new Date().toISOString()
      })
      await get().refreshAfterRun()
    } catch (err) {
      // 事务异常等不可预期错误：任务保持暂停，断点不受影响，可再次继续
      const message = err instanceof Error ? err.message : String(err)
      await db.batchJobs.update(jobId, {
        status: 'paused',
        lastError: message,
        updatedAt: new Date().toISOString()
      })
    } finally {
      runningId = null
      set({ runningJobId: null })
      await get().hydrate()
    }
  },

  removeJob: async (jobId) => {
    if (runningId === jobId) return
    await db.batchJobs.delete(jobId)
    await get().hydrate()
  },

  refreshAfterRun: async () => {
    await Promise.all([
      pointStore.getState().hydrate(),
      recordStore.getState().hydrate(),
      sporeStore.getState().hydrate(),
      identifyStore.getState().hydrate()
    ])
  }
}))

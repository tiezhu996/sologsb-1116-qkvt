import { createStore } from 'zustand/vanilla'
import type { ImportJournal, MergePlan, OfflineBatch } from '@/types/sync'
import { db } from '@/hooks/usePersistentStore'
import {
  batchKeyOf,
  buildBatchFile,
  buildMergePlan,
  validateBatchRefs,
  type LocalSnapshot
} from '@/utils/offlineMerge'
import { recordStore } from '@/stores/recordStore'
import { sporeStore } from '@/stores/sporeStore'
import { pointStore } from '@/stores/pointStore'
import { identifyStore } from '@/stores/identifyStore'

const META_DEVICE_ID = 'deviceId'
const META_BATCH_SEQ = 'batchSeq'

/** 读取本地整库快照 */
async function snapshotLocal(): Promise<LocalSnapshot> {
  const [points, records, spores, identifies] = await Promise.all([
    db.points.toArray(),
    db.records.toArray(),
    db.spores.toArray(),
    db.identifies.toArray()
  ])
  return { points, records, spores, identifies }
}

/** 本机设备编号：首次导出时分配并持久化 */
async function ensureDeviceId(): Promise<string> {
  const row = await db.meta.get(META_DEVICE_ID)
  if (row && typeof row.value === 'string' && row.value) return row.value
  const id = `dev_${Math.random().toString(36).slice(2, 8)}`
  await db.meta.put({ key: META_DEVICE_ID, value: id })
  return id
}

async function nextBatchNo(): Promise<string> {
  const row = await db.meta.get(META_BATCH_SEQ)
  const seq = (typeof row?.value === 'number' ? row.value : 0) + 1
  await db.meta.put({ key: META_BATCH_SEQ, value: seq })
  return `B-${String(seq).padStart(4, '0')}`
}

export interface SyncState {
  deviceId: string
  batchSeq: number
  journals: ImportJournal[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 导出离线批次；legacy 为 true 时模拟旧设备：不写设备编号与批次号 */
  exportBatch: (legacy: boolean) => Promise<OfflineBatch>
  /** 构建合并计划（冲突预览），不写库 */
  previewPlan: (batch: OfflineBatch) => MergePlan
  /** 引用完整性校验 */
  validateRefs: (batch: OfflineBatch) => Promise<string[]>
  /**
   * 执行合并：有冲突直接返回计划、不写任何数据；
   * 逐步写入并落台账，中途失败可从断点继续，已写入步骤不会重复执行。
   */
  importBatch: (batch: OfflineBatch, onProgress?: (done: number, total: number, label: string) => void) => Promise<MergePlan>
}

export const syncStore = createStore<SyncState>((set, get) => ({
  deviceId: '',
  batchSeq: 0,
  journals: [],
  loaded: false,

  hydrate: async () => {
    const [deviceRow, seqRow, journals] = await Promise.all([
      db.meta.get(META_DEVICE_ID),
      db.meta.get(META_BATCH_SEQ),
      db.imports.toArray()
    ])
    journals.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    set({
      deviceId: typeof deviceRow?.value === 'string' ? deviceRow.value : '',
      batchSeq: typeof seqRow?.value === 'number' ? seqRow.value : 0,
      journals,
      loaded: true
    })
  },

  exportBatch: async (legacy) => {
    const snap = await snapshotLocal()
    let deviceId = ''
    let batchNo = ''
    if (!legacy) {
      deviceId = await ensureDeviceId()
      batchNo = await nextBatchNo()
    }
    await get().hydrate()
    return buildBatchFile(deviceId, batchNo, snap)
  },

  previewPlan: (batch) => {
    // 预览基于当前各业务 store 的内存状态，与 importBatch 的库内快照规则一致
    const local: LocalSnapshot = {
      points: pointStore.getState().points,
      records: recordStore.getState().records,
      spores: sporeStore.getState().spores,
      identifies: identifyStore.getState().logs
    }
    return buildMergePlan(batch, local)
  },

  validateRefs: async (batch) => validateBatchRefs(batch, await snapshotLocal()),

  importBatch: async (batch, onProgress) => {
    const plan = buildMergePlan(batch, await snapshotLocal())
    if (plan.conflicts.length > 0) return plan

    const now = () => new Date().toISOString()
    const { key, tempSource, sourceLabel } = batchKeyOf(batch)
    const existing = await db.imports.get(key)
    const total = Math.max(existing?.total ?? 0, plan.steps.length)
    const journal: ImportJournal = existing
      ? { ...existing, status: 'applying', error: '', total, updatedAt: now() }
      : {
          key,
          deviceId: batch.deviceId ?? '',
          batchNo: batch.batchNo ?? '',
          tempSource,
          sourceLabel,
          status: 'applying',
          total,
          doneKeys: [],
          error: '',
          startedAt: now(),
          updatedAt: now()
        }
    await db.imports.put(journal)

    const doneSet = new Set(journal.doneKeys)
    try {
      for (const step of plan.steps) {
        // 断点恢复：台账里已完成的步骤直接跳过，重试不重复写入
        if (doneSet.has(step.key)) continue
        // 单步与台账同事务提交：实体写入和进度记录不会脱节
        await db.transaction('rw', [db.points, db.records, db.spores, db.identifies, db.imports], async () => {
          switch (step.table) {
            case 'points':
              await db.points.put(step.data as LocalSnapshot['points'][number])
              break
            case 'records':
              await db.records.put(step.data as LocalSnapshot['records'][number])
              break
            case 'spores':
              await db.spores.put(step.data as LocalSnapshot['spores'][number])
              break
            case 'identifies':
              await db.identifies.put(step.data as LocalSnapshot['identifies'][number])
              break
          }
          const current = await db.imports.get(key)
          const doneKeys = current?.doneKeys ?? []
          if (!doneKeys.includes(step.key)) doneKeys.push(step.key)
          await db.imports.put({ ...(current ?? journal), doneKeys, status: 'applying', updatedAt: now() })
        })
        doneSet.add(step.key)
        onProgress?.(doneSet.size, total, step.label)
      }
    } catch (err) {
      const current = await db.imports.get(key)
      await db.imports.put({
        ...(current ?? journal),
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        updatedAt: now()
      })
      // 失败时可能已有部分步骤落库，同步刷新业务 store 与台账
      await Promise.all([
        recordStore.getState().hydrate(),
        sporeStore.getState().hydrate(),
        pointStore.getState().hydrate(),
        identifyStore.getState().hydrate()
      ])
      await get().hydrate()
      throw err
    }

    const finished = await db.imports.get(key)
    await db.imports.put({ ...(finished ?? journal), status: 'done', error: '', updatedAt: now() })
    await Promise.all([
      recordStore.getState().hydrate(),
      sporeStore.getState().hydrate(),
      pointStore.getState().hydrate(),
      identifyStore.getState().hydrate()
    ])
    await get().hydrate()
    return plan
  }
}))

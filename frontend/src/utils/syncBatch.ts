import type { CollectPoint, FungusRecord, IdentifyLog, SporePrint } from '@/types'
import type { SyncBatch } from '@/types/sync'
import { SYNC_BATCH_FORMAT, SYNC_BATCH_KIND } from '@/types/sync'

export interface BatchExportInput {
  deviceId?: string
  deviceName?: string
  batchId?: string
  exportedBy?: string
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

function clean(value?: string): string | undefined {
  const text = value?.trim()
  return text ? text : undefined
}

/** 构建离线批次包（巡采设备带回驻地的整库快照） */
export function buildSyncBatch(input: BatchExportInput): SyncBatch {
  return {
    kind: SYNC_BATCH_KIND,
    format: SYNC_BATCH_FORMAT,
    deviceId: clean(input.deviceId),
    deviceName: clean(input.deviceName),
    batchId: clean(input.batchId),
    exportedAt: new Date().toISOString(),
    exportedBy: clean(input.exportedBy),
    points: input.points.map((row) => ({ ...row })),
    records: input.records.map((row) => ({ ...row })),
    spores: input.spores.map((row) => ({ ...row })),
    identifies: input.identifies.map((row) => ({ ...row }))
  }
}

/** 设备编号 + 批次号 同时具备才算可追踪设备批次，否则按旧设备临时来源处理 */
export function hasDeviceIdentity(batch: SyncBatch): boolean {
  return Boolean(clean(batch.deviceId) && clean(batch.batchId))
}

/** cyrb53 内容指纹，用于旧设备批次去重与任务主键 */
export function contentHash(value: unknown): string {
  const str = JSON.stringify(value)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0')
}

/** 旧设备批次按批次内容取指纹，保证同一份文件不会混入已有批次 / 不重复导入 */
export function legacyFingerprint(batch: SyncBatch): string {
  return contentHash([
    batch.points,
    batch.records,
    batch.spores,
    batch.identifies.map((l) => ({ ...l, id: l.id }))
  ])
}

/** 任务主键：可追踪设备按设备/批次取定；旧设备按内容指纹取定 */
export function jobIdOf(batch: SyncBatch): string {
  if (hasDeviceIdentity(batch)) {
    return `dev:${clean(batch.deviceId)}|batch:${clean(batch.batchId)}`
  }
  return `legacy:${legacyFingerprint(batch)}`
}

/** 来源展示文案 */
export function sourceLabelOf(batch: SyncBatch): string {
  if (hasDeviceIdentity(batch)) {
    const name = clean(batch.deviceName)
    return `${name ? `${name}（${clean(batch.deviceId)}）` : `设备 ${clean(batch.deviceId)}`} · 批次 ${clean(batch.batchId)}`
  }
  const name = clean(batch.deviceName) ?? clean(batch.deviceId) ?? '旧设备（无编号）'
  return `临时来源：${name}`
}

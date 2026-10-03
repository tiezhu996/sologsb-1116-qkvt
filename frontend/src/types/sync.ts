import type { CollectPoint, FungusRecord, IdentifyLog, SporePrint } from '@/types'

/** 离线批次文件标识 */
export const SYNC_BATCH_KIND = 'gbfungiguide-offline-batch'
/** 离线批次文件格式版本 */
export const SYNC_BATCH_FORMAT = 1

/** 离线批次包：巡采设备回驻地时导出的整库快照 */
export interface SyncBatch {
  kind: typeof SYNC_BATCH_KIND
  format: number
  /** 导出设备编号（旧设备可能缺失） */
  deviceId?: string
  /** 导出设备名称 */
  deviceName?: string
  /** 批次号（旧设备可能缺失） */
  batchId?: string
  /** 导出时间 ISO 字符串 */
  exportedAt: string
  /** 导出人 */
  exportedBy?: string
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

export type SyncEntity = 'point' | 'record' | 'spore' | 'identify'

/** 单个字段的内容差异 */
export interface FieldConflict {
  field: string
  fieldLabel: string
  local: string
  incoming: string
}

/** 一条合并冲突：同名采集点 / 同编号条目等主键一致但内容不同 */
export interface MergeConflict {
  entity: SyncEntity
  /** 冲突对象的业务键（采集点名称 / 采集编号等） */
  key: string
  fields: FieldConflict[]
}

export type SyncTable = 'points' | 'records' | 'spores' | 'identifies'

/** 一条落库操作（id 已完成跨设备重映射） */
export interface SyncOp {
  /** 批次内确定性操作键，用作断点 */
  id: string
  table: SyncTable
  /** upsert=按主键覆盖写；append=鉴定留痕只追加 */
  mode: 'upsert' | 'append'
  row: CollectPoint | FungusRecord | SporePrint | IdentifyLog
}

export type BatchJobStatus = 'blocked' | 'paused' | 'done'

/** 离线批次导入任务：持久化在 batchJobs 表，支撑整批断点恢复 */
export interface BatchJob {
  /** 有设备编号+批次号时为设备/批次指纹；旧设备为内容指纹 */
  id: string
  /** 旧设备（无设备编号且无批次号）标记，展示为临时来源 */
  legacy: boolean
  deviceId: string | null
  deviceName: string | null
  batchId: string | null
  /** 来源显示名 */
  sourceLabel: string
  fileName: string
  exportedAt: string | null
  importedAt: string
  updatedAt: string
  status: BatchJobStatus
  /** 冲突数 > 0 时整批挡住，不写入 */
  conflicts: MergeConflict[]
  /** 预检结构错误（不建任务，仅导入时返回） */
  ops: SyncOp[]
  /** 已完成的操作 id（断点游标，重试时跳过） */
  doneOpIds: string[]
  lastError: string
  summary: { points: number; records: number; spores: number; identifies: number }
}

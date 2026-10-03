import type { CollectPoint } from './point'
import type { FungusRecord } from './record'
import type { SporePrint } from './spore'
import type { IdentifyLog } from './identify'

/** 离线批次文件标识与当前版本 */
export const OFFLINE_BATCH_FORMAT = 'gbfungiguide-offline-batch'
export const OFFLINE_BATCH_VERSION = 1

/**
 * 离线批次：巡采队离线设备回驻地后整批带回的四类数据
 * （采集点 / 菌物条目 / 孢子印 / 鉴定留痕）
 */
export interface OfflineBatch {
  format: string
  version: number
  /** 设备编号；旧设备导出为空，导入端按临时来源处理 */
  deviceId: string
  /** 批次号；旧设备导出为空，导入端按临时来源处理 */
  batchNo: string
  /** 导出时间（ISO） */
  exportedAt: string
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

/** 冲突字段明细（本地值与批次值并列展示） */
export interface ConflictField {
  label: string
  local: string
  incoming: string
}

/** 合并冲突：同名采集点 / 同编号条目 / 同条目孢子印内容不一致 */
export interface MergeConflict {
  entity: '采集点' | '菌物条目' | '孢子印'
  /** 采集点名称或条目编号 */
  key: string
  fields: ConflictField[]
}

/** 合并写入步骤（断点恢复的最小单位） */
export interface MergeStep {
  /** 断点去重键，同一批次内唯一 */
  key: string
  table: 'points' | 'records' | 'spores' | 'identifies'
  action: 'insert' | 'update'
  data: CollectPoint | FungusRecord | SporePrint | IdentifyLog
  /** 进度展示用 */
  label: string
}

/** 合并计划：冲突为空才允许执行 */
export interface MergePlan {
  batchKey: string
  tempSource: boolean
  sourceLabel: string
  exportedAt: string
  conflicts: MergeConflict[]
  steps: MergeStep[]
  /** 内容一致、无需写入的实体数 */
  skipped: number
}

/** 导入台账：断点恢复与重试去重的依据，持久化在 imports 表 */
export interface ImportJournal {
  /** 批次键：deviceId#batchNo；临时来源为 temp#内容哈希，不会混入已有批次 */
  key: string
  deviceId: string
  batchNo: string
  tempSource: boolean
  sourceLabel: string
  status: 'applying' | 'done' | 'failed'
  /** 计划写入总步数 */
  total: number
  /** 已写入步骤键 */
  doneKeys: string[]
  error: string
  startedAt: string
  updatedAt: string
}

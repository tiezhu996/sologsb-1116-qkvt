import type { CollectPoint, FungusRecord, IdentifyLog, SporePrint } from '@/types'
import { OFFLINE_BATCH_FORMAT, OFFLINE_BATCH_VERSION } from '@/types/sync'
import type { ConflictField, MergeConflict, MergePlan, MergeStep, OfflineBatch } from '@/types/sync'
import { uid } from '@/utils/id'

/** 本地库快照：构建合并计划的对比基准 */
export interface LocalSnapshot {
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

/** FNV-1a 哈希：为没有设备编号与批次号的旧设备批次生成一次性键 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 批次键：有设备编号与批次号时用 deviceId#batchNo；
 * 旧设备两者缺失时按内容哈希生成 temp# 键 —— 显示为临时来源，
 * 且不会与任何已有批次共享台账（不能混进已有批次）。
 */
export function batchKeyOf(batch: OfflineBatch): { key: string; tempSource: boolean; sourceLabel: string } {
  const deviceId = (batch.deviceId ?? '').trim()
  const batchNo = (batch.batchNo ?? '').trim()
  if (deviceId && batchNo) {
    return { key: `${deviceId}#${batchNo}`, tempSource: false, sourceLabel: `${deviceId} · ${batchNo}` }
  }
  return {
    key: `temp#${hashText(JSON.stringify(batch))}`,
    tempSource: true,
    sourceLabel: '临时来源（无设备编号与批次号）'
  }
}

/** 解析并校验批次文件结构 */
export function parseOfflineBatch(text: string): { batch: OfflineBatch | null; errors: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { batch: null, errors: ['文件不是有效的 JSON，无法解析'] }
  }
  const obj = raw as Partial<Record<keyof OfflineBatch, unknown>>
  const errors: string[] = []
  if (obj?.format !== OFFLINE_BATCH_FORMAT) {
    errors.push('文件缺少离线批次标识，不是本工具导出的批次文件')
  }
  if (typeof obj?.version !== 'number' || obj.version > OFFLINE_BATCH_VERSION) {
    errors.push(`批次文件版本不受支持（${String(obj?.version ?? '未知')}）`)
  }
  for (const name of ['points', 'records', 'spores', 'identifies'] as const) {
    if (!Array.isArray(obj?.[name])) errors.push(`批次文件缺少 ${name} 数组`)
  }
  if (errors.length > 0) return { batch: null, errors }

  const points = obj.points as CollectPoint[]
  const records = obj.records as FungusRecord[]
  points.forEach((point, index) => {
    if (!point?.name?.trim?.()) errors.push(`第 ${index + 1} 个采集点缺少名称`)
  })
  records.forEach((record, index) => {
    if (!record?.code?.trim?.()) errors.push(`第 ${index + 1} 个菌物条目缺少采集编号`)
  })
  if (errors.length > 0) return { batch: null, errors }

  return {
    batch: {
      format: OFFLINE_BATCH_FORMAT,
      version: OFFLINE_BATCH_VERSION,
      deviceId: typeof obj.deviceId === 'string' ? obj.deviceId : '',
      batchNo: typeof obj.batchNo === 'string' ? obj.batchNo : '',
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
      points,
      records,
      spores: obj.spores as SporePrint[],
      identifies: obj.identifies as IdentifyLog[]
    },
    errors: []
  }
}

/** 引用完整性校验：批次内条目/孢子印/鉴定留痕必须能挂到已知采集点与条目 */
export function validateBatchRefs(batch: OfflineBatch, local: LocalSnapshot): string[] {
  const errors: string[] = []
  const pointIds = new Set([...batch.points.map((item) => item.id), ...local.points.map((item) => item.id)])
  const recordIds = new Set([...batch.records.map((item) => item.id), ...local.records.map((item) => item.id)])
  for (const record of batch.records) {
    if (!pointIds.has(record.pointId)) errors.push(`条目 ${record.code} 引用的采集点不在批次或本地库中`)
  }
  for (const spore of batch.spores) {
    if (!recordIds.has(spore.recordId)) errors.push(`孢子印 ${spore.id} 引用的条目不在批次或本地库中`)
  }
  for (const log of batch.identifies) {
    if (!recordIds.has(log.recordId)) errors.push(`鉴定留痕 ${log.id} 引用的条目不在批次或本地库中`)
  }
  return errors
}

/* ---------- 字段分组：属性字段不一致即冲突；观察字段取最新观察 ---------- */

/** 采集点属性字段：同名但不一致 → 冲突 */
const POINT_ATTR_FIELDS: { key: keyof CollectPoint; label: string }[] = [
  { key: 'vegetation', label: '植被类型' },
  { key: 'substrate', label: '基物' },
  { key: 'companionTrees', label: '伴生树种' },
  { key: 'collector', label: '采集人' }
]

/** 采集点观察字段（坐标）：取最新观察 */
const POINT_OBS_FIELDS: { key: keyof CollectPoint; label: string }[] = [
  { key: 'longitude', label: '经度' },
  { key: 'latitude', label: '纬度' },
  { key: 'altitude', label: '海拔' }
]

/** 条目属性字段：同编号但不一致 → 冲突 */
const RECORD_ATTR_FIELDS: { key: keyof FungusRecord; label: string }[] = [
  { key: 'collector', label: '采集人' }
]

/** 条目观察字段（形态）：取最新观察 */
const RECORD_OBS_FIELDS: { key: keyof FungusRecord; label: string }[] = [
  { key: 'tempName', label: '暂定名' },
  { key: 'fruitBodyCount', label: '子实体数量' },
  { key: 'capDiameter', label: '菌盖直径' },
  { key: 'capShape', label: '菌盖形状' },
  { key: 'capMargin', label: '菌盖边缘' },
  { key: 'capTexture', label: '表面质地' },
  { key: 'fleshThickness', label: '菌肉厚度' },
  { key: 'fleshReaction', label: '菌肉变色反应' },
  { key: 'attachment', label: '着生方式' },
  { key: 'gillDensity', label: '菌褶密度' },
  { key: 'stipeLength', label: '菌柄长度' },
  { key: 'stipeDiameter', label: '菌柄直径' },
  { key: 'ring', label: '菌环' },
  { key: 'volva', label: '菌托' },
  { key: 'odor', label: '气味' },
  { key: 'hostTree', label: '关联树种' },
  { key: 'note', label: '备注' }
]

/** 孢子印观察字段：取最新观察 */
const SPORE_OBS_FIELDS: { key: keyof SporePrint; label: string }[] = [
  { key: 'color', label: '印色' },
  { key: 'shape', label: '印形' },
  { key: 'hours', label: '获取时长' },
  { key: 'moisture', label: '样本干湿度' }
]

const POINT_OBS_KEYS = POINT_OBS_FIELDS.map((item) => item.key)
const RECORD_OBS_KEYS = RECORD_OBS_FIELDS.map((item) => item.key)
const SPORE_OBS_KEYS = SPORE_OBS_FIELDS.map((item) => item.key)

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

/** 逐字段对比，产出冲突明细 */
function diffFields<T>(localRow: T, incoming: T, fields: { key: keyof T; label: string }[]): ConflictField[] {
  return fields
    .filter(({ key }) => String(localRow[key] ?? '') !== String(incoming[key] ?? ''))
    .map(({ key, label }) => ({ label, local: text(localRow[key]), incoming: text(incoming[key]) }))
}

function obsDiffers<T>(a: T, b: T, keys: (keyof T)[]): boolean {
  return keys.some((key) => String(a[key] ?? '') !== String(b[key] ?? ''))
}

function pickObs<T>(source: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const key of keys) out[key] = source[key]
  return out
}

/** 比较两侧观察日期：新的覆盖旧的 */
function latestWins(localDate: string, incomingDate: string): 'local' | 'incoming' | 'tie' {
  if (incomingDate > localDate) return 'incoming'
  if (incomingDate < localDate) return 'local'
  return 'tie'
}

/** 鉴定留痕内容键：结论只追加，内容完全相同的留痕不重复写入 */
function identifyContentKey(log: IdentifyLog): string {
  return [
    log.recordId,
    log.conclusion,
    log.basis,
    log.referenceBook,
    log.referencePage,
    log.confidence,
    String(log.needReview),
    log.reviewer,
    log.date
  ].join('')
}

/** 批次内去重：同名采集点 / 同编号条目取最后一条，同条目孢子印取最新观察 */
function dedupeBatch(batch: OfflineBatch): OfflineBatch {
  const points = new Map<string, CollectPoint>()
  for (const point of batch.points) points.set(point.name, point)
  const records = new Map<string, FungusRecord>()
  for (const record of batch.records) records.set(record.code, record)
  const spores = new Map<string, SporePrint>()
  for (const spore of batch.spores) {
    const prev = spores.get(spore.recordId)
    if (!prev || spore.observeDate >= prev.observeDate) spores.set(spore.recordId, spore)
  }
  return { ...batch, points: [...points.values()], records: [...records.values()], spores: [...spores.values()] }
}

/**
 * 构建合并计划：
 * - 同名采集点 / 同编号条目：属性字段不一致 → 冲突，挡住导入；
 * - 形态与坐标等观察字段：取最新观察（按采集/观察日期），日期相同却内容不同 → 冲突；
 * - 鉴定结论：只追加，内容相同的留痕跳过；
 * - 批次内 id 与本地其他实体撞主键时换新 id，绝不覆盖本地数据。
 */
export function buildMergePlan(rawBatch: OfflineBatch, local: LocalSnapshot): MergePlan {
  const batch = dedupeBatch(rawBatch)
  const { key, tempSource, sourceLabel } = batchKeyOf(batch)
  const conflicts: MergeConflict[] = []
  const steps: MergeStep[] = []
  let skipped = 0

  /** 批次内 id → 落库 id（同名/同编号匹到本地实体，或撞主键后换发的新 id） */
  const pointIdMap = new Map<string, string>()
  const recordIdMap = new Map<string, string>()
  const recordCodeById = new Map<string, string>()
  for (const record of local.records) recordCodeById.set(record.id, record.code)

  // —— 采集点：同名视为同一采集点 ——
  for (const incoming of batch.points) {
    const existing = local.points.find((point) => point.name === incoming.name)
    if (!existing) {
      const id = local.points.some((point) => point.id === incoming.id) ? uid('pt') : incoming.id
      pointIdMap.set(incoming.id, id)
      steps.push({
        key: `point:${incoming.name}`,
        table: 'points',
        action: 'insert',
        data: { ...incoming, id },
        label: `采集点「${incoming.name}」`
      })
      continue
    }
    pointIdMap.set(incoming.id, existing.id)
    const attrDiffs = diffFields(existing, incoming, POINT_ATTR_FIELDS)
    if (attrDiffs.length > 0) {
      conflicts.push({ entity: '采集点', key: incoming.name, fields: attrDiffs })
      continue
    }
    const differs = obsDiffers(existing, incoming, POINT_OBS_KEYS)
    const dateCmp = latestWins(existing.collectDate, incoming.collectDate)
    if (differs && dateCmp === 'tie') {
      conflicts.push({ entity: '采集点', key: incoming.name, fields: diffFields(existing, incoming, POINT_OBS_FIELDS) })
      continue
    }
    if (dateCmp !== 'incoming') {
      skipped++
      continue
    }
    steps.push({
      key: `point:${incoming.name}`,
      table: 'points',
      action: 'update',
      data: { ...existing, ...pickObs(incoming, POINT_OBS_KEYS), collectDate: incoming.collectDate },
      label: `采集点「${incoming.name}」`
    })
  }

  // —— 菌物条目：同编号视为同一条目 ——
  for (const incoming of batch.records) {
    recordCodeById.set(incoming.id, incoming.code)
    const resolvedPointId = pointIdMap.get(incoming.pointId) ?? incoming.pointId
    const existing = local.records.find((record) => record.code === incoming.code)
    if (!existing) {
      const id = local.records.some((record) => record.id === incoming.id) ? uid('rec') : incoming.id
      recordIdMap.set(incoming.id, id)
      steps.push({
        key: `record:${incoming.code}`,
        table: 'records',
        action: 'insert',
        data: { ...incoming, id, pointId: resolvedPointId },
        label: `条目 ${incoming.code}`
      })
      continue
    }
    recordIdMap.set(incoming.id, existing.id)
    const fields = diffFields(existing, incoming, RECORD_ATTR_FIELDS)
    if (existing.pointId !== resolvedPointId) {
      const localPoint = local.points.find((point) => point.id === existing.pointId)?.name ?? existing.pointId
      const incomingPoint =
        batch.points.find((point) => point.id === incoming.pointId)?.name ??
        local.points.find((point) => point.id === resolvedPointId)?.name ??
        incoming.pointId
      fields.push({ label: '所属采集点', local: localPoint, incoming: incomingPoint })
    }
    const differs = obsDiffers(existing, incoming, RECORD_OBS_KEYS)
    const dateCmp = latestWins(existing.collectDate, incoming.collectDate)
    if (differs && dateCmp === 'tie') fields.push(...diffFields(existing, incoming, RECORD_OBS_FIELDS))
    if (fields.length > 0) {
      conflicts.push({ entity: '菌物条目', key: incoming.code, fields })
      continue
    }
    if (dateCmp !== 'incoming') {
      skipped++
      continue
    }
    steps.push({
      key: `record:${incoming.code}`,
      table: 'records',
      action: 'update',
      data: { ...existing, ...pickObs(incoming, RECORD_OBS_KEYS), collectDate: incoming.collectDate },
      label: `条目 ${incoming.code}`
    })
  }

  // —— 孢子印：挂到合并后的条目上，取最新观察 ——
  for (const incoming of batch.spores) {
    const resolvedRecordId = recordIdMap.get(incoming.recordId) ?? incoming.recordId
    const code = recordCodeById.get(incoming.recordId) ?? resolvedRecordId
    const existing = local.spores.find((spore) => spore.recordId === resolvedRecordId)
    if (!existing) {
      const id = local.spores.some((spore) => spore.id === incoming.id) ? uid('spo') : incoming.id
      steps.push({
        key: `spore:${code}`,
        table: 'spores',
        action: 'insert',
        data: { ...incoming, id, recordId: resolvedRecordId },
        label: `孢子印（${code}）`
      })
      continue
    }
    const differs = obsDiffers(existing, incoming, SPORE_OBS_KEYS)
    const dateCmp = latestWins(existing.observeDate, incoming.observeDate)
    if (differs && dateCmp === 'tie') {
      conflicts.push({ entity: '孢子印', key: code, fields: diffFields(existing, incoming, SPORE_OBS_FIELDS) })
      continue
    }
    if (dateCmp !== 'incoming') {
      skipped++
      continue
    }
    steps.push({
      key: `spore:${code}`,
      table: 'spores',
      action: 'update',
      data: { ...existing, ...pickObs(incoming, SPORE_OBS_KEYS), observeDate: incoming.observeDate },
      label: `孢子印（${code}）`
    })
  }

  // —— 鉴定留痕：只追加，不覆盖、不重复 ——
  const localIdentKeys = new Set(local.identifies.map(identifyContentKey))
  for (const incoming of batch.identifies) {
    const resolvedRecordId = recordIdMap.get(incoming.recordId) ?? incoming.recordId
    const row: IdentifyLog = { ...incoming, recordId: resolvedRecordId }
    const contentKey = identifyContentKey(row)
    if (localIdentKeys.has(contentKey)) {
      skipped++
      continue
    }
    localIdentKeys.add(contentKey)
    const id = local.identifies.some((log) => log.id === incoming.id) ? uid('idf') : incoming.id
    row.id = id
    steps.push({
      key: `identify:${id}`,
      table: 'identifies',
      action: 'insert',
      data: row,
      label: `鉴定结论（${incoming.conclusion || '未命名'}）`
    })
  }

  return { batchKey: key, tempSource, sourceLabel, exportedAt: batch.exportedAt, conflicts, steps, skipped }
}

/** 汇总导出：把本地整库打包成一个离线批次文件 */
export function buildBatchFile(deviceId: string, batchNo: string, snap: LocalSnapshot): OfflineBatch {
  return {
    format: OFFLINE_BATCH_FORMAT,
    version: OFFLINE_BATCH_VERSION,
    deviceId,
    batchNo,
    exportedAt: new Date().toISOString(),
    points: snap.points,
    records: snap.records,
    spores: snap.spores,
    identifies: snap.identifies
  }
}

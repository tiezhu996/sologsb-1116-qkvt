import {
  CAP_MARGINS,
  CAP_SHAPES,
  CAP_TEXTURES,
  FLESH_REACTIONS,
  GILL_ATTACHMENTS,
  GILL_DENSITIES,
  ID_BASES,
  ID_CONFIDENCES,
  RING_TYPES,
  SPORE_COLORS,
  SUBSTRATES,
  VEGETATIONS,
  VOLVA_TYPES
} from '@/types'
import type { CollectPoint, FungusRecord, IdentifyLog, SporePrint } from '@/types'
import type { SyncBatch, SyncEntity, FieldConflict, MergeConflict, SyncOp } from '@/types/sync'
import { uid } from '@/utils/id'

// ---------- 字段标签 ----------

const POINT_LABELS: Record<string, string> = {
  name: '采集点名称',
  longitude: '经度',
  latitude: '纬度',
  altitude: '海拔',
  vegetation: '植被类型',
  substrate: '主要基物',
  companionTrees: '伴生树种',
  collectDate: '采集日期',
  collector: '采集人'
}

const RECORD_LABELS: Record<string, string> = {
  code: '采集编号',
  tempName: '暂定名',
  fruitBodyCount: '子实体数量',
  pointId: '所属采集点',
  capDiameter: '菌盖直径',
  capShape: '菌盖形状',
  capMargin: '菌盖边缘',
  capTexture: '表面质地',
  fleshThickness: '菌肉厚度',
  fleshReaction: '菌肉变色反应',
  attachment: '着生方式',
  gillDensity: '菌褶密度',
  stipeLength: '菌柄长度',
  stipeDiameter: '菌柄直径',
  ring: '菌环',
  volva: '菌托',
  odor: '气味',
  hostTree: '关联树种',
  collectDate: '采集日期',
  collector: '采集人',
  note: '备注'
}

const SPORE_LABELS: Record<string, string> = {
  color: '印色',
  shape: '印形',
  hours: '获取时长',
  observeDate: '观察日期',
  moisture: '样本干湿度'
}

/** 形态观察字段：与库内同编号条目不一致时按采集日期取最新观察 */
const LATEST_RECORD_FIELDS = [
  'fruitBodyCount',
  'capDiameter',
  'capShape',
  'capMargin',
  'capTexture',
  'fleshThickness',
  'fleshReaction',
  'attachment',
  'gillDensity',
  'stipeLength',
  'stipeDiameter',
  'ring',
  'volva',
  'odor',
  'hostTree'
] as const

/** 非形态字段：同编号条目内容不同即列冲突 */
const CONFLICT_RECORD_FIELDS = ['tempName', 'collector', 'note'] as const

/** 采集点除坐标与日期外的字段：同名点不同即列冲突 */
const CONFLICT_POINT_FIELDS = ['altitude', 'vegetation', 'substrate', 'companionTrees', 'collector'] as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// ---------- 工具 ----------

type Row = Record<string, unknown>

function isObject(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '（空）'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

/** 同名字段逐个比对，返回不一致项 */
function diffFields(
  local: Row,
  incoming: Row,
  fields: readonly string[],
  labels: Record<string, string>
): FieldConflict[] {
  const conflicts: FieldConflict[] = []
  for (const field of fields) {
    const a = local[field]
    const b = incoming[field]
    if (String(a ?? '') !== String(b ?? '')) {
      conflicts.push({ field, fieldLabel: labels[field] ?? field, local: displayValue(a), incoming: displayValue(b) })
    }
  }
  return conflicts
}

function laterDate(a: string, b: string): string {
  return a.localeCompare(b) >= 0 ? a : b
}

// ---------- 结构校验 ----------

/** 批次级结构校验：不合法一律挡住导入（返回错误文案） */
export function validateBatchShape(data: unknown): { errors: string[]; batch?: SyncBatch } {
  const errors: string[] = []
  if (!isObject(data)) {
    return { errors: ['文件内容不是有效的 JSON 对象'] }
  }
  if (data.kind !== 'gbfungiguide-offline-batch') {
    errors.push('缺少离线批次标识（kind=gbfungiguide-offline-batch），不是本工具导出的批次文件')
  }
  if (typeof data.format !== 'number') {
    errors.push('缺少批次格式版本号（format）')
  } else if (data.format > 1) {
    errors.push(`批次格式版本 v${data.format} 高于当前支持版本（v1），请先升级本工具`)
  }
  if (!isNonEmptyString(data.exportedAt)) errors.push('缺少导出时间（exportedAt）')
  for (const key of ['points', 'records', 'spores', 'identifies'] as const) {
    if (!Array.isArray(data[key])) errors.push(`批次缺少「${key}」数组`)
  }
  if (errors.length > 0) return { errors }

  const batch = data as unknown as SyncBatch
  batch.points = batch.points ?? []
  batch.records = batch.records ?? []
  batch.spores = batch.spores ?? []
  batch.identifies = batch.identifies ?? []

  const enumError = (path: string, value: unknown, allowed: readonly unknown[]): void => {
    if (!allowed.includes(value as never)) errors.push(`${path} 取值非法：${displayValue(value)}`)
  }

  const validatePoint = (p: unknown, i: number): CollectPoint | null => {
    const path = `采集点[${i + 1}]`
    if (!isObject(p)) {
      errors.push(`${path} 不是对象`)
      return null
    }
    if (!isNonEmptyString(p.id)) errors.push(`${path} 缺少 id`)
    if (!isNonEmptyString(p.name)) errors.push(`${path} 缺少名称`)
    if (!isFiniteNumber(p.longitude) || p.longitude < -180 || p.longitude > 180)
      errors.push(`${path} 经度非法（-180~180）`)
    if (!isFiniteNumber(p.latitude) || p.latitude < -90 || p.latitude > 90)
      errors.push(`${path} 纬度非法（-90~90）`)
    if (!isFiniteNumber(p.altitude)) errors.push(`${path} 海拔非法`)
    enumError(`${path} 植被类型`, p.vegetation, VEGETATIONS)
    enumError(`${path} 基物`, p.substrate, SUBSTRATES)
    if (!isDateString(p.collectDate)) errors.push(`${path} 采集日期非法（YYYY-MM-DD）`)
    for (const field of ['companionTrees', 'collector'] as const) {
      if (typeof p[field] !== 'string') errors.push(`${path} ${POINT_LABELS[field]}字段缺失`)
    }
    return p as unknown as CollectPoint
  }

  const validateRecord = (r: unknown, i: number): FungusRecord | null => {
    const path = `菌物条目[${i + 1}]`
    if (!isObject(r)) {
      errors.push(`${path} 不是对象`)
      return null
    }
    if (!isNonEmptyString(r.id)) errors.push(`${path} 缺少 id`)
    if (!isNonEmptyString(r.code)) errors.push(`${path} 缺少采集编号`)
    if (!isNonEmptyString(r.pointId)) errors.push(`${path} 缺少所属采集点`)
    const numFields: [string, boolean][] = [
      ['fruitBodyCount', true],
      ['capDiameter', false],
      ['fleshThickness', false],
      ['stipeLength', false],
      ['stipeDiameter', false]
    ]
    for (const [field, int] of numFields) {
      const ok = isFiniteNumber(r[field]) && (!int || Number.isInteger(r[field])) && Number(r[field]) >= 0
      if (!ok) errors.push(`${path} ${RECORD_LABELS[field]}非法`)
    }
    enumError(`${path} 菌盖形状`, r.capShape, CAP_SHAPES)
    enumError(`${path} 菌盖边缘`, r.capMargin, CAP_MARGINS)
    enumError(`${path} 表面质地`, r.capTexture, CAP_TEXTURES)
    enumError(`${path} 变色反应`, r.fleshReaction, FLESH_REACTIONS)
    enumError(`${path} 着生方式`, r.attachment, GILL_ATTACHMENTS)
    enumError(`${path} 菌褶密度`, r.gillDensity, GILL_DENSITIES)
    enumError(`${path} 菌环`, r.ring, RING_TYPES)
    enumError(`${path} 菌托`, r.volva, VOLVA_TYPES)
    if (!isDateString(r.collectDate)) errors.push(`${path} 采集日期非法（YYYY-MM-DD）`)
    for (const field of ['tempName', 'odor', 'hostTree', 'collector', 'note'] as const) {
      if (typeof r[field] !== 'string') errors.push(`${path} ${RECORD_LABELS[field]}字段缺失`)
    }
    return r as unknown as FungusRecord
  }

  const validateSpore = (s: unknown, i: number): SporePrint | null => {
    const path = `孢子印[${i + 1}]`
    if (!isObject(s)) {
      errors.push(`${path} 不是对象`)
      return null
    }
    if (!isNonEmptyString(s.id)) errors.push(`${path} 缺少 id`)
    if (!isNonEmptyString(s.recordId)) errors.push(`${path} 缺少所属条目`)
    enumError(`${path} 印色`, s.color, SPORE_COLORS)
    if (!isFiniteNumber(s.hours) || s.hours < 0) errors.push(`${path} 获取时长非法`)
    if (!isDateString(s.observeDate)) errors.push(`${path} 观察日期非法（YYYY-MM-DD）`)
    for (const field of ['shape', 'moisture'] as const) {
      if (typeof s[field] !== 'string') errors.push(`${path} ${SPORE_LABELS[field]}字段缺失`)
    }
    return s as unknown as SporePrint
  }

  const validateIdentify = (l: unknown, i: number): IdentifyLog | null => {
    const path = `鉴定留痕[${i + 1}]`
    if (!isObject(l)) {
      errors.push(`${path} 不是对象`)
      return null
    }
    if (!isNonEmptyString(l.id)) errors.push(`${path} 缺少 id`)
    if (!isNonEmptyString(l.recordId)) errors.push(`${path} 缺少所属条目`)
    if (!isNonEmptyString(l.conclusion)) errors.push(`${path} 缺少结论学名`)
    enumError(`${path} 依据`, l.basis, ID_BASES)
    enumError(`${path} 置信度`, l.confidence, ID_CONFIDENCES)
    if (typeof l.needReview !== 'boolean') errors.push(`${path} 待复核标记非法`)
    if (!isDateString(l.date)) errors.push(`${path} 鉴定日期非法（YYYY-MM-DD）`)
    for (const field of ['referenceBook', 'referencePage', 'reviewer'] as const) {
      if (typeof l[field] !== 'string') errors.push(`${path} 字段缺失`)
    }
    return l as unknown as IdentifyLog
  }

  batch.points.forEach((p, i) => validatePoint(p, i))
  batch.records.forEach((r, i) => validateRecord(r, i))
  batch.spores.forEach((s, i) => validateSpore(s, i))
  batch.identifies.forEach((l, i) => validateIdentify(l, i))

  // 批次内部重复主键
  const dupCheck = <T extends { id: string }>(rows: T[], label: string): void => {
    const seen = new Set<string>()
    rows.forEach((row, i) => {
      if (seen.has(row.id)) errors.push(`${label}[${i + 1}] 批次内 id 重复：${row.id}`)
      seen.add(row.id)
    })
  }
  dupCheck(batch.points, '采集点')
  dupCheck(batch.records, '菌物条目')
  dupCheck(batch.spores, '孢子印')
  dupCheck(batch.identifies, '鉴定留痕')

  const pointNames = new Set(batch.points.map((p) => p.name.trim()))
  if (pointNames.size !== batch.points.length) errors.push('批次内存在同名采集点，无法按名称合并')
  const recordCodes = new Set(batch.records.map((r) => r.code.trim()))
  if (recordCodes.size !== batch.records.length) errors.push('批次内存在同采集编号条目，无法按编号合并')

  return { errors: dedupe(errors), batch }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}

// ---------- 合并规划 ----------

export interface PlanResult {
  errors: string[]
  conflicts: MergeConflict[]
  ops: SyncOp[]
  summary: BatchSummary
}

export interface BatchSummary {
  points: number
  records: number
  spores: number
  identifies: number
}

export interface LocalData {
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

/** 鉴定留痕内容指纹：同一条目下指纹一致视为同一结论，不重复追加 */
function identifyFingerprint(row: IdentifyLog, recordId: string): string {
  return [
    recordId,
    row.conclusion.trim(),
    row.basis,
    row.referenceBook.trim(),
    row.referencePage.trim(),
    row.confidence,
    row.needReview ? '1' : '0',
    row.reviewer.trim(),
    row.date
  ].join('|')
}

/**
 * 依据库内现状为离线批次生成合并规划：
 * - 同名采集点 / 同编号条目：形态与坐标按观察日期取最新，其余差异列为冲突；
 * - 孢子印：同一观察记录按观察日期取最新；
 * - 鉴定结论：只追加，不改写库内历史；
 * - 只要存在冲突，整批挡住（ops 不会被执行）。
 */
export function planMerge(batch: SyncBatch, local: LocalData): PlanResult {
  const { errors, conflicts, ops } = { errors: [] as string[], conflicts: [] as MergeConflict[], ops: [] as SyncOp[] }
  const summary: BatchSummary = { points: 0, records: 0, spores: 0, identifies: 0 }

  const localPointsById = new Map(local.points.map((p) => [p.id, p]))
  const localPointsByName = new Map(local.points.map((p) => [p.name.trim(), p]))
  const localRecordsById = new Map(local.records.map((r) => [r.id, r]))
  const localRecordsByCode = new Map(local.records.map((r) => [r.code.trim(), r]))
  const localSporesById = new Map(local.spores.map((s) => [s.id, s]))
  const localIdentifiesById = new Map(local.identifies.map((l) => [l.id, l]))

  const batchPointIds = new Set(batch.points.map((p) => p.id))
  const batchRecordIds = new Set(batch.records.map((r) => r.id))

  // 引用完整性：条目/孢子印/鉴定留痕的归属必须能在批次内或库内解析
  batch.records.forEach((r) => {
    if (!batchPointIds.has(r.pointId) && !localPointsById.has(r.pointId)) {
      errors.push(`条目 ${r.code} 引用的采集点 id（${r.pointId}）在批次与库内均不存在`)
    }
  })
  batch.spores.forEach((s) => {
    if (!batchRecordIds.has(s.recordId) && !localRecordsById.has(s.recordId)) {
      errors.push(`孢子印 ${s.id} 引用的条目 id（${s.recordId}）在批次与库内均不存在`)
    }
  })
  batch.identifies.forEach((l) => {
    if (!batchRecordIds.has(l.recordId) && !localRecordsById.has(l.recordId)) {
      errors.push(`鉴定留痕 ${l.id} 引用的条目 id（${l.recordId}）在批次与库内均不存在`)
    }
  })
  if (errors.length > 0) return { errors: dedupe(errors), conflicts, ops, summary }

  // 批次采集点 id -> 合并后最终 id（同名点并入库内 id）
  const pointIdMap = new Map<string, string>()
  // 批次条目 id -> 合并后最终 id（同编号条目并入库内 id）
  const recordIdMap = new Map<string, string>()

  // ----- 采集点 -----
  for (const incomingRaw of batch.points) {
    const incoming: CollectPoint = { ...incomingRaw, name: incomingRaw.name.trim() }
    const existing = localPointsByName.get(incoming.name)
    if (!existing) {
      pointIdMap.set(incoming.id, incoming.id)
      ops.push({ id: `point:${incoming.id}`, table: 'points', mode: 'upsert', row: incoming })
      summary.points++
      continue
    }
    pointIdMap.set(incoming.id, existing.id)
    const localRow = existing as unknown as Row
    const inRow = incoming as unknown as Row

    const fieldConflicts = diffFields(localRow, inRow, CONFLICT_POINT_FIELDS, POINT_LABELS)

    // 坐标：按采集日期取最新观察；同日但坐标不同视为口径冲突
    for (const coordField of ['longitude', 'latitude'] as const) {
      if (localRow[coordField] !== inRow[coordField] && incoming.collectDate === existing.collectDate) {
        fieldConflicts.push({
          field: coordField,
          fieldLabel: POINT_LABELS[coordField],
          local: displayValue(localRow[coordField]),
          incoming: displayValue(inRow[coordField])
        })
      }
    }

    if (fieldConflicts.length > 0) {
      conflicts.push({ entity: 'point', key: existing.name, fields: fieldConflicts })
      continue
    }

    const coordNewer =
      existing.longitude !== incoming.longitude || existing.latitude !== incoming.latitude
        ? incoming.collectDate.localeCompare(existing.collectDate) > 0
        : false
    const merged: CollectPoint = {
      ...existing,
      longitude: coordNewer ? incoming.longitude : existing.longitude,
      latitude: coordNewer ? incoming.latitude : existing.latitude,
      collectDate: laterDate(existing.collectDate, incoming.collectDate)
    }
    // 完全一致则跳过，不产生重复写入
    if (JSON.stringify(existing) === JSON.stringify(merged)) continue
    ops.push({ id: `point:${existing.id}`, table: 'points', mode: 'upsert', row: merged })
    summary.points++
  }

  const resolvePointId = (batchRef: string): string => pointIdMap.get(batchRef) ?? batchRef
  const resolvePointName = (pointId: string): string =>
    batch.points.find((p) => p.id === pointId)?.name.trim() ?? localPointsById.get(pointId)?.name.trim() ?? '（未知采集点）'

  // ----- 菌物条目 -----
  for (const incomingRaw of batch.records) {
    const incoming: FungusRecord = { ...incomingRaw, code: incomingRaw.code.trim() }
    incoming.pointId = resolvePointId(incoming.pointId)
    const existing = localRecordsByCode.get(incoming.code)
    if (!existing) {
      recordIdMap.set(incomingRaw.id, incoming.id)
      ops.push({ id: `record:${incoming.id}`, table: 'records', mode: 'upsert', row: incoming })
      summary.records++
      continue
    }
    recordIdMap.set(incomingRaw.id, existing.id)
    const localRow = existing as unknown as Row
    const inRow = incoming as unknown as Row

    const fieldConflicts = diffFields(localRow, inRow, CONFLICT_RECORD_FIELDS, RECORD_LABELS)

    // 所属采集点：按名称比对（跨设备 id 不可比）
    const localPointName = resolvePointName(existing.pointId)
    const incomingPointName = resolvePointName(incoming.pointId)
    if (localPointName !== incomingPointName) {
      fieldConflicts.push({
        field: 'pointId',
        fieldLabel: RECORD_LABELS.pointId,
        local: localPointName,
        incoming: incomingPointName
      })
    }

    // 形态字段：按采集日期取最新观察；同日仍不一致则列冲突
    const sameDay = incoming.collectDate === existing.collectDate
    const incomingNewer = incoming.collectDate.localeCompare(existing.collectDate) > 0
    if (sameDay) {
      fieldConflicts.push(...diffFields(localRow, inRow, LATEST_RECORD_FIELDS, RECORD_LABELS))
    }

    if (fieldConflicts.length > 0) {
      conflicts.push({ entity: 'record', key: incoming.code, fields: fieldConflicts })
      continue
    }

    const merged: FungusRecord = {
      ...existing,
      pointId: incoming.pointId,
      collectDate: laterDate(existing.collectDate, incoming.collectDate)
    }
    if (incomingNewer) {
      for (const field of LATEST_RECORD_FIELDS) {
        ;(merged as unknown as Row)[field] = (incoming as unknown as Row)[field]
      }
    }
    if (JSON.stringify(existing) === JSON.stringify(merged)) continue
    ops.push({ id: `record:${existing.id}`, table: 'records', mode: 'upsert', row: merged })
    summary.records++
  }

  const resolveRecordId = (batchRef: string): string => recordIdMap.get(batchRef) ?? batchRef

  // ----- 孢子印：同一观察记录按观察日期取最新 -----
  for (const incomingRaw of batch.spores) {
    const incoming: SporePrint = { ...incomingRaw, recordId: resolveRecordId(incomingRaw.recordId) }
    const existing = localSporesById.get(incoming.id)
    if (!existing || existing.recordId !== incoming.recordId) {
      ops.push({ id: `spore:${incoming.id}`, table: 'spores', mode: 'upsert', row: incoming })
      summary.spores++
      continue
    }
    const localRow = existing as unknown as Row
    const inRow = incoming as unknown as Row
    const contentFields = ['color', 'shape', 'hours', 'moisture'] as const
    const sameContent = contentFields.every((f) => String(localRow[f] ?? '') === String(inRow[f] ?? ''))
    if (sameContent && existing.observeDate === incoming.observeDate) continue

    if (incoming.observeDate === existing.observeDate) {
      conflicts.push({
        entity: 'spore',
        key: incoming.id,
        fields: diffFields(localRow, inRow, contentFields, SPORE_LABELS)
      })
      continue
    }
    const winner = incoming.observeDate.localeCompare(existing.observeDate) > 0 ? incoming : existing
    if (winner === existing) continue
    ops.push({ id: `spore:${incoming.id}`, table: 'spores', mode: 'upsert', row: incoming })
    summary.spores++
  }

  // ----- 鉴定留痕：只追加，绝不覆盖库内历史 -----
  const appendedFingerprints = new Set<string>()
  const appendedIds = new Set<string>()
  for (const incomingRaw of batch.identifies) {
    const recordId = resolveRecordId(incomingRaw.recordId)
    const incoming: IdentifyLog = { ...incomingRaw, recordId }
    const fingerprint = identifyFingerprint(incoming, recordId)

    // 库内或本批已含同一结论：跳过，不重复追加
    const dupInLocal = local.identifies.some(
      (l) => l.recordId === recordId && identifyFingerprint(l, recordId) === fingerprint
    )
    if (dupInLocal || appendedFingerprints.has(fingerprint)) continue
    appendedFingerprints.add(fingerprint)

    // id 与库内或本批撞车但内容不同：换新 id 追加，保证只追加不丢记录
    while (localIdentifiesById.has(incoming.id) || appendedIds.has(incoming.id)) {
      incoming.id = uid('idf')
    }
    appendedIds.add(incoming.id)

    ops.push({ id: `identify:${incoming.id}`, table: 'identifies', mode: 'append', row: incoming })
    summary.identifies++
  }

  return { errors, conflicts, ops, summary }
}

/** 冲突实体中文名 */
export const ENTITY_LABELS: Record<SyncEntity, string> = {
  point: '采集点',
  record: '菌物条目',
  spore: '孢子印',
  identify: '鉴定留痕'
}

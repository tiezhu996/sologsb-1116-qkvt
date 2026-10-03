<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { BatchJob } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { recordStore } from '@/stores/recordStore'
import { sporeStore } from '@/stores/sporeStore'
import { pointStore } from '@/stores/pointStore'
import { identifyStore } from '@/stores/identifyStore'
import { syncStore, type ImportPreview } from '@/stores/syncStore'
import { buildSyncBatch } from '@/utils/syncBatch'
import { downloadJson } from '@/utils/export'
import { ENTITY_LABELS } from '@/utils/syncPlanner'

const recordState = useStore(recordStore)
const sporeState = useStore(sporeStore)
const pointState = useStore(pointStore)
const identifyState = useStore(identifyStore)
const syncState = useStore(syncStore)

function defaultBatchId(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `XC-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

const exportForm = reactive({
  deviceId: '',
  deviceName: '',
  batchId: defaultBatchId(),
  exportedBy: ''
})

const preview = ref<ImportPreview | null>(null)
const importing = ref(false)
const conflictJob = ref<BatchJob | null>(null)
const uploadRef = ref<{ clearFiles: () => void } | null>(null)

const previewLegacy = computed(() => preview.value?.legacy ?? false)
const previewConflicts = computed(() => preview.value?.conflicts ?? [])
const exportLegacy = computed(() => !exportForm.deviceId.trim() || !exportForm.batchId.trim())

function exportBatch(): void {
  const batch = buildSyncBatch({
    deviceId: exportForm.deviceId,
    deviceName: exportForm.deviceName,
    batchId: exportForm.batchId,
    exportedBy: exportForm.exportedBy,
    points: pointState.points,
    records: recordState.records,
    spores: sporeState.spores,
    identifies: identifyState.logs
  })
  const suffix = exportLegacy.value
    ? `临时来源_${batch.exportedAt.slice(0, 10)}`
    : `${exportForm.deviceId.trim()}_${exportForm.batchId.trim()}`
  downloadJson(`gbfungi-offline-${suffix}.json`, batch)
  ElMessage.success(exportLegacy.value ? '已导出（无设备编号/批次号，将按临时来源显示）' : '离线批次已导出')
}

async function onFileChange(uploadFile: { raw?: File }): Promise<void> {
  const file = uploadFile.raw
  if (!file) return
  const text = await file.text()
  preview.value = await syncStore.getState().previewFile(file.name, text)
  uploadRef.value?.clearFiles()
}

function resetPreview(): void {
  preview.value = null
}

async function confirmImport(): Promise<void> {
  if (!preview.value) return
  importing.value = true
  try {
    const { duplicated, job } = await syncStore.getState().commitPreview(preview.value)
    if (duplicated) {
      ElMessage.warning(`该批次已导入完成（${job?.sourceLabel ?? ''}），不重复写入`)
    } else {
      ElMessage.success('批次已开始写入，如遇中断可在下方从断点继续')
    }
    preview.value = null
  } finally {
    importing.value = false
  }
}

async function keepBlocked(): Promise<void> {
  if (!preview.value) return
  await syncStore.getState().archiveBlocked(preview.value)
  ElMessage.info('冲突批次已留档，整批未写入；可在批次记录中查看冲突清单')
  preview.value = null
}

async function resume(job: BatchJob): Promise<void> {
  if (syncState.runningJobId) {
    ElMessage.warning('已有批次正在写入，请等待其完成')
    return
  }
  ElMessage.info('从断点继续写入，已完成的记录不会重复写入')
  await syncStore.getState().resume(job.id)
  const latest = syncState.jobs.find((item) => item.id === job.id)
  if (latest?.status === 'done') ElMessage.success('批次已全部写入完成')
  else if (latest?.status === 'paused') ElMessage.warning(latest.lastError || '写入仍未完成，可再次继续')
}

async function remove(job: BatchJob): Promise<void> {
  await ElMessageBox.confirm(`删除批次记录「${job.sourceLabel}」？该操作只删除合并记录，不影响已写入的业务数据。`, '删除确认', {
    type: 'warning'
  })
  await syncStore.getState().removeJob(job.id)
  ElMessage.success('批次记录已删除')
}

function progressOf(job: BatchJob): number {
  if (job.ops.length === 0) return job.status === 'done' ? 100 : 0
  return Math.min(100, Math.round((job.doneOpIds.length / job.ops.length) * 100))
}

function statusTag(job: BatchJob): { type: 'success' | 'warning' | 'danger'; text: string } {
  if (job.status === 'done') return { type: 'success', text: '已完成' }
  if (job.status === 'paused') return { type: 'warning', text: '断点暂停' }
  return { type: 'danger', text: '冲突挡住' }
}

onMounted(async () => {
  await Promise.all([
    pointStore.getState().hydrate(),
    recordStore.getState().hydrate(),
    sporeStore.getState().hydrate(),
    identifyStore.getState().hydrate(),
    syncStore.getState().hydrate()
  ])
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">离线批次合并</h2>
        <p class="page-sub">
          巡采设备回驻地后导出整库批次：同名采集点 / 同编号条目有口径差异会列出冲突并整批挡住；形态与坐标按最新观察合并，鉴定结论只追加；中途失败可从断点继续，重试不重复写入。
        </p>
      </div>
    </div>

    <el-alert type="info" :closable="false" class="block">
      <template #title>
        合并规则：① 批次保存采集点、菌物条目、孢子印、鉴定留痕四类数据；② 同名采集点经纬度按采集日期取最新，其余字段不一致即冲突；③
        同编号条目的形态特征按采集日期取最新，暂定名 / 采集人 / 备注 / 所属采集点不一致即冲突；④ 鉴定结论只追加不改写。
      </template>
    </el-alert>

    <div class="two-col">
      <el-card shadow="never" class="block">
        <template #header>导出离线批次（设备侧整库）</template>
        <el-form label-width="96px">
          <el-form-item label="设备编号">
            <el-input v-model="exportForm.deviceId" placeholder="如 DEV-07；旧设备无编号则留空" />
          </el-form-item>
          <el-form-item label="设备名称">
            <el-input v-model="exportForm.deviceName" placeholder="如 三队巡采平板" />
          </el-form-item>
          <el-form-item label="批次号">
            <el-input v-model="exportForm.batchId" placeholder="如 XC-20261003-A1F2" />
          </el-form-item>
          <el-form-item label="导出人">
            <el-input v-model="exportForm.exportedBy" placeholder="如 祁野" />
          </el-form-item>
        </el-form>
        <el-alert
          v-if="exportLegacy"
          type="warning"
          :closable="false"
          title="未填写设备编号或批次号，导入时将按「临时来源」显示，不会与已有批次合并去重。"
          class="legacy-tip"
        />
        <div class="tip-line muted">
          将导出：采集点 {{ pointState.points.length }} · 条目 {{ recordState.records.length }} · 孢子印
          {{ sporeState.spores.length }} · 鉴定留痕 {{ identifyState.logs.length }}
        </div>
        <el-button type="primary" @click="exportBatch">导出批次 JSON</el-button>
      </el-card>

      <el-card shadow="never" class="block">
        <template #header>导入离线批次（预检后落库）</template>
        <el-upload
          ref="uploadRef"
          :auto-upload="false"
          :show-file-list="false"
          accept=".json,application/json"
          :on-change="onFileChange"
          drag
          class="uploader"
        >
          <el-icon class="upload-icon"><upload-filled /></el-icon>
          <div class="upload-text">把设备导出的批次 JSON 拖到这里，或点击选择文件</div>
          <template #tip>
            <div class="muted">先做结构校验与冲突预检，确认无冲突才允许整批写入。</div>
          </template>
        </el-upload>
      </el-card>
    </div>

    <!-- 预检结果 -->
    <el-card v-if="preview" shadow="never" class="block">
      <template #header>
        <div class="preview-head">
          <span>导入预检：{{ preview.fileName }}</span>
          <el-button size="small" text @click="resetPreview">关闭</el-button>
        </div>
      </template>

      <el-descriptions :column="2" border size="small" class="desc">
        <el-descriptions-item label="来源">
          <el-tag v-if="preview.legacy" type="warning" size="small" effect="dark">临时来源（旧设备）</el-tag>
          <span>{{ preview.sourceLabel }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="导出时间">{{ preview.exportedAt?.replace('T', ' ').slice(0, 19) ?? '—' }}</el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="previewLegacy"
        type="warning"
        :closable="false"
        class="legacy-tip"
        title="该批次没有设备编号或批次号，将作为独立的「临时来源」记录，不能与任何已有批次合并。"
      />

      <template v-if="preview.errors.length > 0">
        <h4 class="result-title text-danger">结构错误（{{ preview.errors.length }}）— 已挡住导入</h4>
        <ul class="issue-list">
          <li v-for="(msg, i) in preview.errors" :key="i" class="danger">{{ msg }}</li>
        </ul>
      </template>

      <template v-else>
        <h4 class="result-title">
          本批将写入：采集点 {{ preview.plan?.summary.points ?? 0 }} · 条目
          {{ preview.plan?.summary.records ?? 0 }} · 孢子印 {{ preview.plan?.summary.spores ?? 0 }} · 鉴定追加
          {{ preview.plan?.summary.identifies ?? 0 }}
        </h4>

        <div v-if="preview.conflicts.length > 0">
          <el-alert
            type="error"
            :closable="false"
            :title="`发现 ${preview.conflicts.length} 处冲突，整批已挡住，未写入任何数据。请先在库内或设备侧核对后重新导出。`"
            class="legacy-tip"
          />
          <el-table :data="previewConflicts" border stripe size="small" max-height="320">
            <el-table-column label="对象" width="180">
              <template #default="{ row }: { row: (typeof previewConflicts.value)[number] }">
                <el-tag size="small" effect="plain">{{ ENTITY_LABELS[row.entity] }}</el-tag>
                <span class="conflict-key">{{ row.key }}</span>
              </template>
            </el-table-column>
            <el-table-column label="字段冲突">
              <template #default="{ row }: { row: (typeof previewConflicts.value)[number] }">
                <div v-for="f in row.fields" :key="f.field" class="conflict-row">
                  <b>{{ f.fieldLabel }}</b>
                  <span class="muted">库内：{{ f.local }}</span>
                  <span class="muted">批次：{{ f.incoming }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div class="actions">
            <el-button type="danger" plain @click="keepBlocked">留档该冲突批次</el-button>
          </div>
        </div>

        <div v-else class="actions">
          <el-button type="primary" :loading="importing" @click="confirmImport">确认无冲突，整批导入</el-button>
          <el-button @click="resetPreview">取消</el-button>
        </div>
      </template>
    </el-card>

    <!-- 批次记录 -->
    <h3 class="section-title">批次记录（{{ syncState.jobs.length }}）</h3>
    <el-table :data="syncState.jobs" border stripe>
      <el-table-column label="来源" min-width="220">
        <template #default="{ row }: { row: BatchJob }">
          <div class="source-cell">
            <el-tag v-if="row.legacy" type="warning" size="small" effect="dark">临时来源</el-tag>
            <el-tag v-else size="small" effect="plain">设备批次</el-tag>
            <span>{{ row.sourceLabel }}</span>
          </div>
          <div class="muted">{{ row.fileName }}</div>
        </template>
      </el-table-column>
      <el-table-column label="写入内容" width="230">
        <template #default="{ row }: { row: BatchJob }">
          <span class="muted">
            点 {{ row.summary.points }} / 条 {{ row.summary.records }} / 孢 {{ row.summary.spores }} / 鉴
            {{ row.summary.identifies }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="进度" width="180">
        <template #default="{ row }: { row: BatchJob }">
          <el-progress :percentage="progressOf(row)" :status="row.status === 'done' ? 'success' : undefined" />
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }: { row: BatchJob }">
          <el-tag :type="statusTag(row).type" size="small" effect="plain">{{ statusTag(row).text }}</el-tag>
          <el-tag v-if="syncState.runningJobId === row.id" type="primary" size="small" effect="dark" class="run-tag">
            写入中
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="200">
        <template #default="{ row }: { row: BatchJob }">
          <span v-if="row.lastError" class="danger">{{ row.lastError }}</span>
          <span v-else-if="row.status === 'blocked'" class="danger">{{ row.conflicts.length }} 处冲突挡住</span>
          <span v-else class="muted">{{ row.updatedAt.replace('T', ' ').slice(0, 19) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }: { row: BatchJob }">
          <el-button
            v-if="row.status === 'paused'"
            size="small"
            type="primary"
            :loading="syncState.runningJobId === row.id"
            @click="resume(row)"
          >
            从断点继续
          </el-button>
          <el-button
            v-if="row.status === 'blocked'"
            size="small"
            @click="conflictJob = row"
          >
            查看冲突
          </el-button>
          <el-button size="small" type="danger" plain :disabled="syncState.runningJobId === row.id" @click="remove(row)">
            删除记录
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 冲突清单 -->
    <el-drawer v-model="conflictJob" title="冲突清单（整批未写入）" size="56%">
      <template v-if="conflictJob">
        <div class="muted drawer-sub">{{ conflictJob.sourceLabel }} · {{ conflictJob.fileName }}</div>
        <el-table :data="conflictJob.conflicts" border stripe size="small">
          <el-table-column label="对象" width="160">
            <template #default="{ row }: { row: BatchJob['conflicts'][number] }">
              <el-tag size="small" effect="plain">{{ ENTITY_LABELS[row.entity] }}</el-tag>
              <div class="conflict-key">{{ row.key }}</div>
            </template>
          </el-table-column>
          <el-table-column label="字段 / 库内 / 批次" min-width="280">
            <template #default="{ row }: { row: BatchJob['conflicts'][number] }">
              <div v-for="f in row.fields" :key="f.field" class="conflict-row">
                <b>{{ f.fieldLabel }}</b>
                <span class="muted">库内：{{ f.local }}</span>
                <span class="muted">批次：{{ f.incoming }}</span>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.block {
  border-radius: 12px;
  margin-bottom: 16px;
}
.two-col {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
  gap: 16px;
}
.legacy-tip {
  margin: 10px 0;
}
.tip-line {
  margin: 4px 0 12px;
}
.uploader {
  width: 100%;
}
.upload-icon {
  font-size: 40px;
  color: #c96f3a;
  margin: 12px 0 8px;
}
.upload-text {
  font-size: 13px;
  margin-bottom: 8px;
}
.preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.desc {
  margin: 8px 0 12px;
}
.result-title {
  font-size: 14px;
  margin: 10px 0;
}
.text-danger,
.danger {
  color: #c45656;
}
.issue-list {
  margin: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.9;
}
.conflict-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
  font-size: 12px;
  border-bottom: 1px dotted #eef2f6;
}
.conflict-key {
  font-weight: 600;
  margin-left: 6px;
}
.actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
.source-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.run-tag {
  margin-left: 6px;
}
.drawer-sub {
  margin-bottom: 12px;
}
</style>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { MergePlan, OfflineBatch } from '@/types'
import { downloadJson } from '@/utils/export'
import { parseOfflineBatch } from '@/utils/offlineMerge'
import { useStore } from '@/hooks/usePersistentStore'
import { syncStore } from '@/stores/syncStore'

const syncState = useStore(syncStore)

/* ---------- 导出 ---------- */
const legacyExport = ref(false)
const exporting = ref(false)

async function doExport(): Promise<void> {
  exporting.value = true
  try {
    const batch = await syncStore.getState().exportBatch(legacyExport.value)
    const name = batch.batchNo
      ? `offline-batch_${batch.deviceId}_${batch.batchNo}.json`
      : `offline-batch_legacy_${Date.now()}.json`
    downloadJson(name, batch)
    ElMessage.success(
      batch.batchNo ? `批次 ${batch.batchNo} 已导出` : '已按旧设备格式导出（不含设备编号与批次号）'
    )
  } finally {
    exporting.value = false
  }
}

/* ---------- 导入与合并 ---------- */
const fileInput = ref<HTMLInputElement | null>(null)
const batch = ref<OfflineBatch | null>(null)
const fileName = ref('')
const parseErrors = ref<string[]>([])
const plan = ref<MergePlan | null>(null)
const applying = ref(false)
const failed = ref(false)
const failMessage = ref('')
const finished = ref(false)
const progress = reactive({ done: 0, total: 0, label: '' })

const insertCount = computed(() => plan.value?.steps.filter((step) => step.action === 'insert').length ?? 0)
const updateCount = computed(() => plan.value?.steps.filter((step) => step.action === 'update').length ?? 0)
const progressPercent = computed(() =>
  progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)
)

function pickFile(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  resetImport()
  fileName.value = file.name
  const text = await file.text()
  const parsed = parseOfflineBatch(text)
  if (!parsed.batch) {
    parseErrors.value = parsed.errors
    return
  }
  const refErrors = await syncStore.getState().validateRefs(parsed.batch)
  if (refErrors.length > 0) {
    parseErrors.value = refErrors
    return
  }
  batch.value = parsed.batch
  plan.value = syncStore.getState().previewPlan(parsed.batch)
}

function resetImport(): void {
  batch.value = null
  fileName.value = ''
  parseErrors.value = []
  plan.value = null
  failed.value = false
  failMessage.value = ''
  finished.value = false
  progress.done = 0
  progress.total = 0
  progress.label = ''
}

async function runImport(): Promise<void> {
  const current = batch.value
  if (!current) return
  applying.value = true
  failed.value = false
  failMessage.value = ''
  try {
    const result = await syncStore.getState().importBatch(current, (done, total, label) => {
      progress.done = done
      progress.total = total
      progress.label = label
    })
    plan.value = result
    if (result.conflicts.length > 0) {
      ElMessage.warning('存在冲突，已挡住导入，未写入任何数据')
      return
    }
    finished.value = true
    // 进度以台账为准（断点续传时包含此前已完成的步骤）
    const journal = syncStore.getState().journals.find((item) => item.key === result.batchKey)
    progress.total = journal?.total ?? result.steps.length
    progress.done = journal?.doneKeys.length ?? result.steps.length
    ElMessage.success(
      result.steps.length > 0
        ? `合并完成：新增 ${result.steps.filter((s) => s.action === 'insert').length} 项，更新 ${result.steps.filter((s) => s.action === 'update').length} 项`
        : '批次内容已与本地一致，无需写入'
    )
  } catch (err) {
    failed.value = true
    failMessage.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('合并中途失败，可从断点继续')
  } finally {
    applying.value = false
  }
}

function statusTag(status: 'applying' | 'done' | 'failed'): { type: 'success' | 'danger' | 'warning'; label: string } {
  if (status === 'done') return { type: 'success', label: '已合并' }
  if (status === 'failed') return { type: 'danger', label: '失败（可续传）' }
  return { type: 'warning', label: '进行中（中断可续）' }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">离线批次合并</h2>
        <p class="page-sub">
          巡采队离线设备回驻地后整批导入：同名采集点或同编号条目内容不一致会列出冲突并挡住导入；
          形态与坐标取最新观察，鉴定结论只追加；写入中途失败可从断点继续，重试不会重复写入。
        </p>
      </div>
    </div>

    <el-card shadow="never" class="block">
      <template #header>本机与批次导出</template>
      <el-descriptions :column="3" size="small" border class="device-desc">
        <el-descriptions-item label="本机设备编号">
          <span class="mono">{{ syncState.deviceId || '首次导出时自动分配' }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="已导出批次">{{ syncState.batchSeq }} 批</el-descriptions-item>
        <el-descriptions-item label="批次内容">采集点 + 菌物条目 + 孢子印 + 鉴定留痕</el-descriptions-item>
      </el-descriptions>
      <div class="export-line">
        <el-checkbox v-model="legacyExport">旧设备兼容格式（不写入设备编号与批次号，导入端按临时来源处理）</el-checkbox>
        <el-button type="primary" :loading="exporting" @click="doExport">
          <el-icon><Download /></el-icon>导出离线批次
        </el-button>
      </div>
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>导入与合并</template>
      <div class="import-bar">
        <input ref="fileInput" type="file" accept=".json,application/json" class="file-input" @change="onFileChange" />
        <el-button @click="pickFile"><el-icon><FolderOpened /></el-icon>选择批次文件</el-button>
        <span v-if="fileName" class="muted mono">{{ fileName }}</span>
        <el-button v-if="batch || parseErrors.length > 0" size="small" @click="resetImport">清除</el-button>
      </div>

      <el-alert
        v-for="(error, index) in parseErrors"
        :key="index"
        :title="error"
        type="error"
        :closable="false"
        class="parse-error"
      />

      <template v-if="batch && plan">
        <el-descriptions :column="3" size="small" border class="device-desc">
          <el-descriptions-item label="批次来源">
            {{ plan.sourceLabel }}
            <el-tag v-if="plan.tempSource" type="warning" size="small" effect="dark" class="temp-tag">临时来源</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="导出时间">{{ batch.exportedAt || '—' }}</el-descriptions-item>
          <el-descriptions-item label="批次规模">
            采集点 {{ batch.points.length }} · 条目 {{ batch.records.length }} · 孢子印 {{ batch.spores.length }} · 鉴定
            {{ batch.identifies.length }}
          </el-descriptions-item>
        </el-descriptions>

        <div class="plan-line">
          <el-tag type="success" effect="plain">新增 {{ insertCount }}</el-tag>
          <el-tag type="primary" effect="plain">更新 {{ updateCount }}</el-tag>
          <el-tag type="info" effect="plain">跳过 {{ plan.skipped }}</el-tag>
          <el-tag :type="plan.conflicts.length > 0 ? 'danger' : 'info'" effect="plain">
            冲突 {{ plan.conflicts.length }}
          </el-tag>
        </div>

        <template v-if="plan.conflicts.length > 0">
          <el-alert
            title="同名采集点或同编号条目内容不一致，已挡住导入。请先在线下核对后再重新导出批次。"
            type="error"
            :closable="false"
            class="parse-error"
          />
          <el-table :data="plan.conflicts" border stripe class="conflict-table">
            <el-table-column prop="entity" label="对象" width="100" />
            <el-table-column prop="key" label="名称 / 编号" min-width="160" />
            <el-table-column label="不一致字段" min-width="320">
              <template #default="{ row }: { row: { fields: { label: string; local: string; incoming: string }[] } }">
                <div v-for="field in row.fields" :key="field.label" class="conflict-field">
                  <el-tag size="small" effect="plain">{{ field.label }}</el-tag>
                  <span class="muted">本地 {{ field.local }}</span>
                  <span>→</span>
                  <span class="incoming">批次 {{ field.incoming }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </template>

        <div class="run-line">
          <el-button
            type="primary"
            :disabled="plan.conflicts.length > 0 || (plan.steps.length === 0 && !failed)"
            :loading="applying"
            @click="runImport"
          >
            {{ failed ? '从断点继续' : '开始合并' }}
          </el-button>
          <span v-if="plan.steps.length === 0 && !finished" class="muted">批次内容已与本地一致，无需写入</span>
          <span v-if="failed" class="fail-text">上次写入中断：{{ failMessage }}。已完成的步骤不会重复写入。</span>
        </div>

        <div v-if="applying || failed || finished" class="progress-box">
          <el-progress :percentage="progressPercent" :status="failed ? 'exception' : finished ? 'success' : undefined" />
          <p class="muted progress-label">
            {{ finished ? '合并完成' : failed ? '已暂停，可从断点继续' : `正在写入：${progress.label}` }}
            （{{ progress.done }} / {{ progress.total }}）
          </p>
        </div>
      </template>
      <el-empty v-else-if="parseErrors.length === 0" description="选择离线设备导出的批次 JSON 文件，先预览合并计划再执行" />
    </el-card>

    <el-card shadow="never" class="block">
      <template #header>导入台账（断点恢复依据）</template>
      <el-table :data="syncState.journals" border stripe>
        <el-table-column label="来源" min-width="200">
          <template #default="{ row }: { row: { sourceLabel: string; tempSource: boolean } }">
            {{ row.sourceLabel }}
            <el-tag v-if="row.tempSource" type="warning" size="small" effect="dark" class="temp-tag">临时来源</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="批次键" min-width="180">
          <template #default="{ row }: { row: { key: string } }">
            <span class="mono">{{ row.key }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }: { row: { status: 'applying' | 'done' | 'failed' } }">
            <el-tag :type="statusTag(row.status).type" size="small" effect="plain">{{ statusTag(row.status).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="进度" width="110">
          <template #default="{ row }: { row: { doneKeys: string[]; total: number } }">
            {{ row.doneKeys.length }} / {{ row.total }}
          </template>
        </el-table-column>
        <el-table-column prop="updatedAt" label="更新时间" min-width="170" />
        <el-table-column label="错误" min-width="160">
          <template #default="{ row }: { row: { error: string } }">
            <span class="fail-text">{{ row.error || '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-if="syncState.journals.length === 0" description="尚无导入记录" />
    </el-card>
  </div>
</template>

<style scoped>
.block {
  border-radius: 12px;
  margin-bottom: 16px;
}
.device-desc {
  margin-bottom: 12px;
}
.export-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.import-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.file-input {
  display: none;
}
.parse-error {
  margin-bottom: 10px;
}
.plan-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}
.conflict-table {
  margin-bottom: 12px;
}
.conflict-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.incoming {
  color: #b23c2a;
}
.temp-tag {
  margin-left: 6px;
}
.run-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.fail-text {
  color: #b23c2a;
  font-size: 12px;
}
.progress-box {
  margin-top: 12px;
}
.progress-label {
  margin: 6px 0 0;
}
</style>

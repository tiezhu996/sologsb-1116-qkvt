# 野生菌采集鉴定图谱（gbfungiguide）

面向蘑菇野外调查爱好者与地方菌物名录整理者，把「采集点 → 形态描述 → 孢子印 → 菌褶/菌管着生方式 → 鉴定结论」整理成可对照的图谱条目，解决形态特征记不全、描述口径不一、鉴定结论缺乏依据留痕的问题。**纯前端单页应用**，数据全部保存在浏览器 IndexedDB，不依赖任何后端服务或外部接口。

> 免责声明：本工具仅用于采集记录与形态整理，**内容不可作为食用依据**；鉴定须与权威图鉴和专业人员复核。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env      # 首次启动先复制环境变量文件
docker compose up -d --build
```

启动后访问：<http://localhost:21816>

```bash
docker compose ps        # 查看容器状态
docker compose logs -f   # 查看日志
docker compose down      # 停止并移除容器（数据在浏览器本地）
```

`.env` 可调：

```
COMPOSE_PROJECT_NAME=gbfungiguide
FRONTEND_PORT=21816
```

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（Composition API） |
| 语言 | TypeScript（`vue-tsc` 类型检查零错误） |
| UI 组件库 | Element Plus |
| 状态管理 | Zustand（`zustand/vanilla` createStore + Vue 响应式桥接） |
| 路由 | Vue Router 4（History 模式，nginx `try_files` 回落） |
| 构建 | Vite 6 |
| 本地存储 | IndexedDB（Dexie 封装，含 `schemaVersion` 与升级迁移） |
| 部署 | 多阶段 Dockerfile：`node:20-alpine` 构建 → `nginx:alpine` 托管 |

## 三、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:21816
npm run build      # 类型检查 + 生产构建
```

## 四、目录结构

```
sologsb-1116/
├── docker-compose.yml          # 顶层 name: gbfungiguide，无 version 字段
├── .env.example                # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── frontend/
│   ├── Dockerfile              # 多阶段构建，nginx 阶段 chmod -R a+rX 静态资源
│   ├── nginx.conf              # try_files 前端路由回落 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # record.ts / spore.ts / point.ts / identify.ts / index.ts
│       ├── stores/             # recordStore / sporeStore / pointStore / identifyStore / syncStore（Zustand）
│       ├── components/common/  # SporePrintSwatch / TraitsSummary / GillAttachmentTag / GeoPointForm
│       ├── hooks/              # usePersistentStore / useCandidateMatch
│       ├── pages/              # AtlasPage / RecordDetailPage / PointsPage / IdentifyPage / ComparePage / SyncPage
│       ├── router/index.ts
│       └── utils/              # spore.ts / export.ts / id.ts / syncPlanner.ts（冲突检测与合并规划）/ syncBatch.ts（批次包与来源指纹）
```

## 五、数据模型与存储

| 模型 | 说明 | Dexie 表 |
| --- | --- | --- |
| FungusRecord 菌物条目 | 采集编号、暂定名、菌盖（直径/形状/边缘/质地）、菌肉厚度与变色反应、着生方式、菌褶密度、菌柄、菌环菌托、气味、关联树种 | `records` |
| SporePrint 孢子印 | 印色、印形、获取时长、观察日期、样本干湿度 | `spores` |
| CollectPoint 采集点 | 地点名、经纬度、海拔、植被类型、基物、伴生树种、日期、采集人 | `points` |
| IdentifyLog 鉴定结论 | 结论学名、依据、参考图鉴与页码、置信度、是否待复核、复核人 | `identifies` |
| BatchJob 离线批次任务 | 设备/批次来源（旧设备为临时来源指纹）、写入操作清单、断点游标、冲突留档、暂停/完成状态 | `batchJobs` |

- 数据库名 `gbfungiguide`，`meta` 表保存 `schemaVersion`；
- `version(2)` 升级迁移会为历史条目补齐「菌肉变色反应」默认值（不变色）；
- `version(3)` 新增 `batchJobs` 表，支撑离线批次合并的冲突留档与整批断点恢复；
- 数据仅存于浏览器本地，容器无状态、不挂载命名卷。

## 六、主要页面

| 路由 | 功能 |
| --- | --- |
| `/atlas` | 图谱总览：网格卡片展示菌盖形态要点、孢子印色块与鉴定状态，按印色/着生方式筛选并新建条目 |
| `/atlas/:id` | 条目详情：形态描述分区折叠、孢子印观察登记、采集点编辑（含坐标校验）、鉴定留痕 |
| `/points` | 采集点管理：经纬度格式校验、条目数与主要基物统计、删除前校验下级条目 |
| `/identify` | 鉴定工作页：左侧勾选形态特征与印色，右侧实时给出候选名录排序，确认后落鉴定结论 |
| `/compare` | 条目对比：并排最多 3 条，逐项对照菌盖/菌褶菌管/孢子印差异并高亮 |
| `/sync` | 离线批次合并：设备整库导出/导入预检、冲突拦截、鉴定追加、断点恢复 |

## 六点五、离线批次合并（巡采队场景）

巡采队带离线设备外出，回驻地不能整库覆盖（图谱库与设备改过同一采集点或菌物条目会互相覆盖丢记录），因此采用「整包批次 + 规则合并」：

- **批次内容**：导出 JSON 同时保存采集点、菌物条目、孢子印、鉴定留痕四类数据，带设备编号、设备名、批次号、导出时间。
- **合并规则**：
  - 同名采集点：经纬度按**采集日期取最新观察**，日期相同而坐标不同列为冲突；海拔/植被/基物/伴生树种/采集人不一致一律列冲突；
  - 同采集编号条目：形态字段（菌盖/菌肉/菌褶/菌柄/气味/关联树种/数量）按**采集日期取最新**，同日不一致列冲突；暂定名/采集人/备注/所属采集点不同列冲突；
  - 孢子印：同一观察记录按观察日期取最新，同日内容不同列冲突；
  - 鉴定结论：**只追加、不改写**库内历史；同一结论按内容指纹去重，主键撞车自动换新 id 追加。
- **冲突拦截**：预检只要存在一处结构错误或内容冲突，整批挡住、不写任何业务数据；冲突清单逐字段列出「库内 / 批次」差异，可留档为 blocked 批次回看。
- **断点恢复**：任务持久化在 `batchJobs` 表，按 采集点 → 条目 → 孢子印 → 鉴定 顺序逐条写，每条成功后落断点；中途失败（含页面崩溃重开）任务置为暂停，从断点继续，按主键重放幂等，重试不重复写入。
- **旧设备兼容**：批次缺少设备编号或批次号时按「临时来源」独立建档（任务主键取批次内容指纹），同文件不重复导入、内容不同也不会混入任何已有设备批次。

## 七、候选排序规则

- 权重：着生方式 26、孢子印 22、菌盖形状 12、表面质地 10、菌褶密度 10、菌盖边缘 8、菌肉反应 8、关联树种 4；
- 印色与条目着生方式若属于该印色的先验组合（如白色↔离生/弯生），计半分；
- 排序先比总分，总分相同则优先展示着生方式一致的条目。

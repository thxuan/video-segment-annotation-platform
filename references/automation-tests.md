# 测试与验证

人工操作见 [验收清单](acceptance.md)，业务规则见 [架构约定](architecture.md)，环境错误见 [故障排查](troubleshooting.md)。本机回归结果与 GitHub CI 分别记录，都不能替代最终用户体验验收。

## GitHub Actions 基础 CI

配置位于 [.github/workflows/ci.yml](../.github/workflows/ci.yml)，在 main 推送、PR 或 workflow_dispatch 手动触发时运行两个独立的 Ubuntu 24.04 任务：

- **前端**：Node.js 24、npm ci 锁文件安装、类型检查 / 生产构建和 32 项前端函数测试。
- **后端**：Python 3.12 锁文件安装、依赖一致性检查、FFmpeg 生成 8 秒 MP4 测试素材，拉取专用 PostgreSQL 17 镜像后运行 integration 入口，执行 155 项后端函数 / 数据库 / 日期测试，跳过项不能算通过。

CI 不需要仓库 Secrets，不读取原业务配置或数据。媒体素材是临时生成的测试视频，不依赖 Hugging Face；PostgreSQL 使用已有隔离护栏及 tmpfs，并由脚本清理。Actions 固定到完整提交 SHA，GITHUB_TOKEN 仅授予 contents:read。只上传指定的摘要、JUnit 和后端测试日志，保留 7 天，不上传配置文件、视频或数据库。

实际运行状态以 [Actions 页面](https://github.com/thxuan/video-segment-annotation-platform/actions) 为准。基础 CI 不执行模拟 UI、真实浏览器七场景或应用 Docker 镜像构建，完整验证仍使用下文的本地入口；不配置 CD 或自动部署。

## 环境与日常分工

按 [README](../README.md) 准备 Node.js 24、Python 3.12 后端虚拟环境、前端 npm 依赖及演示视频。浏览器脚本使用项目锁定的 Playwright，默认已安装的 Microsoft Edge；可用 TEST_BROWSER_CHANNEL 切换已安装通道、TEST_PYTHON 指定 Python。脚本不自动下载安装浏览器、依赖或视频。

- 每次 UI 修改执行类型检查、构建、函数测试和受影响页面交互；每页完成后用户执行真实业务复验。
- 共享组件影响多页时运行 shared；完整回归在全部 UI 完成或用户明确要求时执行，不作为每个小改动的默认动作。
- 纯文档 / 目录调整检查链接、路径、差异及描述一致性，不编写或运行无关应用测试。测试通过、未运行和用户验收分别记录。

## 局部检查入口

从 `src/frontend/` 执行，每次选择一个 page 值：

```powershell
npm run check:change -- --page=workspace
npm run check:change -- --page=statistics
npm run check:change -- --page=publish
npm run check:change -- --page=theme
npm run check:change -- --page=personal
npm run check:change -- --page=shared
npm run check:change -- --page=workspace --fragment=frame-shortcuts

npm run test:functions
npm run test:ui -- --page=publish
npm run check:baseline
```

`check:change` 包含类型、生产构建、前后端局部函数和所选页面；`test:ui` 仅运行交互；`check:baseline` 执行全部已有函数与模拟 UI。workspace 可细分 `pending-selection`、`refresh-state`、`input-feedback`、`add-focus`、`row-feedback`、`frame-shortcuts`、`save-recovery`。shared 包含工作台七组、统计、主题、个人统计和发布。没有对应脚本时可显式选 none，但须说明交互缺口，不能当作已验证。

统一入口清除继承的旧 EDITOR_FRAGMENT / FRONTEND_TEST_URL，独立管理 127.0.0.1:5183 测试 Vite；端口占用直接失败，结束关闭专用服务，不占用原 5173。每个脚本隔离浏览器上下文，未模拟的 API 请求被阻止，不能流向真实服务；局部后端只选择函数文件，部分使用内存 SQLite，不连接业务 PostgreSQL。

| 范围 | 文件与主要断言 |
| --- | --- |
| 前端函数 | `tests/frontend/*.test.mjs`：毫秒、区间、帧步进、草稿隔离、页面和自动保存偏好、大数展示 |
| 后端函数 | `tests/backend/test_*_fragments.py`：认证、路径、下载完整性、Schema、日期换算、帧索引、排序与测试目标护栏 |
| 工作台七组 | `editor-fragments.cjs`、`workspace-save-recovery.cjs`：I/O 目标与冲突、恢复 / revision、导航、焦点 / 错误行、快捷键 / 帧 / 全屏、失败与提交待确认；防抖使用 Playwright clock |
| 每日统计 | `statistics-fragments.cjs`：筛选、失败 / 空数据、行内分页与详情返回；切到任务管理 / 发布后保留未应用日期、原结果和展开页，不额外查询 |
| 发布 11 组 | `publish-fragments.cjs`：50 / 150 项列表、边界滚动、最后一行不被遮挡、深浅桌面 / 手机视口；标题 / 请求体 / CSRF、串行与连点、筛选、部分成功 / 仅失败重试、无效文件、网络 / 500 / 损坏成功响应、401 / 403、未完成离开 / 重置保护 |
| 主题 | `theme-fragments.cjs`：跨页、持久化、同源标签同步、全屏、窄屏、存储失败、编辑与播放位置保持 |
| 个人统计 | `personal-fragments.cjs`：365 天 / 历史年份、闰年、范围不改汇总、大数完整提示、空任务导航、成功弹窗 / 动效及失败不伪造结果 |

表内浏览器文件均位于 `tests/frontend/`。登录、任务列表没有独立完整模拟脚本，其他脚本的 App 导航不等于其全部覆盖。模拟检查不证明真实会话、上传、权限、数据库或统计闭环。

## 真实数据库与交付回归

除上述开发依赖外，需要可用 Docker Linux 引擎、本地 ffprobe，以及已有的 PostgreSQL 测试镜像 `pgvector/pgvector:0.8.0-pg17`（测试库启动使用 --pull never）。仅执行 Compose 快速启动不会安装宿主机测试依赖。项目根目录执行：

```powershell
# 后端函数、真实 PostgreSQL / HTTP、并发、媒体、日期
src/backend/.venv/Scripts/python.exe tools/run_automation.py integration
# 生产前端 + 隔离 API / 数据库的真实浏览器闭环
src/backend/.venv/Scripts/python.exe tools/run_automation.py e2e
# 类型 / 构建、全部函数 / 模拟 UI、数据库、真实浏览器
src/backend/.venv/Scripts/python.exe tools/run_automation.py release
# 构建 Linux API / Nginx 镜像并运行真实浏览器闭环
src/backend/.venv/Scripts/python.exe tools/run_automation.py compose
```

Linux / macOS 将 Python 路径改为 `src/backend/.venv/bin/python`。compose 镜像首次构建需要网络；两个镜像分别限时 1200 秒，可追加 `--build-timeout 1800`（允许 60–3600 秒），应用启动单独限时 120 秒。下载缓存和已有构建层会复用，耗时不是无缓存基准。

| 模式 | 函数 / 模拟 UI | 数据库套件 | 真实浏览器 | 容器应用构建 |
| --- | --- | --- | --- | --- |
| integration | 后端函数包含在 pytest 中 | 是 | 否 | 否 |
| e2e | 仅生产构建 | 不运行 pytest 套件 | 是 | 否 |
| release | 全部 | 是 | 是 | 否 |
| compose | 镜像内构建 | 不运行 pytest 套件 | 是 | 是 |

每条命令使用独立空库、迁移与清理生命周期；e2e / release / compose 重复 seed 并比较账号密码哈希及已修改任务，确认导入幂等。

- 项目名 annotation-automation-tests，固定数据库 / 用户 annotation_automation_tests，绑定 127.0.0.1:55435，tmpfs 临时存储；不写原 55433 或历史 55434 数据库。
- 专用 API 5801，生产预览 5184，容器 Nginx 5880；端口占用报错，不停止未知服务。视频复制到 `.cache/automation-videos/`，测试凭据写入忽略的 `.cache/automation-tests.env`，不输出密码。
- 连接前校验驱动、主机、端口、数据库及用户名，并拒绝可覆盖目标的 URL 参数；迁移和 SQL / 锁等待有超时，浏览器仅允许专用站点。
- `.cache/automation.lock` 防止并行执行；正常失败、超时和 Ctrl+C 清理子进程及专用容器。强制关闭留下锁时先确认 PID 已退出，再处理，不停原项目或删业务卷。
- 未启用专用开关时直接 pytest 会跳过数据库 / 日期集成，不自动启动服务；交付入口要求相关用例实际执行，出现 skipped 不能算全量通过。

## 真实覆盖范围

- **认证与权限**：跨租户、同租户他人任务、管理员 / 标注员角色、CSRF / Origin、匿名 / 过期 / 禁用 / 登出会话及个人统计身份范围，拒绝后原数据不变。
- **并发与事务**：多连接竞争领取、同版本保存、保存 / 提交、重复提交。第三连接持锁并确认请求进入锁等待后释放；数据库写入故障注入回滚，核对实际约束名及 1001 个互不重叠片段上限样本。
- **上传与媒体**：真实 ffprobe、帧索引、Range 206 / 416、空 / 损坏 / 不完整 / 超限文件、流式超限、探测失败与超时、标题 / 租户校验、文件清理和提交应答丢失时保留文件。
- **统计与日期**：14 项真实日期用例，覆盖北京时间午夜微秒边界、跨月 / 年 / 闰日、含首尾日、多片段计数、草稿排除、提交日与创建日区分、三个数据库时区、跨日保存后提交 / 次日重试、非法日期。只控制测试进程工作流时钟，不改系统时间。
- **七组浏览器闭环**：真实上传播放；跨租户列表 / 视频隔离；领取编辑、保存刷新且草稿不计统计；提交只读与个人统计；管理员统计追溯；两个真实 MP4 发布到 B、独立任务及租户权限、统计日期跨页保留；登出撤销与同浏览器换号。

## 单独复跑日期用例

完整 integration / release 已在 55435 临时库包含日期套件；也保留 55434 的独立入口，数据库 / 用户 annotation_date_tests，随机配置写入 `.cache/date-tests.env`，不读取原业务连接。PowerShell 在项目根目录执行：

```powershell
src/backend/.venv/Scripts/python.exe tools/prepare_date_tests.py
docker compose --env-file .cache/date-tests.env -f compose.date-tests.yaml up -d --pull never --wait
$env:RUN_DATE_DB_TESTS = '1'
try {
    src/backend/.venv/Scripts/python.exe -m pytest tests/backend/test_date_boundaries_integration.py -v --tb=short
} finally {
    Remove-Item Env:RUN_DATE_DB_TESTS
    docker compose --env-file .cache/date-tests.env -f compose.date-tests.yaml stop
}
```

用例事务回滚，停止后保留专用卷；未设置开关时 14 项 skipped 不算通过。不要复制原 `.env` 的数据库地址到测试配置。

## 最近结果、报告与限制

2026-10-24 修复发布页短屏操作栏遮挡后，已有两次最终执行通过（本次文档精简没有重跑应用测试）：

| 执行 | 已确认结果 | 本地证据 |
| --- | --- | --- |
| release | 类型 / 构建、32 项前端函数、全部模拟 UI、155 项后端（0 failed / 0 skipped）、七组真实浏览器、迁移及 seed 幂等 | `.cache/automation/2026-10-24T06-15-24-42744/summary.json` |
| 模拟 UI 明细 | 工作台七组、统计、主题、个人统计、发布 11 组；含深浅桌面 / 手机视口截图 | `.cache/checks/2026-10-24T06-15-29-709Z-47560/summary.json` |
| compose | Linux API / Web 镜像、空库应用启动、七组真实浏览器、专用服务清理 | `.cache/automation/2026-10-24T06-19-18-44280/summary.json` |

155 项包含 60 项后端函数、81 项其他集成和 14 项日期，不重复累计。后端仍有 Starlette / httpx 与 Alembic 配置两条弃用警告。遮挡问题由增加最后一行可见性断言实际复现，修复后局部和以上最终回归均通过，不用旧结果替代修复后的验证。

运行产物不上传 Git。统一入口生成 summary、逐步骤日志、JUnit、浏览器 scenarios；失败保存截图和 trace，发布脚本另存四种布局截图。报告分别标记 passed / failed / not-run；直接 pytest 的缓存与临时目录按本次运行分配在 `.cache/pytest/`。从失败步骤定位即可，不需重置业务数据。

未覆盖多浏览器矩阵、真实设备全屏、像素截图基线、大规模负载和长期稳定性。50 / 150 文件是模拟布局检查，不代表实际大批视频吞吐；真实双视频上传由 API / 数据库和容器闭环覆盖。自动化结果不替代 [最终人工验收](acceptance.md)。

# 视频片段标注平台

多租户机器人示教视频标注工具。题目来源：[phi-software/vibe-coding-challenge](https://github.com/phi-software/vibe-coding-challenge)。

项目仓库：[thxuan/video-segment-annotation-platform](https://github.com/thxuan/video-segment-annotation-platform)。

## 功能与技术栈

- **管理员**：指定租户，选择一个或多个 MP4 发布任务；每个视频独立标题、独立任务。紧凑发布队列支持内部滚动、状态筛选、上传进度和仅重试失败项；网络或服务端应答不明确时暂停，提示先核对结果。按日期、租户查看每日有效时长，展开任务追溯原始片段；同一登录工作区内切页保留统计日期和筛选状态。
- **标注员**：登录后领取本租户任务，播放视频、编辑多个片段、保存草稿并提交。支持时间输入、I / O 快捷选段、时间轴拖动、片段预览、撤销重做、1.5 秒防抖自动保存及本机草稿恢复；保存冲突或提交结果不明确时保留编辑并提示处理。
- **业务规则**：租户与对象权限在后端校验，同一任务片段不得重叠；提交后只读。有效时长为已提交片段长度之和，草稿不计入，按任务提交时的北京时间归账。
- **界面与个人统计**：支持深浅主题、窄屏布局和全屏工作台；个人统计展示累计 / 今日指标及活动热力图，默认最近 365 天，可查看已结束历史年份。主题按浏览器来源保存，初次默认深色。

前端使用 React、TypeScript、Vite、Tailwind CSS、shadcn/ui 风格基础组件及 TanStack Query；后端使用 FastAPI、SQLAlchemy、PostgreSQL 和 Alembic 数据库迁移。认证采用 Argon2 密码散列、服务端会话、HttpOnly Cookie，以及写请求来源 / CSRF 检查。视频保存在本地目录，通过鉴权接口播放并支持 Range 请求。

2026-10-24 发布前验证通过：类型检查 / 生产构建、32 项前端函数、全部模拟 UI（含发布页 11 组场景）、155 项后端测试（无失败、无跳过）、7 组真实浏览器业务场景，以及 Linux 容器构建与七场景冒烟。以上为本机隔离环境结果，自动化不替代最终人工体验验收。仓库另配置 [GitHub Actions CI](https://github.com/thxuan/video-segment-annotation-platform/actions)，在 main 推送、PR 或手动触发时检查前端构建 / 函数与后端真实数据库测试，不自动部署。覆盖范围与复跑方式见 [测试说明](references/automation-tests.md)。

## 推荐启动方式：Docker Compose

需要 Python 3.12（本项目验证版本）、Docker 的 Linux 容器环境及 Compose v2；Windows / macOS 可使用 Docker Desktop。此方式不需要在宿主机安装 Node.js、后端 Python 依赖或 ffprobe。先启动 Docker 引擎，等待就绪。

下载或克隆本仓库后，进入包含 `compose.yaml` 的项目根目录执行：

```powershell
python tools/prepare_demo.py
docker compose up --build -d --wait
docker compose exec api python -m app.seed
```

1. 准备脚本创建被忽略的 `.env`，生成随机本地数据库密码与演示账号密码，并下载题目提供的 Push-T 视频（约 7 MB）到 `storage/videos/pusht-demo.mp4`；已有配置和完整视频会保留。
2. Compose 启动 PostgreSQL、执行数据库迁移、启动 API 和前端；API 镜像内含 ffprobe，演示导入时读取实际视频时长。
3. 演示导入命令可重复执行，不覆盖已有账号密码和任务状态；不在应用启动时自动导入。

首次准备视频需访问 Hugging Face，首次构建需下载镜像与依赖。视频不随 Git 仓库分发；若自动下载失败，可从 [Push-T 原始视频](https://huggingface.co/datasets/lerobot/pusht/resolve/main/videos/observation.image/chunk-000/file-000.mp4) 手动下载，保存为 `storage/videos/pusht-demo.mp4` 后重跑准备脚本。视频须完整，不能用网页文件代替 MP4。

打开 [工作区](http://localhost:8080)，使用以下账号；初次密码为本地 `.env` 中的 `APP_DEMO_PASSWORD`，不打印到日志、不提交到 Git。

| 账号 | 身份 | 数据范围 |
| --- | --- | --- |
| `admin` | 平台管理员 | 两个租户的全部 7 个任务 |
| `a1` | 租户 A 标注员 | 3 个待领取任务和本人 1 个进行中任务 |
| `a2` | 租户 A 标注员 | 3 个待领取任务和本人 1 个进行中任务 |
| `b1` | 租户 B 标注员 | 1 个待领取任务和本人 1 个进行中任务 |

上表数量为首次导入且尚未领取 / 发布新任务时的基线，实际操作后会变化。重复导入不会重置状态。

四个演示账号初次使用同一个随机生成的密码。不要直接使用 `.env.example` 中的占位密码，也不要将真实 `.env` 上传到 GitHub。

接口文档：[API docs](http://localhost:8000/docs)。端口：前端 8080、API 8000、数据库 55433，默认仅绑定本机。`/api/health` 检查进程，`/api/ready` 检查数据库、任务版本字段及片段表。

查看状态和日志：

```powershell
docker compose ps
docker compose logs --tail 100 api
```

停止服务并保留数据：

```powershell
docker compose down
```

数据库保存在命名卷中，视频在本地 `storage/videos/`；不要通过删除数据库卷来解决迁移错误。

数据库使用 `pgvector/pgvector:0.8.0-pg17`（PostgreSQL 17），本项目不启用向量扩展。容器和数据卷由本项目独立管理，宿主端口默认 55433。已有镜像时可以用 `docker compose up -d db --pull never --wait` 启动数据库，确保不重新下载。

## 快速验收

1. 使用 `admin` 登录，进入“发布任务”，选择租户 A，上传演示视频；修改标题后发布，预期生成一条待领取任务。也可选择多个 MP4 验证批量发布。
2. 退出后使用 `a1` 登录，领取刚发布的任务，添加两段互不重叠的片段，例如 `[1, 3)` 秒和 `[5, 8)` 秒。
3. 点击“立即保存”，确认已保存到服务器后刷新页面，预期片段仍在；此时任务仍为草稿，尚不计入统计。
4. 提交任务，预期进入只读状态；个人统计中的已完成任务数增加 1，有效时长增加 5 秒。
5. 退出后使用 `admin` 登录“每日统计”，选择北京时间的提交日期和租户 A 并查询，预期该任务计入 5 秒，展开可追溯两段片段。
6. 退出后使用 `b1` 登录，预期无法在列表中看到刚发布的租户 A 任务。

完整权限、并发、跨日与恢复检查见 [用户验收清单](references/acceptance.md)。同一轮操作保持使用相同地址，`localhost` 与 `127.0.0.1` 的 Cookie、主题和本机草稿存储彼此独立。

## 本地开发方式

需要 Node.js 24、Python 3.12 和可运行的 PostgreSQL。建议数据库仍通过 Compose 启动，本地运行前后端。

以下虚拟环境命令以 Windows PowerShell 为例；Linux / macOS 将 `src/backend/.venv/Scripts/python.exe` 换成 `src/backend/.venv/bin/python`，在后端目录内将 `.venv/Scripts/python.exe` 换成 `.venv/bin/python`。后端执行演示导入前需要安装 ffprobe 或配置其路径，见下文。

项目根目录：

```powershell
python tools/prepare_demo.py
docker compose up -d db --wait
python -m venv src/backend/.venv
src/backend/.venv/Scripts/python.exe -m pip install -r src/backend/requirements.lock
```

后端终端，从 `src/backend/` 执行：

```powershell
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m app.seed
.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

本地导入演示数据还需要 ffprobe 在 PATH 中；也可先用 Compose 完成迁移和导入，再停止容器中的 web / api，仅运行本地前后端。自定义 ffprobe 路径可在 `.env` 设置 `APP_FFPROBE_BINARY`。

Windows 本机缺少 ffprobe 时，在项目根目录安装到被忽略的目录：

```powershell
npm install --prefix .cache/media-tools --cache .cache/npm --ignore-scripts --no-audit --no-fund --save-exact @ffprobe-installer/win32-x64@5.1.0
```

将 `.cache/media-tools/node_modules/@ffprobe-installer/win32-x64/ffprobe.exe` 的绝对路径写入本地 `.env` 的 `APP_FFPROBE_BINARY`（建议使用正斜杠），再执行迁移和导入。Compose 会使用容器内的 ffprobe，覆盖该本机路径。依赖缓存放在项目 `.cache/`，不提交到 Git。

前端终端，从 `src/frontend/` 执行：

```powershell
npm ci
npm run dev
```

打开 [开发工作区](http://localhost:5173)。Vite 将 `/api` 代理到本机 8000 端口，保持同源 Cookie；不要同时启动占用相同端口的容器 API 和本地 API。

## 数据库升级与接口约定

数据库结构由版本化迁移脚本管理，当前最新版本为 `0002_annotations`。更新已有本地环境时，在 `src/backend/` 执行 `.venv/Scripts/python.exe -m alembic upgrade head`，再重启 API；Compose 启动 API 时会自动执行迁移。迁移保留既有账号、任务和数据卷；安装 PostgreSQL 自带的 `btree_gist` 扩展，用于同任务片段不重叠的排斥约束。迁移创建结构，演示导入命令另行创建测试数据。

上传上限默认为 512 MB，后端可通过 `APP_MAX_UPLOAD_MB` 调整；若修改上限，应同时调整前端提示及 Nginx 限制。发布使用原始 MP4 请求体，标题和租户在查询参数中；写接口都需当前会话和 `X-CSRF-Token`。保存 / 提交携带 `expected_revision` 和完整 `segments`，遇到 409 应先重新载入再确认内容。

## 局部检查与用户验收

UI 更新期间，每次修改执行类型检查、构建、函数测试和受影响页面的交互测试；每页完成后由用户执行真实业务闭环，全部更新完成后才进行完整回归，不在每页完成时自动运行完整交互回归。范围、页面覆盖和执行约定见 [测试说明](references/automation-tests.md)。

从 `src/frontend/` 执行（先按本地开发说明准备依赖、后端虚拟环境和演示视频；默认使用已安装的 Edge）：

```powershell
npm run check:change -- --page=workspace
npm run check:change -- --page=statistics
npm run check:change -- --page=publish
```

每次只选择受影响页面；共享 UI 影响多个页面时使用 `--page=shared`，覆盖工作台、统计、主题、个人统计和发布。可用 `--page=workspace --fragment=frame-shortcuts` 进一步限定交互片段。命令自动执行类型检查、构建、前后端函数测试，并在独立 5183 端口启动 / 关闭测试 Vite；所有 API 模拟，后端测试仅选择局部片段文件，不连接业务 PostgreSQL。日志、执行摘要及失败截图 / trace 保存在 `.cache/checks/`。没有现成交互脚本的页面需记录缺口并由用户核对，不能宣称已覆盖。

`npm run test:functions` 只运行函数测试；`npm run test:ui -- --page=statistics` 只运行指定交互脚本。`npm run check:baseline` 显式执行全部已有局部脚本，用于本次初始基线及全部 UI 完成后的已有脚本复核，不作为每页完成后的默认动作，也不代表真实业务完整回归。

后端局部用例，从项目根目录执行：

```powershell
src/backend/.venv/Scripts/python.exe -m pytest tests/backend/test_annotation_fragments.py
node --test tests/frontend/annotations.test.mjs
```

前端静态检查与构建，从 `src/frontend/` 执行：

```powershell
npm run build
```

时间轴、快捷键、自动保存与恢复的分项步骤见 [验收清单](references/acceptance.md)。完整回归使用 55435 专用临时库并包含日期用例；55434 独立日期入口的复测方式一并见 [测试说明](references/automation-tests.md)。

## 隔离自动化交付检查

以下入口覆盖权限、会话 / CSRF、真实 PostgreSQL 并发 / 回滚 / 约束、上传 / Range、真实浏览器闭环及容器启动冒烟。准备好上述开发依赖、Docker、Edge、演示视频和 ffprobe 后，在项目根目录执行；仅完成 Compose 快速启动并不会安装宿主机测试依赖：

```powershell
src/backend/.venv/Scripts/python.exe tools/run_automation.py integration
src/backend/.venv/Scripts/python.exe tools/run_automation.py e2e
src/backend/.venv/Scripts/python.exe tools/run_automation.py release
src/backend/.venv/Scripts/python.exe tools/run_automation.py compose
```

`release` 执行既有完整局部回归、真实数据库测试和浏览器闭环；`compose` 单独构建并验证 Linux API / Nginx 镜像。使用独立 55435 测试库、5801 测试 API、5184 本地测试站点或 5880 容器站点，自动清理专用服务，不写原验收库。日志、JUnit、逐场景结果和失败截图 / trace 位于 `.cache/automation/`。完整覆盖、隔离边界、运行条件及结果见 [自动化回归说明](references/automation-tests.md)。

镜像构建使用 BuildKit 的 pip / npm 下载缓存。`compose` 分别记录 API 构建、Web 构建和应用启动；每个镜像默认限时 1200 秒，可通过 `--build-timeout 1800` 调整（允许 60–3600 秒）。首次构建仍需访问外部依赖源；缓存不能保证下载源始终可用。

## 文档入口

- [业务与架构](references/architecture.md)
- [测试与验证](references/automation-tests.md)
- [人工验收清单](references/acceptance.md)
- [故障排查](references/troubleshooting.md)
- [提交报告](report.md)

当前按本地开发与笔试演示配置交付，尚未线上部署；公网部署需要配置 HTTPS、Secure Cookie 和允许的浏览器来源。未覆盖多浏览器兼容矩阵、真实设备全屏体验、大规模负载和长期稳定性测试；已知边界见 [提交报告](report.md) 与 [架构约定](references/architecture.md)。

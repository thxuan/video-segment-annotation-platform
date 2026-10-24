# 项目说明

视频片段标注平台，用于多租户任务发布、片段标注与每日有效时长统计。题目来源：https://github.com/phi-software/vibe-coding-challenge 。启动、账号和快速验收见 README.md；用户自行维护 report.md，不自动改写。

第一至五步曾获用户验收认可；最新完整自动化与 Linux 容器回归已通过，最终视觉、真实设备体验和整体交付仍待用户确认。具体结果及限制以 references/automation-tests.md 为准。

## 项目地图

- `src/frontend/`：React / TypeScript / Vite；任务列表、发布、标注工作台、统计及主题。
- `src/backend/`：FastAPI / SQLAlchemy；认证、租户权限、媒体、任务工作流、统计与迁移。
- `tests/backend/`、`tests/integration/`：后端函数、隔离 PostgreSQL / HTTP、权限、并发、事务、媒体和日期测试。
- `tests/frontend/`、`tests/e2e/`：函数 / 模拟 API 页面交互，以及真实隔离浏览器业务闭环。
- `tools/run-checks.mjs`：局部检查和全部已有模拟 UI；`tools/run_automation.py`：integration / e2e / release / compose。
- `tools/prepare_demo.py`：生成被忽略的本地配置并下载演示视频，保留已有文件。
- `README.md`、`compose.yaml`、依赖锁文件：启动、容器和可复现依赖入口。
- `references/architecture.md`：业务规则、权限、模块、状态、接口及实现边界。
- `references/automation-tests.md`：日常测试分工、覆盖、隔离、复跑命令、最新结果和限制。
- `references/acceptance.md`：业务、边界、快捷键、恢复、主题、个人统计与最终人工验收。
- `references/troubleshooting.md`：环境、下载、启动、保存、统计和测试故障处理。

## 开发规则

- 保留用户已有修改，修改前检查当前文件和适用指令；每轮明确目标、范围、完成标准，不擅自扩展需求。
- 区分题目硬性要求、已确认决策和待确认建议；不得把建议写成确定需求。
- 租户及对象权限在后端从可信会话执行，不能信任客户端身份或租户参数。
- 同任务片段不重叠；仅已提交任务计入有效时长，按北京时间提交日归账。核心规则后端验证，状态变化使用事务及并发保护。
- UI 修改后执行类型、构建、函数和受影响页面交互检查；每页完成后用户复验，不默认运行整套回归；全部 UI 完成或用户明确要求时才执行完整回归。
- 真实数据库测试仅使用专用隔离库；禁止写原 55433 验收库。55435 为完整自动化临时库，55434 为保留的独立日期库，详见测试说明。
- 如实说明已检查范围、结果、缺口和用户复验步骤；自动化通过不等于整体正确或用户已验收。未运行、跳过或失败不能写成通过。
- 纯文档 / 目录变更仅检查链接、路径、描述和差异，不编写无意义测试。
- 每个独立且验证通过的改动形成清晰本地 Git 提交，提交前检查差异，仅包含当前任务文件；仅在用户授权时推送，不擅自改写已有历史。
- 架构、依赖、启动或业务决策变化时同步对应文档；测试方法和最新验证记录维护在 references/automation-tests.md，验收操作维护在 references/acceptance.md。
- 开发过程原始记录仅保留在本机忽略的 .cache/document-archive/；旧开发历史另存 .cache/repository-history-backup/ 下的 Git bundle，不重新加入交付文档或公开提交历史。
- 凭据、数据库、下载视频、依赖和构建产物不得提交，锁文件及占位配置例外。不要打印密码或会话令牌。
- 未明确要求时，不引入微服务、消息队列、自动识别模型或额外审批流程。

## 按需阅读

- 修改架构、模型、权限、状态、统计或页面数据流前，阅读 `references/architecture.md`。
- 开发、构建或测试前，阅读 `references/automation-tests.md`；修改页面交互或整理验收时阅读 `references/acceptance.md`。
- 排查环境、启动、视频、数据库或运行错误时，阅读 `references/troubleshooting.md`，按需补充处理办法。
- 只加载当前任务需要的材料；report.md 的编辑需要用户明确请求。

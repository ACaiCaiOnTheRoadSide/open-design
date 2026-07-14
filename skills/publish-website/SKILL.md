---
name: publish-website
description: 将当前会话中生成的 Web 项目发布为线上托管应用。负责环境信息获取、项目类型探测、前端构建（复用 deploy-website 的探测规则）、基于应用内容自动生成元数据、静态资源打包，并通过 multipart 表单 POST 到 showcase API 完成上传。支持纯静态、Node.js 前端、以及容器化后端项目。
arguments:
  - name: workspace
    description: 待发布项目的绝对路径，默认使用当前工作目录
    required: false
---

# 发布应用（Publish Website）

将纯前端项目或带后端的容器化项目发布为线上应用。本 Skill 以严格的流水线方式执行——**不得跳过步骤**，**不得在未完成时声称成功**。

## 流水线总览

1. 获取环境信息（client_id）
2. 探测项目类型并自动判定 kind（static / backend）（复用 `deploy-website` 探测规则；后端覆盖 Node-Express、FastAPI、Django+gunicorn、Spring Boot jar、Go、Rust 等）
3. 根据判定结果分流到 static / backend 子流水线
4. 准备产物：
   - static 分支：必要时构建前端，准备静态产物
   - backend 分支（步骤 3b）：生成 Dockerfile、build、run、healthcheck、save 镜像
5. 基于应用内容自动生成应用名称与描述，再向用户逐项确认；询问应用作者
6. 打包为 `/tmp/dist.zip`（static 分支）或确认 `/tmp/showcase-image.tar.gz`（backend 分支）
7. 确定 `ticket`（首次提交需询问用户是否复用既有应用）
8. 通过 multipart 表单 POST 到 showcase API，缓存返回的 `ticket`，向用户返回 `site_url`

服务端注册与管理员审核发生在 Skill 执行结束**之后**，不属于本 Skill 的职责范围。

### 关于 `ticket`（应用更新密钥）

- `ticket` 是 showcase 服务用来识别"同一个应用"的凭证：首次创建会下发一个 `ticket`，后续若想**更新**该应用而不是新建，需在请求体中带上同一个 `ticket`
- **会话级缓存**：当前会话中**首次**成功创建应用后拿到的 `ticket`，必须缓存于会话上下文（例如记在内存/笔记中），同一会话内后续每次提交都自动使用该 `ticket`，**不得**再向用户询问
- 仅当**本会话从未提交过应用**时，才需要询问用户是不是要复用其他任务中创建的应用（步骤 7a）
- **跨 kind 切换**：同一 `ticket` 可以从 `static` 切换为 `backend`（或反之），服务端会将原应用整体替换为新 kind 并重新进入待审核状态；在用户确认时必须明确告知「将把原应用从 X 切换为 Y，并重新进入待审核状态」

---

## 步骤 1 —— 获取环境信息

执行 `hostname` 命令获取当前主机名，作为后续上传请求中的 `client_id`：

```bash
hostname
```

将输出的字符串原样记录为 `client_id`。**不得**自行编造或使用其他值；若命令失败，终止并向用户报告。

---

## 步骤 2 —— 自动判定 kind（static / backend）

由 Skill **基于工作目录扫描**，自动判定本次发布的 kind：

判定规则（按优先级）：

1. 工作目录中存在以下任一**后端特征**之一 → 判定为 `backend`：
   - `requirements.txt` / `pyproject.toml` 含 `fastapi` / `uvicorn` / `django` / `flask` / `gunicorn`
   - `manage.py`
   - 顶层 `pom.xml` / `build.gradle`（Spring Boot 等 JVM 项目）
   - `go.mod`
   - `Cargo.toml`（且非纯 wasm 前端）
   - `composer.json`（PHP）
   - `Gemfile` 含 `rails` / `sinatra`
   - `package.json` 中出现 `express` / `fastify` / `koa` / `hapi` / `nest` 等后端框架依赖
2. 仅有 `index.html` / 静态 HTML 文件 → 判定为 `static`
3. 存在 `package.json` 且无后端框架依赖（Vite / CRA / Next 静态导出 / Vue / Astro / Nuxt SSG 等纯前端项目） → 判定为 `static`
4. 探测不出来 → 询问用户「按纯前端发布」还是「按容器化后端发布」，**仅此一次**作为兜底

判定完成后分流：

- `static` → **static 子流水线**（步骤 3 → 4 → 5 → 6 → 7 → 8）
- `backend` → **backend 子流水线**（步骤 3 → 3b → 5 → 7 → 8；步骤 4/6 由 3b 取代）

### 进入 backend 分支前必须告知用户（硬约束）

只告诉用户 **与线上运行阶段相关** 的注意事项，不暴露任何 镜像 build 阶段细节（Dockerfile 怎么写、是否用 supervisord、依赖如何下载等都是 Skill 自己处理的事，与用户无关）。

判定为 `backend` 后，**进入步骤 3b 之前** 必须在对话中明确告知以下平台限制：

> **⚠ 即将以容器方式，将本应用发布到 [MonkeyCode-AI 用户作品集](https://showcase.monkeycode-ai.online/)。线上运行时有以下四条限制，请确认是否继续发布：**
> 
> 1. **单容器**：平台只调度一个容器。如果应用依赖数据库、对象存储、缓存、队列等组件，会与业务一起塞在同一个容器里运行，不支持外部独立服务。
> 2. **无外部网络**：容器无法访问公网与任何外部服务。远程数据库、S3、第三方 API、OAuth / 支付 / 微信、CDN、外部 LLM 等都不可达。业务在线上启动后，只能被外部访问，不应也不能访问互联网。
> 3. **无持久化存储**：服务更新、异常重启或被运维重建容器时，文件系统会被重置，所有运行时写入（SQLite、用户上传、日志、缓存等）都会丢失。
> 4. **公开可见**：应用发布后会在 用户作品集 (showcase.monkeycode-ai.online) 列表公开可见，所有人都可以访问到你发布的应用。

然后用 `question` 工具，要求用户确认，选项为「继续发布」/「取消」。

- 用户选「继续发布」 → 进入步骤 3b
- 用户选「取消」 → 终止本次发布

---

## 步骤 3 —— 探测项目类型

复用 `deploy-website` 中的探测逻辑。根据步骤 2 的自动判定结果分流：

### static 分支（kind=static）

| 探测结果 | 走向 |
|---|---|
| 存在 `package.json`（Node 项目） | → **Node 构建分支**（步骤 4 分支 B/C） |
| 仅有 `index.html` / 静态 HTML 文件 | → **静态分支**（步骤 4 分支 A） |

#### 包管理器探测（仅 Node 项目）

优先级顺序：
1. `pnpm-lock.yaml` → `pnpm`
2. `yarn.lock` → `yarn`
3. `package-lock.json` → `npm`
4. 都没有 → 默认 `npm`

#### 构建命令解析（仅 Node 项目）

按优先级：
1. `package.json` 的 `scripts.build` → `<pkgMgr> run build`
2. 已知框架默认产物目录——Vite/CRA/Astro → `dist`，Next.js 静态导出 → `out`，react-scripts → `build`
3. README 兜底：扫描 `README*` 中包含关键字 `build` / `compile` / `dist` 的命令并提取
4. 以上都失败 → **询问用户**指定构建命令，不要猜测

#### 预期产物目录

记录预期的输出目录（`dist` / `out` / `build`），供步骤 4 使用。

### backend 分支（kind=backend）

探测项目语言/框架，至少覆盖以下场景：

| 探测特征 | 推断类型 |
|---|---|
| `package.json` 中出现 `express` / `fastify` / `koa` / `hapi` | Node-Express 系 |
| `requirements.txt` / `pyproject.toml` 中含 `fastapi` / `uvicorn` | FastAPI |
| `manage.py` + `requirements.txt` 含 `django` + `gunicorn` | Django + gunicorn |
| 顶层 `pom.xml` / `build.gradle` 且产物为 `*.jar`（Spring Boot） | Spring Boot jar |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| 其他 | 询问用户基础镜像与启动命令，不要猜测 |

记录推断结果，供步骤 3b 生成 Dockerfile 使用。

---

## 步骤 3b —— backend 子流水线

> 仅当步骤 2 自动判定为 `backend` 且用户在告知运行时四条限制后选择「继续发布」时执行。完成后跳过步骤 4/6 直接进入步骤 5、7、8。

### 3b.0 平台限制（生成 Dockerfile 前必须遵守）

showcase 平台对 backend 容器有四条硬约束，必须同时满足，否则镜像无法正常运行。

#### A. 单容器 + 进程编排（按需 supervisord）

- 平台只调度**一个容器**，不支持 docker-compose / k8s pod / sidecar
- 进程编排策略**按附加组件需求二选一**（Skill 在 3b.1 自行判定）：
  - **单进程方案（默认）**：业务本身无 DB / 对象存储 / 缓存 / 队列等附加依赖，是一个无状态后端进程 → **直接 `ENTRYPOINT` / `CMD` 拉起业务进程**，不要引入 supervisord
  - **多进程方案**：业务依赖 DB / 对象存储 / 缓存 / 队列等附加组件 → 这些组件**全部打入同一镜像**，由 **supervisord** 与业务进程一起拉起、守护、按 `priority` 排序
- 多进程方案下附加组件的本地化：
  - 关系型 DB（PostgreSQL / MySQL / MariaDB）→ 整体打入镜像，初始 schema 在 builder stage 灌进数据目录
  - 对象存储（MinIO / SeaweedFS）→ 整体打入镜像，bucket 在容器启动脚本里初始化
  - Redis / Memcached / Elasticsearch / RabbitMQ 等 → 同理，全部本地拉起
- 业务代码连接附加组件时**必须走 `127.0.0.1` / `localhost` / Unix socket**，不得使用外部 host 名或外部 endpoint

#### B. 容器无外部网络（运行时离线）

容器运行时**完全切断公网与外网访问**：

- 出站 DNS、TCP、UDP 均不可达；远程 DB、远程 S3、远程 Redis、第三方 API、OAuth IdP、CDN、`pip` / `npm` / `apt` 等**全部不可用**
- 镜像必须做到**完全自包含**：所有运行时需要的资源在 **builder stage 提前下载并 COPY 进 runtime stage**，包括但不限于：
  - 业务依赖包（已经在 builder 装好，runtime 直接拷 venv / node_modules / target/release / vendor）
  - 模型权重、embedding 文件、tokenizer
  - 字体、字典、地理库、本地化资源
  - DB 初始 schema（`*.sql`）与种子数据
  - 静态前端产物（如果是前后端一体镜像）
  - HTTPS 根证书（如果业务以前是直连公网 CA 校验，现在改为只信任内部证书或干脆走内网 HTTP）
- 对外暴露：**仅 `service_port` 一个端口**，由平台反向代理对外提供 HTTP 服务

#### C. 容器无持久化存储

- 服务更新发布、容器异常崩溃、运维侧重启都会**重建容器**（旧实例销毁、新实例从镜像启动）
- 不挂载任何 volume / bind mount，对文件系统的所有写入在重建时丢失
- 容器内打包的 DB / 对象存储**也会一并清零**——重启后必须由 supervisord 启动脚本重新执行初始化 schema + 种子数据

Dockerfile **不得** `VOLUME` 声明数据目录（声明无效，反而误导用户）。

如果项目**强依赖**外部持久层或外部 API（如必须连真实的微信 / 支付 / 外部 LLM），需再次告知用户「相关功能部署后可能无法正常使用」，用户认同后才能继续构建和发布。

#### D. 资源上限

- CPU：1 核
- 内存：1 GiB（含 swap）
- 镜像 tar.gz：≤ 500 MB

打包 DB、对象存储、模型等附加组件时务必尽可能按此上限裁剪。

### 3b.1 生成 Dockerfile

AI 基于步骤 3 的探测结果生成**多阶段 alpine** `Dockerfile`，写入 `/tmp/Dockerfile`，该 Dockerfile 专门用于构建被发布到 showcase 上的容器镜像。**不得**把这个 Dockerfile 写到用户工作目录。

硬性写法约束：

- 最终（runtime）stage 必须基于 alpine 或 alpine 风味的语言镜像（如 `eclipse-temurin:21-alpine-jdk`）
- runtime stage **原则上禁止** `apt-get` / `dnf` / `yum`，如果必须安装软件包，在安装完后必须执行清理操作（如 `apt clean`）
- **禁止** `ADD <url>` —— 所有外部资源在 builder stage 用 `RUN curl/wget` 显式落盘
- 必须多阶段；runtime stage 只 `COPY --from=builder` 编译产物 / 运行时依赖（含模型权重、字体、初始化 SQL、根证书等运行时资源），不得在 runtime 跑任何联网命令
- 进程编排策略按 3b.0 §A 自动选择：单进程方案 `CMD ["业务命令", ...]`；多进程方案 `CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf","-n"]`（配置见 3b.1.a）
- `CMD` 必须为 exec 形式（JSON 数组）
- 必须 `EXPOSE <service_port>`，且与 multipart 字段 `service_port` 一致；附加组件端口（DB / Redis / MinIO 等）只走 127.0.0.1，**不得 EXPOSE**
- **所有 `FROM` 引用的 Docker Hub 镜像必须加 `registry.monkeycode-ai.online/` 代理前缀**：
  - 无 namespace 的官方镜像（`alpine` / `node` / `python` / `golang` / `nginx` / `rust` / `caddy` 等）必须插入 `library/`：`FROM registry.monkeycode-ai.online/library/alpine:3.20`
  - 已有 namespace 的镜像（如 `eclipse-temurin/...`）**不要**再插 `library/`：`FROM registry.monkeycode-ai.online/eclipse-temurin:21-alpine-jdk`
  - `FROM scratch` **不走**代理，保留原样
  - 该前缀只在生成 Dockerfile 时注入；showcase 服务端 load 镜像后引用本地 image id，不再受代理影响

#### 3b.1.a supervisord 配置（仅多进程方案）

> 仅当业务有附加组件依赖（DB / 对象存储 / 缓存 / 队列等）时启用本节；单进程方案跳过本节，直接在 runtime stage 写 `CMD ["业务命令", ...]` 即可。

runtime stage 必须安装 supervisord 并提供配置文件：

```dockerfile
# runtime stage 内
RUN apk add --no-cache supervisor
COPY supervisord.conf /etc/supervisord.conf
COPY --from=builder /app /app
EXPOSE <service_port>
CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf","-n"]
```

`supervisord.conf` 最小模板（按项目实际附加组件增删 `[program:*]` 段，并用 `priority` 控制启动顺序，数字越小越早启动）：

```ini
[supervisord]
nodaemon=true
user=root
logfile=/dev/stdout
logfile_maxbytes=0
pidfile=/run/supervisord.pid

[program:postgres]
priority=10
command=/usr/local/bin/docker-entrypoint.sh postgres
user=postgres
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:app]
priority=50
command=/app/start.sh
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

`/app/start.sh` 中业务进程启动前要做：

1. 等待附加组件就绪（`pg_isready` / `redis-cli ping` / 探活脚本，最长等 30s）
2. 幂等地灌入初始 schema 与种子数据（从 builder 阶段烤进镜像的 `*.sql`）
3. 再 `exec` 业务进程（保留 PID 1 子进程语义，方便 supervisord 回收）

> supervisord 配置文件 `supervisord.conf` 和启动脚本 `start.sh` 由 Skill **生成到 `/tmp/`** 后 `COPY` 进镜像，**不得**写入用户工作目录。

#### 3b.1.b 附加组件打包指引（仅多进程方案）

| 组件 | 推荐做法 |
|---|---|
| PostgreSQL | builder stage 装好 `postgresql` + 初始化 `initdb`；runtime stage 用 `apk add postgresql`；supervisord 启动 `postgres -D /var/lib/postgresql/data`；schema 从 builder COPY，启动脚本里 `psql -f` 灌入 |
| MySQL/MariaDB | runtime stage `apk add mariadb mariadb-client`；`mysql_install_db --user=mysql` 在 builder 完成；supervisord 启动 `mysqld --user=mysql` |
| Redis | runtime stage `apk add redis`；supervisord 启动 `redis-server --bind 127.0.0.1 --save ""`（关闭持久化或写到容器内临时目录） |
| MinIO | builder stage `wget` 拉 minio 二进制；runtime COPY；supervisord 启动 `minio server /data --address 127.0.0.1:9000`；bucket 在启动脚本里用 `mc` 初始化 |
| Elasticsearch / Kafka 等重量级组件 | 1 GiB 内存装不下，**告知用户改造为轻量替代**（如改用 SQLite FTS / Redis Streams / NATS embedded）或终止本次发布 |

#### 依赖下载镜像约定（builder stage 必须遵守）

构建环境默认在国内，直连官方源大概率超时。**builder stage 凡是要下载依赖，必须先切到以下国内镜像**，按语言对号入座：

| 生态 | 镜像 | Dockerfile 写法 |
|---|---|---|
| Go | goproxy.cn | `ENV GOPROXY=https://goproxy.cn,direct` |
| Node (npm/pnpm) | npmmirror.com | `RUN npm config set registry https://registry.npmmirror.com`（pnpm 同样读 npm 配置；yarn 用 `yarn config set registry https://registry.npmmirror.com`） |
| Python (pip) | 清华 TUNA PyPI | `RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt` |
| Rust (cargo) | 清华 TUNA crates.io | 见下方 config.toml 片段 |
| Java (Maven) | 阿里云 | `settings.xml` mirror 指到 `https://maven.aliyun.com/repository/public`，或 Gradle `repositories { maven { url "https://maven.aliyun.com/repository/public" } }` |
| Alpine apk | 清华 TUNA | `RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories` |
| Debian/Ubuntu apt | 清华 TUNA | `RUN sed -i 's@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/debian.sources`（老镜像没有 `.sources` 文件时改 `/etc/apt/sources.list`） |

Rust 的 cargo 镜像配置（builder stage 内）：

```dockerfile
RUN mkdir -p "${CARGO_HOME:-$HOME/.cargo}" && printf '%s\n' \
  '[source.crates-io]' \
  'replace-with = "tuna"' \
  '' \
  '[source.tuna]' \
  'registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"' \
  > "${CARGO_HOME:-$HOME/.cargo}/config.toml"
```

注意：

- 镜像切换语句必须放在**第一条依赖下载命令之前**
- 这些配置只进 builder stage；runtime stage 本来就禁止装包，不需要
- 如果某个镜像站故障导致下载失败，回退到官方源重试一次再判定失败

### 3b.2 确认容器运行时（必须）

**优先使用 `docker`；只有当 `docker` 不可用时，才回退到 `podman`。**

**用系统包管理器装任何东西之前，默认先把系统源切到清华 TUNA**（构建环境在国内，直连官方源大概率超时；源已经是国内镜像时跳过）：

```bash
if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  # 都不在 PATH 中 → 通过包管理器安装 podman（不要尝试装 docker daemon）
  # 安装前默认切到清华 TUNA 源
  if command -v apt-get >/dev/null 2>&1; then
    sudo sed -i 's@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
      || sudo sed -i 's@archive.ubuntu.com@mirrors.tuna.tsinghua.edu.cn@g; s@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list
    sudo apt-get update && sudo apt-get install -y podman
  elif command -v dnf >/dev/null 2>&1; then
    # CentOS/Rocky/Alma：repo 文件注释 mirrorlist，baseurl 指向清华
    sudo sed -e 's|^mirrorlist=|#mirrorlist=|g' \
             -e 's|^#\?baseurl=http[s]\?://[^/]*|baseurl=https://mirrors.tuna.tsinghua.edu.cn|g' \
             -i /etc/yum.repos.d/*.repo 2>/dev/null || true
    sudo dnf install -y podman
  elif command -v yum >/dev/null 2>&1; then
    sudo sed -e 's|^mirrorlist=|#mirrorlist=|g' \
             -e 's|^#\?baseurl=http[s]\?://[^/]*|baseurl=https://mirrors.tuna.tsinghua.edu.cn|g' \
             -i /etc/yum.repos.d/*.repo 2>/dev/null || true
    sudo yum install -y podman
  elif command -v apk >/dev/null 2>&1; then
    sudo sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories
    sudo apk add --no-cache podman
  elif command -v pacman >/dev/null 2>&1; then
    echo 'Server = https://mirrors.tuna.tsinghua.edu.cn/archlinux/$repo/os/$arch' | sudo tee /etc/pacman.d/mirrorlist >/dev/null
    sudo pacman -Sy --noconfirm podman
  elif command -v brew >/dev/null 2>&1; then
    brew install podman && podman machine init && podman machine start
  else
    echo "无可用的包管理器，无法安装容器运行时" >&2
    exit 1
  fi
  RUNTIME=podman
fi
echo "using container runtime: $RUNTIME"
```

后续步骤一律使用 `"$RUNTIME"` 代替字面 `docker`，因 docker / podman CLI 在 build / run / save 路径上参数兼容（podman 是 rootless，第一次跑可能需要 `podman system migrate` 一次，遇到再处理）。

### 3b.3 本地 build

build 阶段**必须**使用 `--network host`，让 builder stage 拉取依赖时直接复用宿主网络（国内镜像源、apt/apk 源等）：

```bash
TAG="showcase-publish-$(openssl rand -hex 4):tmp"
"$RUNTIME" build --network host -t "$TAG" -f /tmp/Dockerfile .
```

build 失败时：打印 stderr 末段（最多 200 行），**立即终止**，**不得**继续上传。

### 3b.4 本地 run + healthcheck

选择一个未占用的 host 端口（脚本探测，不要硬编码）；`$SVC` 为生成 Dockerfile 时确定的容器内业务端口（service_port）。

本地 healthcheck 阶段**不指定** `--network`，使用容器运行时的默认网络（docker 默认 `bridge`，podman 默认 `slirp4netns` / `pasta`）即可，便于宿主 `curl 127.0.0.1:$HOST` 直接打通端口映射。离线自检由 Skill 在 3b.1 通过 Dockerfile 写法约束保证，不依赖运行时网络隔离：

```bash
"$RUNTIME" run -d --rm \
  --cpus=1 --memory=1g --memory-swap=1g \
  -p $HOST:$SVC \
  --name "${TAG%:*}-run" \
  "$TAG"
```

**禁止** `--privileged`、`--network host`、`build context 之外的 bind mount`。

由于镜像内可能要先拉起 DB / 对象存储再启业务，**healthcheck 总时长放宽到 90s**，每 3s 探测一次：

```bash
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$HOST<healthcheck_path>" || echo 000)
  case "$code" in
    200|204|302|401) ok=1; break;;
  esac
  sleep 3
done
```

AI 根据应用类型选择 healthcheck path（如 `/`、`/healthz`、`/api/health`）与可接受状态码集合（默认 `{200,204,302,401}`）。

任一失败（容器启动失败 / healthcheck 90s 内未命中可接受状态码）：

1. 打印 `"$RUNTIME" logs <container>` 末段（≤200 行）；如能拿到 supervisord 的子进程日志一并打印
2. `"$RUNTIME" stop <container>` + `"$RUNTIME" rmi $TAG` + 清理 `/tmp/Dockerfile`；若走多进程方案再清理 `/tmp/supervisord.conf`、`/tmp/start.sh`（不存在则跳过）
3. **立即终止**，**不得**继续上传

### 3b.5 导出镜像

healthcheck 通过后：

```bash
"$RUNTIME" stop "${TAG%:*}-run"
# 服务端走 Docker daemon 加载，必须输出 docker-archive 格式；
# docker save 默认即此格式，podman save 必须显式指定 --format docker-archive。
if [ "$RUNTIME" = "podman" ]; then
  "$RUNTIME" save --format docker-archive "$TAG" | gzip -1 > /tmp/showcase-image.tar.gz
else
  "$RUNTIME" save "$TAG" | gzip -1 > /tmp/showcase-image.tar.gz
fi
```

**强制自检**：

```bash
size=$(stat -c%s /tmp/showcase-image.tar.gz)
test "$size" -le $((500*1024*1024)) || { echo "镜像超过 500MB"; exit 1; }
```

超过 500MB → 终止并提示用户精简产物（多阶段编译 + alpine + 仅拷贝必要文件）。

### 3b.6 准备 multipart 字段

记录后续步骤 8 需要的字段：

- `kind=backend`
- `site_image=@/tmp/showcase-image.tar.gz`
- `service_port=<容器内业务端口>`
- `healthcheck_path=<3b.4 中使用的 path>`

> 后端分支**不**生成 `/tmp/dist.zip`、**不**携带 `site_zip_file`。

### 3b.7 收尾（仅在步骤 8 成功 / 失败后均需执行）

```bash
"$RUNTIME" rmi "$TAG" 2>/dev/null || true
rm -f /tmp/Dockerfile
rm -f /tmp/supervisord.conf  # 单进程方案下不存在，rm -f 无影响
rm -f /tmp/start.sh           # 单进程方案下不存在，rm -f 无影响
rm -f /tmp/showcase-image.tar.gz
```

---

## 步骤 4 —— 准备静态产物（仅 static 分支）

> backend 分支跳过本节，直接进入步骤 5。

目标：得到一个**顶层直接包含 `index.html`** 的目录（记为 `<artifact_dir>`）。

打包前先清理旧产物：

```bash
rm -f /tmp/dist.zip
```

### 分支 A —— 纯静态 HTML 项目
直接使用项目根目录作为 `<artifact_dir>`。

### 分支 B —— 已有 dist 的 Node 项目
若预期产物目录存在且**包含 `index.html`**，则将其作为 `<artifact_dir>`。

### 分支 C —— 无 dist 的 Node 项目（需构建）

1. 若 `node_modules` 不存在，执行 `<pkgMgr> install`。**install 前先把 registry 切到 npmmirror**（npm/pnpm：`npm config set registry https://registry.npmmirror.com`；yarn：`yarn config set registry https://registry.npmmirror.com`），直连 registry.npmjs.org 在国内大概率超时。失败时输出 stderr 尾部并**终止**。
2. 执行解析出的构建命令。失败时输出 stderr 尾部并**终止**，不得盲目重试。
3. 定位 `index.html`：
   - 先在预期产物目录内查找
   - 找不到则兜底：`find . -maxdepth 3 -name index.html -not -path './node_modules/*'`
   - 多个候选时取**路径最短**者
   - 仍未找到 → 终止并报告 `构建完成但未找到 index.html`

---

## 步骤 5 —— 生成并确认应用元数据

**先自动生成，再逐项询问用户**。每个字段单独发起一次 `question` 工具调用，**不得**把多个字段合并到一个问题里。

### 5a. 基于应用内容自动生成 `site_name` 与 `site_description`

- **static 分支**：从 `<artifact_dir>/index.html` 的 `<title>` / `<meta name="description">` / `<h1>` / 首屏正文综合生成；Node 项目可参考根 `package.json` 的 `name` 与 `description`
- **backend 分支**：从项目根 `package.json` / `pyproject.toml` / `pom.xml` / `Cargo.toml` / `go.mod` 中的 name + description 综合生成；若有 README，提取首段简介

输出：
- 自动生成的 `site_name`（一句话短标题，<= 30 字）
- 自动生成的 `site_description`（一句话简介，<= 80 字）

> 若无可解析内容，则在后续询问中**不要给出"满意"选项的默认值**，让用户必须自行输入。

### 5b. 询问应用名称（`question` 工具，独立一次调用）

```
question: 自动识别到的应用名称为「<生成的 site_name>」，是否使用？
header: 应用名称
options:
  - 满意，就用这个
```

- 用户选 **满意，就用这个** → 采用自动生成的值
- 用户走 **Other** 自行输入 → 采用其输入

### 5c. 询问应用描述（`question` 工具，独立一次调用）

```
question: 自动识别到的应用描述为「<生成的 site_description>」，是否使用？
header: 应用描述
options:
  - 满意，就用这个
```

- 处理逻辑同 5b。

### 5d. 询问应用作者（`question` 工具，独立一次调用）

```
question: 请输入应用作者的 ID（可在下方选项中选择或自行输入）
header: 应用作者
options:
  - 匿名作者
```

- 用户选 **匿名作者** → `site_author = "anonymous"`
- 用户走 **Other** 自行输入 → 采用其输入

---

## 步骤 6 —— 打包（仅 static 分支）

> backend 分支跳过本节；产物已在 3b.4 准备完毕。

必须先 `cd` 进入 `<artifact_dir>` 再打包，确保 zip 内没有包裹目录；同时**排除开发相关文件**：

```bash
cd <artifact_dir> && zip -r /tmp/dist.zip . \
  -x ".git/*" \
  -x ".git" \
  -x "node_modules/*" \
  -x "node_modules" \
  -x "src/*" \
  -x ".env*" \
  -x "*.log" \
  -x ".DS_Store" \
  -x ".vscode/*" \
  -x ".idea/*" \
  -x "package.json" \
  -x "package-lock.json" \
  -x "pnpm-lock.yaml" \
  -x "yarn.lock" \
  -x "tsconfig*.json" \
  -x "*.ts" \
  -x "*.tsx" \
  -x "vite.config.*" \
  -x "webpack.config.*" \
  -x "next.config.*"
```

> **说明**：
> - 对于**分支 B/C**（产物目录在 `dist`/`out`/`build` 内），目录本身已是构建后的静态资源，大多数排除项不会命中，但保留排除规则作为防御性兜底
> - 对于**分支 A**（产物目录就是项目根），上述排除项可有效避免把源码、依赖、版本控制目录、配置文件打入包
> - 如果 `<artifact_dir>` 中确有需要的 `.ts`/`.tsx` 资源（极少见），需调整排除项；否则保持上述默认

**强制自检**：

```bash
unzip -l /tmp/dist.zip | head -30
```

必须满足：
- `index.html` 位于**顶层**（无任何路径前缀）
- 输出中**不应**出现 `.git/`、`node_modules/`、`src/`、`package.json` 等开发文件

任一不满足则立即终止——**不得**上传不合规的包。

---

## 步骤 7 —— 确定 `ticket` (即 **密钥**)

判断当前会话是否已有缓存的密钥 (ticket)：

- **已有缓存的密钥**（即本会话此前已成功提交过应用） → 直接复用，**跳过 7a**，进入步骤 8
- **没有缓存的密钥**（本会话首次提交） → 进入 7a 询问用户

### 7a. 询问是否复用既有应用（首次提交时执行一次）

使用 `question` 工具，**只提供一个显式备选项**；剩下的 Other 输入框本身就代表"有，输入密钥更新已有应用"——其 placeholder 即为该文案：

```
question: 之前在其他任务中提交过本应用吗？是需要更新已有应用，还是提交新应用？如果需要更新，请选择【其他】并填入之前任务提供的密钥。
header: 是否更新现有应用？
options:
  - 没有，提交新应用
  # Other: 输入框的 placeholder/语义为"有，输入密钥即可更新现有应用"，用户在此处直接填密钥
```

- 用户选择 **没有，提交新应用** → 密钥留空（不携带 `ticket` 字段）
- 用户在 **Other** 输入框中填入密钥 → 取用户输入的字符串作为 `ticket`
- 若用户输入的内容为空字符串或纯空格 → 视为未提供，按"提交新应用"处理

> **跨 kind 提示**：若用户提供了 ticket 且本次 kind 与他记忆中的原应用 kind 不一致（无法在 client 侧自动判定，按用户口述），必须在提交前提示「将把原应用从 X 切换为 Y，并重新进入待审核状态」并取得确认；服务端会在切换时整体替换原应用。

---

## 步骤 8 —— 发布

通过 multipart 表单 POST 一次性提交所有字段与产物到 showcase API。

### 8a. 调用 API

**static 分支**（不带 ticket / 带 ticket 二选一）：

```bash
curl -f -X POST \
  -F "client_id=<client_id>" \
  -F "kind=static" \
  -F "site_name=<应用名称>" \
  -F "site_author=<应用作者>" \
  -F "site_description=<应用描述>" \
  [ -F "ticket=<ticket>" ] \
  -F "site_zip_file=@/tmp/dist.zip" \
  https://ugc-submit.showcase.monkeycode-ai.online/v1/create
```

**backend 分支**：

```bash
curl -f -X POST \
  -F "client_id=<client_id>" \
  -F "kind=backend" \
  -F "site_name=<应用名称>" \
  -F "site_author=<应用作者>" \
  -F "site_description=<应用描述>" \
  [ -F "ticket=<ticket>" ] \
  -F "site_image=@/tmp/showcase-image.tar.gz" \
  -F "service_port=<容器内业务端口>" \
  -F "healthcheck_path=<healthcheck path>" \
  https://ugc-submit.showcase.monkeycode-ai.online/v1/create
```

字段说明：

| 字段 | static | backend | 来源 |
|---|---|---|---|
| `client_id` | 必填 | 必填 | 步骤 1 中 `hostname` 命令的输出 |
| `kind` | 必填（`static`） | 必填（`backend`） | 步骤 2 的自动判定结果 |
| `site_name` | 必填 | 必填 | 步骤 5b |
| `site_author` | 必填 | 必填 | 步骤 5d |
| `site_description` | 必填 | 必填 | 步骤 5c |
| `site_zip_file` | 必填 | 不得出现 | 步骤 6 |
| `site_image` | 不得出现 | 必填 | 步骤 3b.4 |
| `service_port` | 不得出现 | 必填 | 步骤 3b |
| `healthcheck_path` | 不得出现 | 选填（默认 `/`） | 步骤 3b.3 |
| `ticket` | 选填 | 选填 | 步骤 7 |

要点：

- `-f` 让 HTTP 非 2xx 状态返回非零退出码
- 失败最多**重试 1 次**（应对网络抖动）
- 所有字段都需经过 shell 转义
- **不得**额外传入 `user_id` / `task_id` 等字段
- **不得**混用 kind 与产物字段（如 `kind=static` 同时携带 `site_image`）

### 8b. 解析响应

服务端响应结构：

```json
{
  "status": 200,
  "data": {
    "message": "success or error detail",
    "site_url": "https://xxxxx.showcase.monkeycode-ai.online",
    "ticket": "<会话内复用此 ticket>"
  }
}
```

处理规则：
- `status` 为 2xx 且 `data.site_url` 非空 → 视为成功，提取 `site_url`
- **若 `data.ticket` 非空**：将其**缓存到当前会话上下文**，本会话后续每次提交都自动使用该 `ticket`，不得再次询问用户
- **若 `data.ticket` 与请求中携带的 `ticket` 不一致**：必须在最终反馈中**明确告知用户新的 `ticket` 值**
- 其他情况 → 视为失败，将 `data.message` 作为错误原因向用户报告，**不得**伪装成功

### 8c. 向用户反馈

成功时（`site_url` 必须**单独一行**作为可点击链接渲染，**不得**包在代码块里；**不得**提示绑定微信或公众号）：

```
应用已提交发布，预览地址：

<site_url>

应用上线前需经过管理员审核。如果想了解审核状态，可在这里询问，我会查询并告诉你。
```

**若服务端返回的 `data.ticket` 与请求中携带的 `ticket` 不同**：

```
应用已提交发布，预览地址：

<site_url>

本应用的更新凭证 ticket 为：`<new_ticket>`
后续如需继续更新本应用，请在新会话中向我提供此 ticket。

应用上线前需经过管理员审核。如果想了解审核状态，可在这里询问，我会查询并告诉你。
```

失败时报告 HTTP 状态码与 `data.message`，**不得**编造应用地址。

---

## 查询审核状态（用户主动询问时执行）

用户在本会话内询问审核 / 上线 / 拒绝原因 / 下线原因等问题时，调用：

```
GET https://ugc-submit.showcase.monkeycode-ai.online/v1/status?client_id=<client_id>&ticket=<ticket>
```

- `client_id`：步骤 1 `hostname` 拿到的值；**必须**与提交时一致
- `ticket`：会话内已缓存的 `ticket`

服务端用 `ticket` 找 site，再校验 `client_id` 与该 site 匹配；两者其中之一对不上即返回 404 `site_not_found`。

### 响应字段

成功时返回 `{ code: 0, data: {...} }`，`data` 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `slug` | string | 应用 slug |
| `status` | string | `pending_review` / `online` / `offline` / `rejected` |
| `kind` | string | `static` / `backend` |
| `block_resubmit` | bool | 当为 `true` 时同 `client_id` 已被禁止再次提交，再调 `/v1/create` 会得到 403 `resubmit_blocked` |
| `takedown_reason` | string（可选） | 管理员在拒绝 / 下线时填写的原因；`status` 为 `rejected` 或 `offline` 时一般存在 |
| `last_deployed_at` | int64（可选） | 上次部署的毫秒时间戳 |

### 向用户反馈的话术

按 `status` 分四类：

- `pending_review` → "应用已提交，审核中。"
- `online` → "审核已通过，应用已上线，访问地址：`<site_url>`"
- `rejected` → "审核未通过。" + 如有 `takedown_reason` 加上 "原因：`<takedown_reason>`"。如果 `block_resubmit=true`，告知用户「管理员已禁止当前 client_id 再次提交本应用」
- `offline` → "应用已下线。" + 如有 `takedown_reason` 加上 "原因：`<takedown_reason>`"

**禁止**：
- 不得主动轮询本接口；只有用户提问时才调用
- 不得猜测原因；`takedown_reason` 为空时只能说"管理员未填写原因"
- 不得在反馈中暴露 `slug` 以外的 raw JSON

---

## 硬性规则（必须遵守）

### 通用

- **使用系统包管理器（apt/yum/dnf/apk/pacman）安装任何软件前，默认先把系统源切到清华 TUNA**（`mirrors.tuna.tsinghua.edu.cn`），不要等超时了再换
- **不得自行编造 `client_id`**：必须来自 `hostname` 命令的真实输出
- **`ticket` 仅在本会话首次提交时询问用户**；首次提交成功拿到的 `ticket` 必须缓存到会话上下文，后续提交自动复用，**不得**反复询问
- **不得自行编造 `ticket`**：要么来自用户输入，要么来自服务端返回
- **应用名称/描述的自动生成必须基于真实应用内容**，不得凭空捏造；用户提供的输入优先级最高
- **应用元数据三项必须分三次 `question` 工具询问**，不得合并
- **不得在请求中传 `user_id` / `task_id`**
- **不得伪装成功**：任一步失败必须如实报告
- **不得轮询审核状态**：Skill 在上传后即结束
- **不得在最终反馈中提示绑定微信或公众号**
- **不得在最终反馈中把 `site_url` 包入代码块**
- **服务端返回的 `data.ticket` 与请求携带的 `ticket` 不一致时，必须在最终反馈中显式告知用户新的 `ticket`**
- **必须按 `status` 与 `data.site_url` 同时判定成功**
- **跨 kind 切换不得在 client 侧报错**；必须提示「将把原应用从 X 切换为 Y，并重新进入待审核状态」

### static 分支专用

- **打包前必须 `rm -f /tmp/dist.zip`**
- **zip 根目录必须是 `index.html`** 且**不得**包含 `.git`、`node_modules`、`src`、`package.json` 等开发文件，通过 `unzip -l` 验证

### backend 分支专用（Dockerfile + 容器化）

- **单容器 + 按需 supervisord**——平台只调度一个容器：
  - 项目用到的所有附加组件（DB / 对象存储 / Redis / 队列 …）必须**全部打入同一镜像**
  - 进程编排策略由 Skill 基于项目探测结果**二选一**：
    - 业务无任何附加组件依赖（单进程后端） → `CMD ["业务命令", ...]` 直接拉起，**禁止**画蛇添足引入 supervisord
    - 业务依赖附加组件 → runtime stage 安装 supervisord，所有进程由 `supervisord -n` 拉起与守护，`CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf","-n"]`
  - 多进程方案下 supervisord 配置 / 启动脚本由 Skill 生成到 `/tmp/` 再 COPY 进镜像，**不得**写入用户工作目录
  - 业务连接附加组件必须走 `127.0.0.1` / `localhost` / Unix socket；除 `service_port` 外不得 `EXPOSE` 其他端口
- **容器运行时无外部网络**——出站 DNS / TCP / UDP 全部不可达：
  - runtime stage 不得有任何联网命令（`curl` / `wget` / `pip install` / `npm install` / `apk fetch` …）
  - 模型权重、字体、字典、初始化 SQL、根证书、静态前端产物等运行时资源必须在 **builder stage 下载完毕**并 COPY 进 runtime stage
  - 应用代码必须移除所有运行时外网调用（远端模型、远端配置、第三方 API、用量上报 …）
  - 本地 `"$RUNTIME" build` **必须**带 `--network host`，确保 builder stage 拉依赖走宿主网络
  - 本地 healthcheck 阶段 `"$RUNTIME" run` **不指定** `--network`（用容器运行时默认网络）；离线自检由 3b.1 的 Dockerfile 写法约束（runtime stage 禁止联网命令、资源在 builder 落盘）从源头保证，不依赖运行时网络隔离
  - 进入 backend 分支前**必须**已在步骤 2 通过独立 `question` 向用户说明「无外网」「单容器」「无持久化」「1C1G」四条限制并取得「继续发布」确认
- **容器无持久化存储**——服务更新、异常崩溃、运维重启都会重建容器，文件系统所有写入都会丢失：
  - Dockerfile 不得 `VOLUME` 数据目录
  - 容器内打包的 DB / 对象存储重启后会清零，必须由 supervisord 启动脚本幂等地重新灌入初始 schema 与种子数据
  - 应用不得假设上次启动写入的文件下次还在
  - 用户上传 / 运行时生成的资源必须接受「重启即丢失」或落到容器内自带的 DB 实例
- 最终（runtime）stage 必须基于 **alpine**（或 alpine 风味的语言镜像，如 `eclipse-temurin:21-alpine-jdk`）
- runtime stage 禁止 `apt-get` / `dnf` / `yum`
- 禁止 `ADD <url>`
- 必须**多阶段**；runtime stage **只 COPY 产物**，不得编译
- **Skill 不得把 Dockerfile / supervisord.conf / start.sh 写到用户工作目录**；必须写到 `/tmp/`（supervisord.conf / start.sh 仅多进程方案下产生）
- **优先使用 `docker`，缺失时必须用包管理器安装 `podman` 后继续**，绝不可手动安装 docker engine；所有 build / run / save 命令统一以 `"$RUNTIME"` 引用
- 本地 `"$RUNTIME" run`（healthcheck 阶段）**禁止** `--privileged`、`--network host`、`--network none`、build context 之外的 bind mount
- **build / run / healthcheck 任一失败必须 abort 并打印 stderr 末段，禁止继续上传**
- 镜像 tar.gz 必须 ≤ 500MB
- 收尾必须执行 `"$RUNTIME" rmi <tag>`、`rm -f /tmp/Dockerfile /tmp/supervisord.conf /tmp/start.sh /tmp/showcase-image.tar.gz`（无论成功失败；单进程方案下 supervisord.conf / start.sh 不存在，`-f` 静默跳过）
- **所有 `FROM` 引用的 Docker Hub 镜像必须加 `registry.monkeycode-ai.online/` 代理前缀**：
  - 无 namespace 的官方镜像必须插入 `library/`（如 `registry.monkeycode-ai.online/library/alpine:3.20`、`registry.monkeycode-ai.online/library/node:20-alpine`）
  - 已有 namespace 的镜像**不要**再插 `library/`（如 `registry.monkeycode-ai.online/eclipse-temurin:21-alpine-jdk`）
  - `FROM scratch` **不走**代理
- **builder stage 依赖下载必须走国内镜像**（见 3b.1「依赖下载镜像约定」）：Go→goproxy.cn、npm/pnpm/yarn→npmmirror.com、pip→清华 PyPI、cargo→清华 crates.io、Maven/Gradle→阿里云、apk/apt/yum→清华 TUNA；镜像切换语句必须在第一条依赖下载命令之前

---

## 错误处理速查

| 失败点 | 处理动作 |
|---|---|
| `hostname` 命令失败 | 报告错误并终止 |
| 找不到项目根 | 询问用户路径，不得猜测 |
| 自动判定异常（既非纯前端也非后端项目） | 按步骤 2 兜底规则向用户询问 kind，仍无法确定则终止 |
| 构建命令无法解析 | 询问用户指定命令 |
| `install` 失败 | 输出 stderr 尾部并终止 |
| `build` 失败（前端 / `"$RUNTIME" build`） | 输出 stderr 尾部并终止 |
| 既无 `docker` 又无 `podman`，且包管理器不可用 | 报告"无可用容器运行时"并终止 |
| 构建后找不到 `index.html` | 输出目录结构并终止 |
| 应用内容无任何可用元数据 | 自动生成留空，由用户在 `question` 工具的 Other 中输入 |
| zip 自检发现开发文件混入 | 调整排除项重新打包；仍存在则终止 |
| 镜像 tar.gz > 500MB | 提示精简产物（多阶段编译 + alpine + 仅拷贝必要文件）并终止 |
| `"$RUNTIME" run` 启动失败 | 打印 `"$RUNTIME" logs` 末段（多进程方案下含 supervisord 子进程日志），清理容器/镜像/`/tmp` 临时文件，终止 |
| healthcheck 90s 内未命中可接受状态码 | 打印 `"$RUNTIME" logs` 末段（多进程方案下含 supervisord 子进程日志），清理，终止 |
| 项目需要重量级附加组件（Elasticsearch / Kafka 等）超出 1C1G | 提示用户替换为轻量替代或拆解需求，终止本次发布 |
| API 请求非 2xx | 重试 1 次；仍失败则报告 `status` 与 `data.message` 后终止 |
| `data.site_url` 为空 | 视为失败，报告 `data.message` 后终止 |
| 用户输入的 `ticket` 实际无效（API 返回错误） | 报告 `data.message` 后终止；不得自动转为新建应用 |
| `data.ticket` 缺失（旧版服务端） | 仍按成功处理，但本会话后续提交无法走更新流程 |
| API 返回 `kind_mismatch` | 提示「上传字段与所选类型不符，本次发布已取消」并终止 |
| API 返回 `image_too_large` | 提示「镜像超过 500MB，请精简产物（多阶段编译 + alpine + 仅拷贝必要文件）」并终止 |
| API 返回 `image_invalid` | 提示「镜像 tar 校验失败，请确认 `"$RUNTIME" save` 流程未中断；如使用 podman 须显式 `--format docker-archive`」并终止 |
| API 返回 `container_start_failed` | 透传 `data.detail`（≤200 字）并终止 |
| API 返回 `healthcheck_failed` | 提示「服务端启动后 healthcheck 失败：<detail>，请本地复跑 `"$RUNTIME" run` + curl 自查」并终止 |

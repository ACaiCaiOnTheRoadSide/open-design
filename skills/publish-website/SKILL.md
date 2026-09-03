---
name: publish-website
description: Publishes a Web project generated in the current session as an online hosted application. Handles environment information retrieval, project type detection, frontend builds (reusing the detection rules from deploy-website), automatic metadata generation based on application content, static asset packaging, and upload to the showcase API through a multipart form POST. Supports purely static projects, Node.js frontends, and containerized backend projects. Before publishing, asks the user to choose the publishing target (domestic showcase vs. international showcase), switches the API base domain accordingly, and enforces a 100 MB package size limit when publishing to the international showcase.
arguments:
  - name: workspace
    description: Absolute path of the project to publish; defaults to the current working directory
    required: false
---

# Publish Application (Publish Website)

Publish a frontend-only project or a containerized project with a backend as an online application. This Skill executes as a strict pipeline: **steps must not be skipped**, and it **must not claim success before completion**.

## Trigger Eligibility (This Skill Is Only for Formal Publishing Explicitly Requested by the User)

`publish-website` is a **formal publishing channel for the public showcase**, not a preview tool for development and debugging. Every execution consumes administrator review resources and exposes the site publicly, so it **must** be triggered only when the user **explicitly requests it** in their **latest message**; without an explicit request, always use `deploy-website` for local deployment plus the platform's online preview instead.

### Permitted Trigger Conditions (All Must Be Met)

1. In the **latest message**, the user explicitly gives a semantically equivalent instruction such as "publish / launch / publish-website / publish using the publish-website skill," and explicitly refers to this Skill
2. The instruction was **not** induced by a suggestion or follow-up question from the Skill or model itself during the conversation (for example, the model must not ask "Would you like to publish?" and then trigger based on the answer)

### Strictly Prohibited Trigger Methods

- **Do not** automatically publish again in any subsequent message merely because "this session has already published once." Even if the user only continues adjusting code, fixing bugs, changing copy, or optimizing styles, the publish pipeline **must not** run again unless the latest message explicitly requests another publication
- **Do not** treat "the code was updated," "the site content changed," or "it was published before, so publish it again while here" as reasons to retrigger this Skill
- **Do not** proactively ask "Would you like to publish again? / Would you like to sync the latest changes?" after a successful publication; doing so could induce the user to trigger formal publishing unintentionally
- All **intermediate-version validation** during development should be performed through `deploy-website` local deployment plus the platform's online preview. This Skill is not responsible for displaying intermediate versions

### Action When a "Repeated Trigger" Is Detected

When the model determines that "publish-website previously completed successfully in this session, and the user's latest message merely continues making adjustments without explicitly requesting another publication," it **must not** enter the pipeline and must instead:

1. State in the response: "This adjustment is an intermediate-version iteration. I recommend first using `/deploy-website` to preview it online within the platform and confirm the result. Once you are satisfied, explicitly tell me, 'Use publish-website to publish the latest version,' and I will run the formal publishing process to update the online version."
2. Invoke `/deploy-website` as needed to complete local deployment and preview
3. Stop, without executing any subsequent step of this Skill

## Pipeline Overview

1. Retrieve environment information (`client_id`)
1c. Ask the user to choose the publishing target (domestic showcase `ugc-submit.sc.monkeycode-ai.online` / international showcase `ugc-submit.monkeycode-ai.gallery`) and record `API_BASE`, `SHOWCASE_URL`, `SITE_DOMAIN`, and `MAX_PACKAGE_SIZE`; the international target enforces a 100 MB package size limit
2. Detect the project type and automatically determine `kind` (static / backend) (reuse `deploy-website` detection rules; backend coverage includes Node-Express, FastAPI, Django+gunicorn, Spring Boot jar, Go, Rust, and others)
3. Route to the static or backend sub-pipeline according to the result
4. Prepare the artifact:
   - static branch: build the frontend when necessary and prepare the static artifact
   - backend branch (Step 3b): generate the Dockerfile, build, run, healthcheck, and save the image
5. Automatically generate the application name and description from its content, confirm each with the user, and ask for the application author
6. Package as `/tmp/dist.zip` (static branch) or confirm `/tmp/showcase-image.tar.gz` (backend branch)
7. Determine the `ticket` (on the first submission, ask whether to reuse an existing application)
8. POST the artifact to the showcase API as a multipart form, cache the returned `ticket`, and return the `site_url` to the user

Server-side registration and administrator review occur **after** Skill execution ends and are outside this Skill's responsibilities.

### About `ticket` (Application Update Key)

- `ticket` is the credential the showcase service uses to identify "the same application." Initial creation issues a `ticket`; to **update** that application later rather than create a new one, include the same `ticket` in the request body
- **Session-level cache**: the `ticket` obtained after the **first** successful application creation in the current session must be cached in the session context (for example, in memory/notes). Every subsequent submission in the same session must automatically use that `ticket` and **must not** ask the user again
- Only when **no application has ever been submitted in this session** should the user be asked whether to reuse an application created in another task (Step 7a)
- **Cross-kind switching**: the same `ticket` can switch from `static` to `backend` (or vice versa). The server replaces the original application in full with the new kind and returns it to pending review; during user confirmation, explicitly state: "This will switch the original application from X to Y and return it to pending review"

---

## Step 1 - Retrieve Environment Information

Determine the `client_id` in this order:

1. If the caller's publish request provides an exact `client_id`, use that value verbatim. In OpenDesign, the publish action provides `od-<project.id>`; **do not** run `hostname` or replace that value.
2. Otherwise, read `OD_PROJECT_ID`. If non-empty, set `client_id` to `od-${OD_PROJECT_ID}`.
3. Only outside OpenDesign, when neither value exists, run `hostname` and use its exact output:

```bash
hostname
```

**Do not fabricate `client_id`.** If none of these sources yields a value, terminate and report the failure to the user.

---

## Step 1c - Choose the Publishing Target (Domestic / International Showcase)

Before anything else, ask the user which showcase to publish to. This choice determines the API base domain used by every upload / status / recall call in this session, the showcase URL shown in the Step 2 warnings, and the package size limit. **Ask once per session; do not re-ask on subsequent publications in the same session.**

Use the `question` tool, wording the prompt, options, and any confirmation/notice in the **user's primary conversation language** (the language the user has been using to communicate in this session). If the user is speaking English, ask in English; if Chinese, ask in Chinese. Do not switch to a language the user is not using.

English:

```
question: Which showcase would you like to publish this application to?
header: Publishing Target
options:
  - Mainland China (sc.monkeycode-ai.online)
  - Global (monkeycode-ai.gallery)
```

中文（当用户以中文交流时）：

```
question: 需要把本应用发布到哪里的作品集？
header: 发布目标
options:
  - 中国大陆 (sc.monkeycode-ai.online)
  - 全球 (monkeycode-ai.gallery)
```

Record the following variables according to the user's choice; **every later step must reference these variables instead of hard-coded domains**:

| Variable | 国内 (domestic) | 国外 (international) |
|---|---|---|
| `API_BASE` | `https://ugc-submit.sc.monkeycode-ai.online` | `https://ugc-submit.monkeycode-ai.gallery` |
| `SHOWCASE_URL` | `https://sc.monkeycode-ai.online/` | `https://monkeycode-ai.gallery` |
| `SITE_DOMAIN` | `sc.monkeycode-ai.online` | `monkeycode-ai.gallery` |
| `MAX_PACKAGE_BYTES` | backend image only: `$((500*1024*1024))` | both static zip and backend image: `$((100*1024*1024))` |
| `MAX_PACKAGE_SIZE` | backend image: 500 MB; static zip: no limit | **100 MB** (both static zip and backend image) |

**International 100 MB limit (hard constraint)**: when the user chooses the international showcase, the entire publishing artifact — the static `site_zip_file` (`/tmp/dist.zip`) or the backend `site_image` (`/tmp/showcase-image.tar.gz`) — must be **<= 100 MB** (100 * 1024 * 1024 bytes). If it exceeds 100 MB, terminate the publication and tell the user to reduce the artifact size; **do not** upload a noncompliant package.

After choosing, continue to Step 1b (compliance precheck), then Step 2.

---

## Step 1b - Publishing Content Compliance Precheck (Hard Constraint)

Before determining `kind`, first determine whether the current working directory belongs to any of the following **prohibited publishing** site types. If any item matches, **terminate publication immediately**, explain the reason to the user, and recommend another distribution channel; **do not** continue with any subsequent step.

### Prohibited Site Types

1. **Software download/distribution sites**: sites whose primary purpose is to provide downloads of executable installers such as `.apk` / `.ipa` / `.exe` / `.dmg` / `.msi` / `.pkg`
   - Detection signals: binary files with the extensions above exist in the site directory, or page copy prominently advertises "Download," "Installer," "Client Download," "Download APK / IPA / EXE / DMG," and similar wording
   - Reason: showcase is a Web application portfolio and is not responsible for software distribution/hosting or the security and compliance obligations of a distribution chain
2. **Direct publication of open-source CMS / website panel projects**: an open-source site-building system or operations panel published directly without any secondary development
   - Common characteristics include but are not limited to: WordPress, Joomla, Drupal, Typecho, Ghost, Halo, DedeCMS, Empire CMS, DEDECMS, PHPMyAdmin, aaPanel, 1Panel, cPanel, Plesk, Webmin, and others
   - Detection signals: the project names above appear in the directory structure, `readme`, `LICENSE`, `composer.json`, or `package.json`, or the homepage is clearly one of these systems' default admin panels/installers
   - Reason: these projects are themselves general-purpose platforms, so direct publication does not constitute a "user work." They also commonly include account systems, file uploads, and plugin marketplaces that seriously conflict with the "single container / no external network / no persistence / publicly visible" runtime constraints

### Required Action

When any item above matches, explicitly reply to the user:

> The current project was detected as a "software download/distribution site or direct publication of an open-source CMS or website panel." The MonkeyCode-AI User Showcase does not accept this type of site, so this publication has been canceled.

Then **end this Skill immediately**. **Do not** ask whether the user wants to continue, and **do not** enter any subsequent step.

---

## Step 2 - Automatically Determine `kind` (static / backend)

The Skill automatically determines the publication `kind` **by scanning the working directory**:

Detection rules (in priority order):

1. Any of the following **backend indicators** exists in the working directory -> classify as `backend`:
   - `requirements.txt` / `pyproject.toml` contains `fastapi` / `uvicorn` / `django` / `flask` / `gunicorn`
   - `manage.py`
   - Top-level `pom.xml` / `build.gradle` (JVM projects such as Spring Boot)
   - `go.mod`
   - `Cargo.toml` (and not a purely wasm frontend)
   - `composer.json` (PHP)
   - `Gemfile` contains `rails` / `sinatra`
   - `package.json` contains backend framework dependencies such as `express` / `fastify` / `koa` / `hapi` / `nest`
2. Only `index.html` / static HTML files exist -> classify as `static`
3. `package.json` exists without backend framework dependencies (pure frontend projects such as Vite / CRA / Next static export / Vue / Astro / Nuxt SSG) -> classify as `static`
4. Detection is inconclusive -> ask the user whether to "publish as a pure frontend" or "publish as a containerized backend," **once only** as a fallback

After classification, route as follows:

- `static` -> **static sub-pipeline** (Steps 3 -> 4 -> 5 -> 6 -> 7 -> 8)
- `backend` -> **backend sub-pipeline** (Steps 3 -> 3b -> 5 -> 7 -> 8; Step 3b replaces Steps 4/6)

### Required User Notice Before Entering the static Branch (Hard Constraint)

After classifying the project as `static`, explicitly state the following platform limitations in the conversation **before entering Step 3**:

> **Warning: This application is about to be published to the MonkeyCode-AI User Showcase (<SHOWCASE_URL>, the publishing target chosen in Step 1c). The online runtime has the following two limitations. Please confirm whether to continue publishing:**
>
> 1. **Data can only be stored in the browser**: A pure frontend application has no server-side persistence layer. Available storage is limited to the current browser's `localStorage` / `sessionStorage` / `IndexedDB`. Data does not carry over when the user changes browsers or devices or clears the cache; data is not shared among users.
> 2. **Publicly visible**: After publication, the application is publicly visible in the User Showcase (<SHOWCASE_URL>), and anyone can access it.

Then use the `question` tool to request confirmation, with options "Continue publishing" / "Cancel."

- User selects "Continue publishing" -> enter Step 3
- User selects "Cancel" -> terminate this publication

### Required User Notice Before Entering the backend Branch (Hard Constraint)

Tell the user only the considerations **related to the online runtime phase**. Do not expose any image build-stage details (how the Dockerfile is written, whether supervisord is used, how dependencies are downloaded, and so on are handled internally by the Skill and are irrelevant to the user).

After classifying the project as `backend`, explicitly state the following platform limitations in the conversation **before entering Step 3b**:

> **Warning: This application is about to be published as a container to the MonkeyCode-AI User Showcase (<SHOWCASE_URL>, the publishing target chosen in Step 1c). The online runtime has the following four limitations. Please confirm whether to continue publishing:**
>
> 1. **Single container**: The platform schedules only one container. If the application depends on components such as a database, object storage, cache, or queue, they run in the same container as the application; independent external services are not supported.
> 2. **No external network**: The container cannot access the public Internet or any external service. Remote databases, S3, third-party APIs, OAuth / payment / WeChat, CDNs, external LLMs, and similar services are unreachable. Once online, the application can only be accessed externally and must not and cannot access the Internet.
> 3. **No persistent storage**: The file system is reset when the service is updated, restarts unexpectedly, or operations rebuilds the container. All runtime writes (SQLite, user uploads, logs, caches, and so on) are lost.
> 4. **Publicly visible**: After publication, the application is publicly visible in the User Showcase (<SHOWCASE_URL>), and anyone can access it.

Then use the `question` tool to request confirmation, with options "Continue publishing" / "Cancel."

- User selects "Continue publishing" -> enter Step 3b
- User selects "Cancel" -> terminate this publication

---

## Step 3 - Detect Project Type

Reuse the detection logic from `deploy-website`. Route according to the automatic classification from Step 2:

### static Branch (kind=static)

| Detection Result | Route |
|---|---|
| `package.json` exists (Node project) | -> **Node build branch** (Step 4, Branch B/C) |
| Only `index.html` / static HTML files exist | -> **Static branch** (Step 4, Branch A) |

#### Package Manager Detection (Node Projects Only)

Priority order:
1. `pnpm-lock.yaml` -> `pnpm`
2. `yarn.lock` -> `yarn`
3. `package-lock.json` -> `npm`
4. None exists -> default to `npm`

#### Build Command Resolution (Node Projects Only)

In priority order:
1. `scripts.build` in `package.json` -> `<pkgMgr> run build`
2. Known default framework artifact directories: Vite/CRA/Astro -> `dist`, Next.js static export -> `out`, react-scripts -> `build`
3. README fallback: scan `README*` for commands containing `build` / `compile` / `dist` and extract them
4. If all of the above fail -> **ask the user** to specify the build command; do not guess

#### Expected Artifact Directory

Record the expected output directory (`dist` / `out` / `build`) for use in Step 4.

### backend Branch (kind=backend)

Detect the project language/framework, covering at least the following cases:

| Detection Indicator | Inferred Type |
|---|---|
| `package.json` contains `express` / `fastify` / `koa` / `hapi` | Node-Express family |
| `requirements.txt` / `pyproject.toml` contains `fastapi` / `uvicorn` | FastAPI |
| `manage.py` + `requirements.txt` contains `django` + `gunicorn` | Django + gunicorn |
| Top-level `pom.xml` / `build.gradle` with a `*.jar` artifact (Spring Boot) | Spring Boot jar |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| Other | Ask the user for the base image and startup command; do not guess |

Record the inferred result for Step 3b to use when generating the Dockerfile.

---

## Step 3b - backend Sub-pipeline

> Execute only when Step 2 automatically classifies the project as `backend` and the user selects "Continue publishing" after being informed of the four runtime limitations. After completion, skip Steps 4/6 and proceed directly to Steps 5, 7, and 8.

### 3b.0 Platform Limitations (Must Be Followed Before Generating the Dockerfile)

The showcase platform imposes four hard constraints on backend containers. All must be met, or the image will not run correctly.

#### A. Single Container + Process Orchestration (supervisord as Needed)

- The platform schedules **one container only** and does not support docker-compose / k8s pod / sidecar
- Choose one of two process orchestration strategies **based on auxiliary component requirements** (the Skill determines this in 3b.1):
  - **Single-process approach (default)**: the application has no auxiliary dependencies such as a DB / object storage / cache / queue and is a stateless backend process -> **start the application process directly with `ENTRYPOINT` / `CMD`**; do not introduce supervisord
  - **Multi-process approach**: the application depends on auxiliary components such as a DB / object storage / cache / queue -> package **all of these components into the same image**, and use **supervisord** to start and supervise them with the application process, ordered by `priority`
- Localize auxiliary components under the multi-process approach:
  - Relational DB (PostgreSQL / MySQL / MariaDB) -> package it entirely into the image and load the initial schema into the data directory in the builder stage
  - Object storage (MinIO / SeaweedFS) -> package it entirely into the image and initialize the bucket in the container startup script
  - Redis / Memcached / Elasticsearch / RabbitMQ and others -> likewise, start all of them locally
- Application code **must connect to auxiliary components through `127.0.0.1` / `localhost` / Unix socket** and must not use an external host name or endpoint

#### B. No External Network in the Container (Offline at Runtime)

At runtime, the container is **completely cut off from the public Internet and external networks**:

- Outbound DNS, TCP, and UDP are all unreachable; remote DBs, remote S3, remote Redis, third-party APIs, OAuth IdPs, CDNs, `pip` / `npm` / `apt`, and others are **all unavailable**
- The image must be **fully self-contained**: download every resource required at runtime in advance in the **builder stage and COPY it into the runtime stage**, including but not limited to:
  - Application dependency packages (already installed in the builder; directly copy venv / node_modules / target/release / vendor into runtime)
  - Model weights, embedding files, tokenizers
  - Fonts, dictionaries, geographic libraries, localization resources
  - Initial DB schema (`*.sql`) and seed data
  - Static frontend artifacts (for a combined frontend/backend image)
  - HTTPS root certificates (if the application previously connected directly to the public Internet with CA validation, change it to trust only internal certificates or simply use internal HTTP)
- External exposure: **only one port, `service_port`**, with the platform reverse proxy providing the external HTTP service

#### C. No Persistent Storage in the Container

- Service update deployments, unexpected container crashes, and operations-side restarts all **rebuild the container** (destroy the old instance and start a new instance from the image)
- No volume / bind mount is mounted; all file-system writes are lost upon rebuild
- A DB / object store packaged inside the container **is also reset**. After a restart, the supervisord startup script must reinitialize the schema and seed data

The Dockerfile **must not** declare a data directory with `VOLUME` (the declaration is ineffective and instead misleads the user).

If the project **strongly depends** on an external persistence layer or external API (for example, it must connect to real WeChat / payment / external LLM services), inform the user again that "the relevant features may not function correctly after deployment." Continue building and publishing only after the user accepts this.

#### D. Resource Limits

- CPU: 1 core
- Memory: 1 GiB (including swap)
- Image tar.gz: <= <MAX_PACKAGE_SIZE> (500 MB domestic / **100 MB international**, per Step 1c)

When packaging auxiliary components such as a DB, object storage, or models, reduce them as much as possible to fit these limits.

### 3b.1 Generate the Dockerfile

Based on the detection result from Step 3, the AI generates a **multi-stage alpine** `Dockerfile` at `/tmp/Dockerfile`. This Dockerfile is specifically for building the container image published to showcase. **Do not** write this Dockerfile to the user's working directory.

Hard authoring constraints:

- The final (runtime) stage must be based on alpine or an alpine-flavored language image (such as `eclipse-temurin:21-alpine-jdk`)
- In principle, `apt-get` / `dnf` / `yum` are **prohibited** in the runtime stage. If packages must be installed, cleanup must be performed afterward (such as `apt clean`)
- **Prohibit** `ADD <url>`; explicitly download all external resources to disk in the builder stage using `RUN curl/wget`
- Multiple stages are required; the runtime stage may only `COPY --from=builder` compiled artifacts / runtime dependencies (including runtime resources such as model weights, fonts, initialization SQL, and root certificates) and must not run any networked command
- Automatically select the process orchestration strategy according to 3b.0 Section A: single-process approach `CMD ["application command", ...]`; multi-process approach `CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf","-n"]` (see 3b.1.a for configuration)
- `CMD` must use exec form (JSON array)
- Must `EXPOSE <service_port>`, matching the multipart field `service_port`; auxiliary component ports (DB / Redis / MinIO, and others) use only 127.0.0.1 and **must not be EXPOSEd**
- **Every Docker Hub image referenced by `FROM` must have the `docker.1ms.run/` proxy prefix**:
  - Official images without a namespace (`alpine` / `node` / `python` / `golang` / `nginx` / `rust` / `caddy`, and others) must insert `library/`: `FROM docker.1ms.run/library/alpine:3.20`
  - Images that already have a namespace (such as `eclipse-temurin/...`) **must not** insert another `library/`: `FROM docker.1ms.run/eclipse-temurin:21-alpine-jdk`
  - `FROM scratch` **does not use** the proxy; leave it unchanged
  - Inject this prefix only when generating the Dockerfile; after the showcase server loads the image, it references the local image ID and is no longer affected by the proxy
  - **默认镜像代理为 `docker.1ms.run/`**；仅当用户明确指示时，才可将其整体替换为用户指定的其他镜像代理（例如用户说"使用我自己的镜像代理 xxx"时，将前缀替换为 `xxx/`）。未经用户明确指示，**不得**擅自更换默认代理

#### 3b.1.a supervisord Configuration (Multi-process Approach Only)

> Use this section only when the application depends on auxiliary components (DB / object storage / cache / queue, and others). The single-process approach skips this section and writes `CMD ["application command", ...]` directly in the runtime stage.

The runtime stage must install supervisord and provide a configuration file:

```dockerfile
# In the runtime stage
RUN apk add --no-cache supervisor
COPY supervisord.conf /etc/supervisord.conf
COPY --from=builder /app /app
EXPOSE <service_port>
CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf","-n"]
```

Minimal `supervisord.conf` template (add or remove `[program:*]` sections according to the project's actual auxiliary components, and use `priority` to control startup order; lower numbers start earlier):

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

Before starting the application process, `/app/start.sh` must:

1. Wait for auxiliary components to become ready (`pg_isready` / `redis-cli ping` / health probe script, for at most 30 seconds)
2. Idempotently load the initial schema and seed data (from `*.sql` baked into the image during the builder stage)
3. Then `exec` the application process (preserving PID 1 child-process semantics so supervisord can reap it)

> The Skill must **generate the supervisord configuration file `supervisord.conf` and startup script `start.sh` under `/tmp/`** and then `COPY` them into the image. They **must not** be written to the user's working directory.

#### 3b.1.b Auxiliary Component Packaging Guide (Multi-process Approach Only)

| Component | Recommended Approach |
|---|---|
| PostgreSQL | Install `postgresql` and initialize with `initdb` in the builder stage; use `apk add postgresql` in the runtime stage; start `postgres -D /var/lib/postgresql/data` with supervisord; COPY the schema from the builder and load it with `psql -f` in the startup script |
| MySQL/MariaDB | Run `apk add mariadb mariadb-client` in the runtime stage; complete `mysql_install_db --user=mysql` in the builder; start `mysqld --user=mysql` with supervisord |
| Redis | Run `apk add redis` in the runtime stage; start `redis-server --bind 127.0.0.1 --save ""` with supervisord (disable persistence or write to a temporary directory in the container) |
| MinIO | Download the minio binary with `wget` in the builder stage; COPY it into runtime; start `minio server /data --address 127.0.0.1:9000` with supervisord; initialize the bucket with `mc` in the startup script |
| Heavyweight components such as Elasticsearch / Kafka | They do not fit in 1 GiB of memory. **Tell the user to replace them with a lightweight alternative** (such as SQLite FTS / Redis Streams / NATS embedded) or terminate this publication |

#### Dependency Download Mirror Convention (Must Be Followed in the builder Stage)

The build environment is located in China by default, so direct connections to official sources are highly likely to time out. **Before downloading any dependency in the builder stage, switch to the corresponding Chinese mirror below**:

| Ecosystem | Mirror | Dockerfile Syntax |
|---|---|---|
| Go | goproxy.cn | `ENV GOPROXY=https://goproxy.cn,direct` |
| Node (npm/pnpm) | npmmirror.com | `RUN npm config set registry https://registry.npmmirror.com` (pnpm also reads npm configuration; for yarn, use `yarn config set registry https://registry.npmmirror.com`) |
| Python (pip) | Tsinghua TUNA PyPI | `RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt` |
| Rust (cargo) | Tsinghua TUNA crates.io | See the config.toml snippet below |
| Java (Maven) | Alibaba Cloud | Point the `settings.xml` mirror to `https://maven.aliyun.com/repository/public`, or use Gradle `repositories { maven { url "https://maven.aliyun.com/repository/public" } }` |
| Alpine apk | Tsinghua TUNA | `RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.tuna.tsinghua.edu.cn/g' /etc/apk/repositories` |
| Debian/Ubuntu apt | Tsinghua TUNA | `RUN sed -i 's@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/debian.sources` (use `/etc/apt/sources.list` for older images without a `.sources` file) |

Rust cargo mirror configuration (in the builder stage):

```dockerfile
RUN mkdir -p "${CARGO_HOME:-$HOME/.cargo}" && printf '%s\n' \
  '[source.crates-io]' \
  'replace-with = "tuna"' \
  '' \
  '[source.tuna]' \
  'registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"' \
  > "${CARGO_HOME:-$HOME/.cargo}/config.toml"
```

Notes:

- The mirror-switch statement must appear **before the first dependency download command**
- These configurations belong only in the builder stage; package installation is already prohibited in the runtime stage, so they are unnecessary there
- If a mirror outage causes a download failure, fall back to the official source and retry once before considering it failed

### 3b.2 Confirm the Container Runtime (Required)

**Prefer `docker`; fall back to `podman` only when `docker` is unavailable.**

**Before installing anything with the system package manager, switch the system source to Tsinghua TUNA by default** (the build environment is in China and direct connections to official sources are highly likely to time out; skip this when the source is already a Chinese mirror):

```bash
if command -v docker >/dev/null 2>&1; then
  RUNTIME=docker
elif command -v podman >/dev/null 2>&1; then
  RUNTIME=podman
else
  # Neither is in PATH -> install podman through the package manager (do not try to install the docker daemon)
  # Switch to the Tsinghua TUNA source by default before installation
  if command -v apt-get >/dev/null 2>&1; then
    sudo sed -i 's@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
      || sudo sed -i 's@archive.ubuntu.com@mirrors.tuna.tsinghua.edu.cn@g; s@deb.debian.org@mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list
    sudo apt-get update && sudo apt-get install -y podman
  elif command -v dnf >/dev/null 2>&1; then
    # CentOS/Rocky/Alma: comment out mirrorlist in repo files and point baseurl to Tsinghua
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
    echo "No available package manager; cannot install a container runtime" >&2
    exit 1
  fi
  RUNTIME=podman
fi
echo "using container runtime: $RUNTIME"
```

In all subsequent steps, use `"$RUNTIME"` instead of the literal `docker`, because the docker / podman CLIs have compatible parameters for build / run / save operations (podman is rootless and may require a one-time `podman system migrate` on its first run; handle this if encountered).

### 3b.3 Local build

The build phase **must** use `--network host` so the builder stage can directly reuse the host network when fetching dependencies (Chinese mirrors, apt/apk sources, and others):

```bash
TAG="showcase-publish-$(openssl rand -hex 4):tmp"
"$RUNTIME" build --network host -t "$TAG" -f /tmp/Dockerfile .
```

If the build fails, print the last part of stderr (at most 200 lines), **terminate immediately**, and **do not** continue uploading.

### 3b.4 Local run + healthcheck

Select an unused host port (detect it with a script; do not hard-code it). `$SVC` is the in-container application port (`service_port`) determined when generating the Dockerfile.

During the local healthcheck phase, **do not specify** `--network`; use the container runtime's default network (docker defaults to `bridge`, podman defaults to `slirp4netns` / `pasta`) so the host can reach the port mapping directly with `curl 127.0.0.1:$HOST`. The Skill guarantees the offline self-check through the Dockerfile authoring constraints in 3b.1; it does not depend on runtime network isolation:

```bash
"$RUNTIME" run -d --rm \
  --cpus=1 --memory=1g --memory-swap=1g \
  -p $HOST:$SVC \
  --name "${TAG%:*}-run" \
  "$TAG"
```

**Prohibit** `--privileged`, `--network host`, and `bind mounts outside the build context`.

Because the image may need to start a DB / object store before the application, **extend the total healthcheck duration to 90 seconds**, probing every 3 seconds:

```bash
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$HOST<healthcheck_path>" || echo 000)
  case "$code" in
    200|204|302|401) ok=1; break;;
  esac
  sleep 3
done
```

The AI selects the healthcheck path (such as `/`, `/healthz`, `/api/health`) and acceptable status code set based on the application type (default `{200,204,302,401}`).

On any failure (container startup failure / no acceptable status code within the 90-second healthcheck):

1. Print the last part of `"$RUNTIME" logs <container>` (<= 200 lines); also print supervisord child-process logs if available
2. Run `"$RUNTIME" stop <container>` + `"$RUNTIME" rmi $TAG` + clean up `/tmp/Dockerfile`; for the multi-process approach, also clean up `/tmp/supervisord.conf` and `/tmp/start.sh` (skip files that do not exist)
3. **Terminate immediately** and **do not** continue uploading

### 3b.5 Export the Image

After the healthcheck passes:

```bash
"$RUNTIME" stop "${TAG%:*}-run"
# The server loads through the Docker daemon, so output must use docker-archive format;
# docker save uses this format by default, while podman save must explicitly specify --format docker-archive.
if [ "$RUNTIME" = "podman" ]; then
  "$RUNTIME" save --format docker-archive "$TAG" | gzip -1 > /tmp/showcase-image.tar.gz
else
  "$RUNTIME" save "$TAG" | gzip -1 > /tmp/showcase-image.tar.gz
fi
```

**Mandatory self-check**:

```bash
size=$(stat -c%s /tmp/showcase-image.tar.gz)
test "$size" -le $((MAX_PACKAGE_BYTES)) || { echo "Image exceeds <MAX_PACKAGE_SIZE>"; exit 1; }
```

If it exceeds <MAX_PACKAGE_SIZE> (500 MB domestic / **100 MB international**, per Step 1c) -> terminate and tell the user to reduce the artifact (multi-stage compilation + alpine + copy only necessary files).

### 3b.6 Prepare multipart Fields

Record the fields required by Step 8:

- `kind=backend`
- `site_image=@/tmp/showcase-image.tar.gz`
- `service_port=<in-container application port>`
- `healthcheck_path=<path used in 3b.4>`

> The backend branch **does not** generate `/tmp/dist.zip` and **does not** include `site_zip_file`.

### 3b.7 Cleanup (Required After Either Success or Failure in Step 8)

```bash
"$RUNTIME" rmi "$TAG" 2>/dev/null || true
rm -f /tmp/Dockerfile
rm -f /tmp/supervisord.conf  # Does not exist under the single-process approach; rm -f has no effect
rm -f /tmp/start.sh           # Does not exist under the single-process approach; rm -f has no effect
rm -f /tmp/showcase-image.tar.gz
```

---

## Step 4 - Prepare the Static Artifact (static Branch Only)

> The backend branch skips this section and proceeds directly to Step 5.

Goal: obtain a directory that **contains `index.html` directly at its top level** (denoted `<artifact_dir>`).

Clean up the old artifact before packaging:

```bash
rm -f /tmp/dist.zip
```

### Branch A - Pure Static HTML Project
Use the project root directly as `<artifact_dir>`.

### Branch B - Node Project with an Existing dist
If the expected artifact directory exists and **contains `index.html`**, use it as `<artifact_dir>`.

### Branch C - Node Project Without dist (Build Required)

1. If `node_modules` does not exist, run `<pkgMgr> install`. **Switch the registry to npmmirror before installation** (npm/pnpm: `npm config set registry https://registry.npmmirror.com`; yarn: `yarn config set registry https://registry.npmmirror.com`), because direct connections to registry.npmjs.org are highly likely to time out in China. On failure, output the end of stderr and **terminate**.
2. Run the resolved build command. On failure, output the end of stderr and **terminate**; do not retry blindly.
3. Locate `index.html`:
   - First search within the expected artifact directory
   - If not found, use this fallback: `find . -maxdepth 3 -name index.html -not -path './node_modules/*'`
   - If there are multiple candidates, choose the one with the **shortest path**
   - If still not found -> terminate and report `Build completed but index.html was not found`

---

## Step 5 - Generate and Confirm Application Metadata

**Generate automatically first, then ask the user about each item**. Make a separate `question` tool call for each field; **do not** combine multiple fields into one question.

### 5a. Automatically Generate `site_name` and `site_description` Based on Application Content

- **static branch**: synthesize from `<title>` / `<meta name="description">` / `<h1>` / above-the-fold body text in `<artifact_dir>/index.html`; for Node projects, the root `package.json` `name` and `description` may also be referenced
- **backend branch**: synthesize from name + description in the project root's `package.json` / `pyproject.toml` / `pom.xml` / `Cargo.toml` / `go.mod`; if a README exists, extract the introductory first paragraph

Output:
- Automatically generated `site_name` (a one-line short title, <= 30 characters)
- Automatically generated `site_description` (a one-line summary, <= 80 characters)

> If there is no parsable content, **do not provide a default "Satisfied" option** in the subsequent question; require the user to enter a value.

### 5b. Ask for the Application Name (`question` Tool, One Separate Call)

```
question: The automatically detected application name is "<generated site_name>". Use it?
header: Application Name
options:
  - Satisfied, use this
```

- User selects **Satisfied, use this** -> use the automatically generated value
- User enters a value through **Other** -> use that input

### 5c. Ask for the Application Description (`question` Tool, One Separate Call)

```
question: The automatically detected application description is "<generated site_description>". Use it?
header: Application Description
options:
  - Satisfied, use this
```

- Handle it using the same logic as 5b.

### 5d. Ask for the Application Author (`question` Tool, One Separate Call)

```
question: Enter the application author's ID (select an option below or enter one manually)
header: Application Author
options:
  - Anonymous author
```

- User selects **Anonymous author** -> `site_author = "anonymous"`
- User enters a value through **Other** -> use that input

---

## Step 6 - Package (static Branch Only)

> The backend branch skips this section; its artifact was prepared in 3b.4.

You must `cd` into `<artifact_dir>` before packaging to ensure the zip has no wrapper directory; also **exclude development-related files**:

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

> **Notes**:
> - For **Branches B/C** (the artifact directory is under `dist`/`out`/`build`), the directory already contains built static assets, so most exclusions will not match; retain the exclusion rules as a defensive fallback
> - For **Branch A** (the artifact directory is the project root), the exclusions above effectively prevent source code, dependencies, version-control directories, and configuration files from being packaged
> - If `<artifact_dir>` genuinely contains required `.ts`/`.tsx` assets (very rare), adjust the exclusions; otherwise retain the defaults above

**Mandatory self-check**:

```bash
unzip -l /tmp/dist.zip | head -30
```

Requirements:
- `index.html` is at the **top level** (without any path prefix)
- Development files such as `.git/`, `node_modules/`, `src/`, and `package.json` **must not** appear in the output

**International size check (international target only)**: when the Step 1c target is the international showcase, also verify that the package fits within the 100 MB limit:

```bash
size=$(wc -c < /tmp/dist.zip | tr -d '[:space:]')
test "$size" -le $((100*1024*1024)) || { echo "Package exceeds 100MB"; exit 1; }
```

If any requirement is not met, terminate immediately; **do not** upload a noncompliant package.

---

## Step 7 - Determine the `ticket` (the **Key**)

Determine whether the current session already has a cached key (ticket):

- **A cached key exists** (an application was previously submitted successfully in this session) -> reuse it directly, **skip 7a**, and enter Step 8
- **No cached key exists** (the first submission in this session) -> enter 7a and ask the user

### 7a. Ask Whether to Reuse an Existing Application (Run Once on the First Submission)

Use the `question` tool and **provide only one explicit option**. The remaining Other input itself represents "Yes, enter the key to update an existing application"; its placeholder must use that wording:

```
question: Was this application submitted in another task before? Do you need to update an existing application or submit a new one? To update it, select [Other] and enter the key provided by the previous task.
header: Update an Existing Application?
options:
  - No, submit a new application
  # Other: The input placeholder/meaning is "Yes, enter the key to update an existing application"; the user enters the key here directly
```

- User selects **No, submit a new application** -> leave the key empty (do not include the `ticket` field)
- User enters a key in the **Other** input -> use the entered string as `ticket`
- If the user's input is an empty string or whitespace only -> treat it as not provided and handle it as "submit a new application"

> **Cross-kind notice**: if the user provides a ticket and the current kind differs from the original application's kind as they remember it (this cannot be determined automatically on the client side; rely on the user's statement), before submission state, "This will switch the original application from X to Y and return it to pending review," and obtain confirmation. The server replaces the original application in full during the switch.

---

## Step 8 - Publish

Submit all fields and the artifact to the showcase API in one multipart form POST.

### 8a. Call the API

**static branch** (choose either without ticket / with ticket):

```bash
curl -f -X POST \
  -F "client_id=<client_id>" \
  -F "kind=static" \
  -F "site_name=<application name>" \
  -F "site_author=<application author>" \
  -F "site_description=<application description>" \
  [ -F "ticket=<ticket>" ] \
  -F "site_zip_file=@/tmp/dist.zip" \
  <API_BASE>/v1/create
```

**backend branch**:

```bash
curl -f -X POST \
  -F "client_id=<client_id>" \
  -F "kind=backend" \
  -F "site_name=<application name>" \
  -F "site_author=<application author>" \
  -F "site_description=<application description>" \
  [ -F "ticket=<ticket>" ] \
  -F "site_image=@/tmp/showcase-image.tar.gz" \
  -F "service_port=<in-container application port>" \
  -F "healthcheck_path=<healthcheck path>" \
  <API_BASE>/v1/create
```

Field descriptions:

| Field | static | backend | Source |
|---|---|---|---|
| `client_id` | Required | Required | Exact caller-provided value, `OD_PROJECT_ID`-derived value, or `hostname` fallback from Step 1 |
| `kind` | Required (`static`) | Required (`backend`) | Automatic classification result from Step 2 |
| `site_name` | Required | Required | Step 5b |
| `site_author` | Required | Required | Step 5d |
| `site_description` | Required | Required | Step 5c |
| `site_zip_file` | Required | Must not appear | Step 6 |
| `site_image` | Must not appear | Required | Step 3b.4 |
| `service_port` | Must not appear | Required | Step 3b |
| `healthcheck_path` | Must not appear | Optional (default `/`) | Step 3b.3 |
| `ticket` | Optional | Optional | Step 7 |

Key points:

- `<API_BASE>` is the base domain recorded in Step 1c (domestic `https://ugc-submit.sc.monkeycode-ai.online` / international `https://ugc-submit.monkeycode-ai.gallery`); **never** hard-code a fixed showcase domain in the request
- `-f` makes non-2xx HTTP statuses return a nonzero exit code
- On failure, **retry at most once** (to handle network fluctuations)
- All fields must be shell-escaped
- **Do not** additionally pass fields such as `user_id` / `task_id`
- **Do not** mix a kind with artifact fields for another kind (for example, `kind=static` together with `site_image`)

### 8b. Parse the Response

Server response structure:

```json
{
  "status": 200,
  "data": {
    "message": "success or error detail",
    "site_url": "https://xxxxx.<SITE_DOMAIN>",   # domestic: https://xxxxx.sc.monkeycode-ai.online ; international: https://xxxxx.monkeycode-ai.gallery
    "ticket": "<reuse this ticket within the session>"
  }
}
```

Handling rules:
- If `status` is 2xx and `data.site_url` is nonempty -> treat as success and extract `site_url`
- **If `data.ticket` is nonempty**: **cache it in the current session context**. Automatically use this `ticket` for every subsequent submission in this session, and do not ask the user again
- **If `data.ticket` differs from the `ticket` included in the request**: the final response must **explicitly tell the user the new `ticket` value**
- Otherwise -> treat as failure, report `data.message` to the user as the error reason, and **do not** pretend it succeeded

### 8c. Provide User Feedback

On success (`site_url` must be rendered **on its own line** as a clickable link and **must not** be placed in a code block; **do not** suggest linking WeChat or an official account):

```
The application has been submitted for publication. Preview URL:

<site_url>

The application requires administrator review before going online. To learn its review status, ask here and I will check and tell you.
```

**If the `data.ticket` returned by the server differs from the `ticket` included in the request**:

```
The application has been submitted for publication. Preview URL:

<site_url>

The update credential ticket for this application is: `<new_ticket>`
To update this application again later, provide this ticket to me in a new session.

The application requires administrator review before going online. To learn its review status, ask here and I will check and tell you.
```

On failure, report the HTTP status code and `data.message`; **do not** fabricate an application URL.

---

## Query Review Status (Execute When Explicitly Asked by the User)

When the user asks in this session about review / going online / rejection reasons / takedown reasons, call:

```bash
curl -f --get \
  --data-urlencode "client_id=<client_id>" \
  --data-urlencode "ticket=<ticket>" \
  "<API_BASE>/v1/status"
```

- `<API_BASE>`: the base domain chosen in Step 1c (`https://ugc-submit.sc.monkeycode-ai.online` domestic / `https://ugc-submit.monkeycode-ai.gallery` international), which must match the target used for submission
- `client_id`: the value determined in Step 1; it **must** match the value used for submission
- `ticket`: the `ticket` cached within the session

The server uses `ticket` to locate the site, then verifies that `client_id` matches the site. If either does not match, it returns 404 `site_not_found`.

### Response Fields

On success, it returns `{ code: 0, data: {...} }`; fields in `data`:

| Field | Type | Description |
|---|---|---|
| `slug` | string | Application slug |
| `status` | string | `pending_review` / `online` / `offline` / `rejected` |
| `kind` | string | `static` / `backend` |
| `block_resubmit` | bool | When `true`, the same `client_id` is prohibited from submitting again; another call to `/v1/create` returns 403 `resubmit_blocked` |
| `takedown_reason` | string (optional) | Reason entered by the administrator when rejecting / taking down the application; generally present when `status` is `rejected` or `offline` |
| `last_deployed_at` | int64 (optional) | Millisecond timestamp of the last deployment |

### User-facing Response Wording

Use four categories according to `status`:

- `pending_review` -> "The application has been submitted and is under review."
- `online` -> "The review passed and the application is online. URL: `<site_url>`"
- `rejected` -> "The application did not pass review." + if `takedown_reason` exists, append "Reason: `<takedown_reason>`." If `block_resubmit=true`, tell the user, "The administrator has prohibited the current client_id from submitting this application again"
- `offline` -> "The application has been taken offline." + if `takedown_reason` exists, append "Reason: `<takedown_reason>`"

**Prohibited**:
- Do not proactively poll this endpoint; call it only when the user asks
- Do not guess the reason; when `takedown_reason` is empty, say only "The administrator did not provide a reason"
- Do not expose raw JSON other than `slug` in the response

---

## Recall the Application (Execute Only When Explicitly Requested by the User)

> **This section is a fallback channel for the user and is not part of the publishing process. After publication, do not proactively tell the user that "the application can be recalled"**. Enter this section only when the user explicitly expresses an intent such as "take it offline / recall it / delete the application I just published."

A recall does not mean the Skill automatically removes the application; it forwards the request to an administrator. The application does not go offline immediately after submission. After receiving the request, an administrator manually decides whether to take it offline / reject / retain it.

### Call the Endpoint

```bash
curl --fail-with-body -X POST \
  -F "client_id=<client_id>" \
  -F "ticket=<ticket>" \
  [ -F "reason=<recall reason>" ] \
  <API_BASE>/v1/recall
```

`--fail-with-body` preserves the server's JSON body on HTTP 4xx/5xx while still returning a nonzero exit code, so the response handling below can inspect the real error code and `detail.status`.

Field descriptions:

| Field | Required | Source |
|---|---|---|
| `client_id` | Required | Value determined in Step 1; must match the value used for publication |
| `ticket` | Required | `ticket` cached within the session; if the user does not have a ticket, ask them to provide it in a new session or retrieve it from the original session |
| `reason` | Optional | The recall reason stated by the user, forwarded verbatim to the administrator; truncate beyond 500 characters |

### Response Handling

Server response structure:

```json
{
  "slug": "...",
  "status": "pending_review | online",
  "recall_requested_at": 1719300000000,
  "already_requested": false
}
```

- `already_requested=false` -> the recall was successfully marked for the first time; tell the user, "The administrator has been notified; awaiting manual processing"
- `already_requested=true` -> the same recall request was submitted previously; tell the user, "A recall request was submitted previously and is still awaiting administrator processing. Please wait patiently"
- HTTP 4xx:
  - `site_not_found` -> ticket / client_id does not match; tell the user, "The corresponding application could not be found. Please confirm that the ticket is correct"
  - `invalid_request` with `detail.status` equal to `offline` / `rejected` -> the application is already offline / did not pass review, so no recall is needed; simply tell the user its current status
- Network failure / 5xx -> retry once; if it still fails, report the failure accurately

### User-facing Response Wording (First Success)

```
A recall request has been submitted to the administrator and is awaiting manual processing.

The application is currently still in the <status> state and will only go offline after the administrator processes it. To learn the result, ask here and I will check and tell you.
```

### Prohibited

- **Do not proactively tell the user anywhere in the publishing process that "the application can be recalled"**. Recall is a fallback channel, and proactively mentioning it encourages casual recalls
- **Do not fabricate a successful recall**. If the server does not return 2xx, report it accurately
- **Do not call blindly without a `ticket`**. First confirm that a ticket is cached in the session or explicitly provided by the user
- **Do not poll `/v1/status` waiting for recall completion**. Recall is a manual process; the Skill ends when the `/v1/recall` call succeeds

---

## Hard Rules (Must Be Followed)

### General

- **Execute this Skill only when the user's latest message explicitly requests publication**: after publishing once in the current session, if the user continues adjusting code/content without explicitly requesting "publish using publish-website" in the latest message, **do not** automatically run the publishing process again. Always use `/deploy-website` local deployment plus the platform's online preview for intermediate versions, and do not proactively ask whether the user wants to publish again
- **Interaction language follows the user's conversation language**: all user-facing text in this Skill — `question` prompts, option labels, the Step 2 warnings, metadata confirmation, ticket questions, and the final success/failure wording — must be written in the **primary language the user is communicating in during this session** (English when the user writes in English, Chinese when in Chinese, and so on). Never force a fixed language on the user
- **Step 1c, the publishing target selection, must be confirmed before any upload / status / recall call**: ask the user to choose the domestic showcase or the international showcase (once per session), and use the recorded `<API_BASE>` / `<SHOWCASE_URL>` / `<SITE_DOMAIN>` / `<MAX_PACKAGE_SIZE>` in every later step. **Never** hard-code a fixed showcase domain in requests
- **International 100 MB package limit**: when the Step 1c target is the international showcase, the entire publishing artifact (static `site_zip_file` or backend `site_image`) must be **<= 100 MB**; if it exceeds 100 MB, terminate the publication and do not upload
- **Step 1b, the publishing content compliance precheck, must run first**: if either "software download/distribution (hosting apk/ipa/exe/dmg/msi/pkg or other installers)" or "direct publication of an open-source CMS / website panel (WordPress / Halo / Typecho / aaPanel / 1Panel / cPanel, and others)" matches, **terminate immediately** and do not enter kind classification or any subsequent step
- **Before installing any software with a system package manager (apt/yum/dnf/apk/pacman), switch the system source to Tsinghua TUNA by default** (`mirrors.tuna.tsinghua.edu.cn`); do not wait for a timeout before switching
- **Do not fabricate `client_id`**: use the exact caller-provided value first, then `OD_PROJECT_ID`, and only then the actual output of `hostname`, as defined in Step 1
- **Ask the user about `ticket` only on the first submission in this session**; the `ticket` received after the first successful submission must be cached in the session context and automatically reused for subsequent submissions. **Do not** ask repeatedly
- **Do not fabricate `ticket`**: it must come either from user input or the server response
- **Automatic generation of the application name/description must be based on actual application content**; do not invent them. User-provided input has the highest priority
- **The three application metadata fields must be asked through three separate `question` tool calls**; do not combine them
- **Do not pass `user_id` / `task_id` in the request**
- **Do not pretend success**: accurately report any failure at any step
- **Do not poll review status**: the Skill ends after upload
- **Do not suggest linking WeChat or an official account in the final response**
- **Do not put `site_url` in a code block in the final response**
- **When `data.ticket` returned by the server differs from the `ticket` included in the request, explicitly tell the user the new `ticket` in the final response**
- **Determine success using both `status` and `data.site_url`**
- **Do not report an error on the client side for a cross-kind switch**; state, "This will switch the original application from X to Y and return it to pending review"

### static Branch Only

- **Must run `rm -f /tmp/dist.zip` before packaging**
- **The zip root must contain `index.html`**, and the zip **must not** contain development files such as `.git`, `node_modules`, `src`, or `package.json`; verify with `unzip -l`
- **International target: `/tmp/dist.zip` must be <= 100 MB** (verify with `stat -c%s`); if it exceeds 100 MB, terminate and do not upload

### backend Branch Only (Dockerfile + Containerization)

- **Single container + supervisord as needed**: the platform schedules only one container:
  - All auxiliary components used by the project (DB / object storage / Redis / queue, and others) must be **packaged into the same image**
  - Based on project detection results, the Skill must **choose one of two** process orchestration strategies:
    - The application has no auxiliary component dependencies (single-process backend) -> start it directly with `CMD ["application command", ...]`; **do not** introduce unnecessary supervisord
    - The application depends on auxiliary components -> install supervisord in the runtime stage, start and supervise every process with `supervisord -n`, and use `CMD ["/usr/bin/supervisord","-c","/etc/supervisord.conf","-n"]`
  - Under the multi-process approach, the Skill generates the supervisord configuration / startup script under `/tmp/` and then COPYs them into the image; **do not** write them to the user's working directory
  - The application must connect to auxiliary components through `127.0.0.1` / `localhost` / Unix socket; do not `EXPOSE` any port other than `service_port`
- **No external network at container runtime**: outbound DNS / TCP / UDP are all unreachable:
  - The runtime stage must not contain any networked command (`curl` / `wget` / `pip install` / `npm install` / `apk fetch`, and others)
  - Runtime resources such as model weights, fonts, dictionaries, initialization SQL, root certificates, and static frontend artifacts must be **fully downloaded in the builder stage** and COPYed into the runtime stage
  - Application code must remove every runtime external-network call (remote models, remote configuration, third-party APIs, usage reporting, and others)
  - Local `"$RUNTIME" build` **must** include `--network host` to ensure the builder stage fetches dependencies through the host network
  - During the local healthcheck phase, `"$RUNTIME" run` **does not specify** `--network` (use the container runtime's default network). The Dockerfile authoring constraints in 3b.1 (no networked commands in the runtime stage, resources downloaded in the builder) guarantee the offline self-check at the source; it does not depend on runtime network isolation
  - Before entering the backend branch, Step 2 **must** have used a separate `question` to explain the four limitations, "no external network," "single container," "no persistence," and "1C1G," and obtained "Continue publishing" confirmation
- **No persistent storage in the container**: service updates, unexpected crashes, and operations restarts all rebuild the container, and all file-system writes are lost:
  - The Dockerfile must not declare a data directory with `VOLUME`
  - A DB / object store packaged in the container is reset after a restart; the supervisord startup script must idempotently reload the initial schema and seed data
  - The application must not assume that files written during the previous start will still exist on the next start
  - User uploads / runtime-generated resources must accept "lost on restart" behavior or be stored in the DB instance bundled in the container
- The final (runtime) stage must be based on **alpine** (or an alpine-flavored language image such as `eclipse-temurin:21-alpine-jdk`)
- Prohibit `apt-get` / `dnf` / `yum` in the runtime stage
- Prohibit `ADD <url>`
- **Multiple stages** are required; the runtime stage **only COPYs artifacts** and must not compile
- **The Skill must not write Dockerfile / supervisord.conf / start.sh to the user's working directory**; write them under `/tmp/` (supervisord.conf / start.sh are generated only for the multi-process approach)
- **Prefer `docker`; if absent, install `podman` with the package manager and continue**. Never manually install the docker engine; uniformly reference `"$RUNTIME"` in all build / run / save commands
- During local `"$RUNTIME" run` (healthcheck phase), **prohibit** `--privileged`, `--network host`, `--network none`, and bind mounts outside the build context
- **Any build / run / healthcheck failure must abort and print the end of stderr; do not continue uploading**
- The image tar.gz must be <= <MAX_PACKAGE_SIZE> (500 MB domestic / **100 MB international**, per Step 1c)
- Cleanup must run `"$RUNTIME" rmi <tag>` and `rm -f /tmp/Dockerfile /tmp/supervisord.conf /tmp/start.sh /tmp/showcase-image.tar.gz` (on both success and failure; supervisord.conf / start.sh do not exist under the single-process approach, so `-f` silently skips them)
- **Every Docker Hub image referenced by `FROM` must have the `docker.1ms.run/` proxy prefix**:
  - Official images without a namespace must insert `library/` (such as `docker.1ms.run/library/alpine:3.20` and `docker.1ms.run/library/node:20-alpine`)
  - Images that already have a namespace **must not** insert another `library/` (such as `docker.1ms.run/eclipse-temurin:21-alpine-jdk`)
  - `FROM scratch` **does not use** the proxy
  - The default proxy is `docker.1ms.run/`; it may be replaced with a user-specified proxy only when the user explicitly instructs it (for example, replacing the prefix with the user's own image proxy)
- **Dependency downloads in the builder stage must use Chinese mirrors** (see "Dependency Download Mirror Convention" in 3b.1): Go -> goproxy.cn, npm/pnpm/yarn -> npmmirror.com, pip -> Tsinghua PyPI, cargo -> Tsinghua crates.io, Maven/Gradle -> Alibaba Cloud, apk/apt/yum -> Tsinghua TUNA. The mirror-switch statement must precede the first dependency download command

---

## Error Handling Quick Reference

| Failure Point | Action |
|---|---|
| No caller-provided `client_id`, no `OD_PROJECT_ID`, and `hostname` fails | Report the error and terminate |
| Step 1b matches a prohibited type (software distribution / direct publication of an open-source CMS or website panel) | Tell the user, "The showcase does not accept this type of site," terminate immediately, and do not enter kind classification |
| Project root cannot be found | Ask the user for the path; do not guess |
| Automatic classification is inconclusive (neither a pure frontend nor a backend project) | Ask the user for the kind according to the Step 2 fallback rule; terminate if it still cannot be determined |
| Build command cannot be resolved | Ask the user to specify the command |
| `install` fails | Output the end of stderr and terminate |
| `build` fails (frontend / `"$RUNTIME" build`) | Output the end of stderr and terminate |
| Neither `docker` nor `podman` exists, and the package manager is unavailable | Report "No available container runtime" and terminate |
| `index.html` cannot be found after the build | Output the directory structure and terminate |
| Application content has no usable metadata | Leave automatic generation empty and have the user enter it through Other in the `question` tool |
| zip self-check finds included development files | Adjust the exclusions and repackage; terminate if they still exist |
| International target: `/tmp/dist.zip` > 100 MB | Tell the user to reduce the static package (remove unused assets, compress images/fonts) and terminate |
| Image tar.gz > <MAX_PACKAGE_SIZE> (500 MB domestic / 100 MB international) | Tell the user to reduce the artifact (multi-stage compilation + alpine + copy only necessary files) and terminate |
| `"$RUNTIME" run` fails to start | Print the end of `"$RUNTIME" logs` (including supervisord child-process logs under the multi-process approach), clean up the container/image/`/tmp` temporary files, and terminate |
| No acceptable status code within the 90-second healthcheck | Print the end of `"$RUNTIME" logs` (including supervisord child-process logs under the multi-process approach), clean up, and terminate |
| The project requires heavyweight auxiliary components (Elasticsearch / Kafka, and others) exceeding 1C1G | Tell the user to replace them with lightweight alternatives or decompose the requirement, and terminate this publication |
| API request is not 2xx | Retry once; if it still fails, report `status` and `data.message`, then terminate |
| `data.site_url` is empty | Treat as failure, report `data.message`, and terminate |
| The `ticket` entered by the user is invalid (API returns an error) | Report `data.message` and terminate; do not automatically switch to creating a new application |
| `data.ticket` is missing (legacy server) | Still treat as success, but subsequent submissions in this session cannot use the update flow |
| API returns `kind_mismatch` | State, "The upload fields do not match the selected type. This publication has been canceled," and terminate |
| API returns `image_too_large` | State, "The image exceeds <MAX_PACKAGE_SIZE> (500 MB domestic / 100 MB international). Please reduce the artifact (multi-stage compilation + alpine + copy only necessary files)," and terminate |
| API returns `image_invalid` | State, "Image tar validation failed. Confirm that the `"$RUNTIME" save` process was not interrupted; when using podman, explicitly specify `--format docker-archive`," and terminate |
| API returns `container_start_failed` | Pass through `data.detail` (<= 200 characters) and terminate |
| API returns `healthcheck_failed` | State, "The healthcheck failed after server startup: <detail>. Locally rerun `"$RUNTIME" run` + curl to investigate," and terminate |

# Quickstart — Open Design SaaS 运行时盒子

5 分钟把这个"盒子"跑起来,用你自己的模型 key 从一句话生成一个设计网页。

> **这是什么**:一个打包好的 Docker 镜像,里面装了 Open Design 后端 + opencode(AI)。
> 你投入「一句话 + 你的模型密钥」,它生成一个网页设计稿(HTML),跑完即销毁。
> 这是 SaaS 化的 **per-turn(每轮一容器)** 形态的核心验证产物;完整说明见 [`README.md`](README.md)。

---

## 前置要求

1. **Docker**(Desktop 或 Engine 均可)。
2. **一个有效的模型 key** —— 任意 OpenAI 兼容端点都行(DeepSeek / OpenAI / 月之暗面 / 本地 Ollama …)。
   平台不提供模型,你自带 key、模型费走你自己账户(这叫 BYOK,Bring Your Own Key,自带密钥)。

---

## 3 步跑通

### 第 1 步:构建镜像(只需一次,几分钟)

```bash
cd <仓库根>            # 例如 /Users/you/project/open-design
docker build --pull=false -f saas-runtime/Dockerfile -t od-saas-runtime .
```

> 首次构建会装整个工作区依赖 + 编译,慢一点;之后改了代码再 build 会快。
> 若 `docker build` 因拉 base 镜像报 401/limit,先 `docker login`。

### 第 2 步:生成一个设计稿(turn 模式)

```bash
cd <仓库根>

# —— 换成你的凭证 + 模型 ——
KEY="sk-你的有效key"
BASEURL="https://api.deepseek.com"     # 任意 OpenAI 兼容端点
MODEL="deepseek-v4-pro"                # 例:deepseek-chat / deepseek-v4-pro / gpt-4o …

# —— 你想生成什么(中英文都行)——
echo "做一个现代感的 SaaS 登录页,深色渐变背景,居中玻璃卡片,社交登录" > /tmp/od-prompt.txt

# —— 跑(盒子自动:起来 → 用你的 key 调 AI → 生成 → 优雅关闭 → 销毁)——
PROVIDER="{\"provider\":{\"deepseek\":{\"options\":{\"baseURL\":\"$BASEURL\",\"apiKey\":\"$KEY\"},\"models\":{\"$MODEL\":{}}}},\"model\":\"deepseek/$MODEL\"}"
docker run --rm \
  -v /tmp/od-prompt.txt:/input/prompt.txt:ro \
  -v od-demo:/data \
  -e OD_OPENCODE_PROVIDER_CONFIG="$PROVIDER" \
  -e OD_MODEL="deepseek/$MODEL" \
  od-saas-runtime turn --prompt-file /input/prompt.txt
```

中途会刷一大堆 JSON —— 那是 AI 一步步干活的过程,正常。**只看最后一行**:

- `[run-turn] 终态:succeeded` + `turn 结束,退出码 0` → ✅ 成功
- `退出码 1` + 日志里有 `401` / `api key invalid` → key 无效,换一个

### 第 3 步:看效果

```bash
# 把生成的网页拷出来,浏览器打开
docker run --rm -v od-demo:/data alpine sh -c 'cat /data/projects/*/index.html' > /tmp/od-result.html
open /tmp/od-result.html        # Linux 用 xdg-open

# (可选)Chrome 无头截图成 PNG
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
  --screenshot=/tmp/od-result.png --window-size=1280,1000 /tmp/od-result.html
open /tmp/od-result.png
```

---

## 换需求 / 换模型

- **换需求**:改第 2 步里 `echo` 那句话即可(例:`做一个三档定价页,中间档高亮`、`做一个数据仪表盘,含 KPI 卡片和图表`)。
- **换模型服务**:改 `BASEURL` / `KEY` / `MODEL` 三个变量,其余不动。任意 OpenAI 兼容端点都行。
- **重跑要干净**:每次 turn 复用 `od-demo` 数据盘(会累积成多轮对话)。想从零开始,先 `docker volume rm od-demo`。

---

## serve 模式(可选,调试 / 手动玩 API)

让 daemon 常驻、对外开 HTTP,自己调 API:

```bash
docker run -d --name od-serve -p 17456:7456 \
  -e OD_API_TOKEN=dev-token \
  -e OD_OPENCODE_PROVIDER_CONFIG="$PROVIDER" \
  od-saas-runtime

curl -H "Authorization: Bearer dev-token" http://127.0.0.1:17456/api/version   # 测活
docker logs od-serve            # 看 daemon 日志
docker rm -f od-serve           # 停掉
```

> 容器内 daemon 绑 `0.0.0.0` 必须带 `OD_API_TOKEN`(不给会随机生成一个,你就连不上)。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `401` / `api key invalid` | 模型 key 无效或过期 —— 换一个有效的 |
| `AGENT_EXECUTION_FAILED` / `UnknownError` | 多半是 provider 没配对:确认 `OD_OPENCODE_PROVIDER_CONFIG` 的 `baseURL`/`apiKey`/`models` 和 `--model` 前缀(`deepseek/<model>`)一致 |
| `platform (linux/amd64) does not match ... arm64` 警告 | 无害。镜像是 amd64,在 Apple Silicon 上靠模拟运行,稍慢但能用 |
| 生成很慢(几十秒~分钟) | 正常:一次完整的 AI 生成 + 容器冷启动 |
| `health` 一开始 `Connection reset` 然后又 OK | 正常:daemon 启动中,curl 自重试会等到它就绪 |
| 想换端口 | serve 模式改 `-p <host端口>:7456` |

---

## 这个盒子现在能 / 不能做什么

- ✅ **能**:单个容器内,用你自带的 key,从一句话生成一个设计网页,跑完即销毁(per-turn 核心链路)。
- ⬜ **还不能**(尚未实现):把生成结果存到云端、下次接着改(`restore/save` 目前是占位);用户登录 / 计费;同时给很多人开容器并隔离;镜像瘦身。

完整设计与路线图见仓库根的《open-design-saas-技术方案.md》。

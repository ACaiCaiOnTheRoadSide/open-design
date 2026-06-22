# Open Design 单用户完整 demo

一个容器跑起完整的 Open Design——浏览器打开就是原生 OD 界面:聊天、生成设计稿、多轮迭代、预览。预置你的模型 key(BYOK),单用户,**没有** SaaS 的控制面/计费/多租户。

等于"把本地版 Open Design 整个搬进 Docker、配好 key"。

---

## 跑起来(3 步)

```bash
cd saas-runtime/demo
cp .env.example .env          # 填上你的模型 key(OD_BYOK_API_KEY)
docker compose up -d --build  # 首次构建几分钟(装依赖 + 构建 web/daemon + 装 opencode)
```

构建完,浏览器打开 **http://localhost:8080** —— 就是完整的 OD 界面。

看日志确认就绪:
```bash
docker compose logs -f open-design   # 看到 "✅ 就绪!浏览器访问" 即可
```

停止 / 清理:
```bash
docker compose down                  # 停止(保留数据卷)
docker compose down -v               # 停止并删除数据(项目/对话全清)
```

---

## 它是怎么搭的

```
浏览器  →  http://localhost:8080
              │  (docker 端口映射)
              ▼
        ┌──────────────── 一个容器 ────────────────┐
        │  socat  0.0.0.0:8080 → 127.0.0.1:7456    │  ← 把外部访问伪装成 loopback
        │              │                            │     (daemon 看到 peer=127.0.0.1 → 免 token)
        │              ▼                            │
        │  od daemon  127.0.0.1:7456                │
        │    · serve 静态 web 界面(apps/web/out/)   │  ← 一个进程同时是界面和后端
        │    · /api/*  后端                          │
        │    · spawn opencode(用你的 BYOK key)      │
        │  数据在 /data(挂 docker 卷,持久)         │
        └───────────────────────────────────────────┘
```

两个关键设计(都不改 OD 源码):

1. **web 是静态的,daemon 自己 serve** —— `next build` 默认导出静态站点到 `apps/web/out/`,daemon 用 `express.static` 提供。所以界面 + API 一个进程全包。
2. **socat 绕过 token** —— daemon 绑 `0.0.0.0` 会强制要 token,但浏览器里的 web 不带 token。改成 daemon 绑 `127.0.0.1`(loopback 免 token)、socat 把外部 `:8080` 转成对 loopback 的访问,问题就没了。

---

## 换模型 / 配置

`.env` 里的变量:

| 变量 | 说明 |
|---|---|
| `OD_BYOK_API_KEY` | **必填**,你的模型 key |
| `OD_BYOK_BASE_URL` | 模型端点,默认 `https://api.deepseek.com`。任意 OpenAI 兼容端点 |
| `OD_BYOK_MODEL` | 模型名,默认 `deepseek-v4-pro` |
| `OD_BYOK_PROVIDER` | provider 标识,默认 `deepseek` |
| `DEMO_PORT` | 浏览器访问端口,默认 `8080` |

改完 `.env` 后 `docker compose up -d`(无需 `--build`)即可生效。

---

## 这个 demo 不包含什么

- ❌ 多用户 / 登录 / 团队隔离
- ❌ 计费 / 积分
- ❌ 对象存储(状态在本地 docker 卷)
- ❌ 控制面 / 网关

这些是完整 SaaS 的内容,见上层 `saas-runtime/open-design-saas.md`(v3 方案)和 `docker-compose.yml`(完整部署蓝图)。这个 demo 只为**最快看到产品形态**。

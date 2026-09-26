# Folio · AutoDL 部署说明

## 直接在 AutoDL 容器内运行

标准 AutoDL 容器内无法运行 Docker，因此本项目不使用容器，直接运行 Node.js + MySQL + Qdrant + 本地模型服务。Embedding 与重排跑本机 CPU，对话模型走 OpenRouter。

### 1. 安装依赖

在项目根目录执行：

```bash
npm ci
```

如果 Node.js 版本低于 20，请先让环境配置 Node.js 22。

### 2. 创建配置文件

```bash
cp .env.example .env
```

修改 `.env`，至少配置：

```env
APP_PORT=6006
APP_ORIGIN=https://你的AutoDL自定义服务地址
PUBLIC_BASE_PATH=/folio

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=folio
MYSQL_USER=root
MYSQL_PASSWORD=修改为实际密码

AI_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=填写你的OpenRouter密钥
AI_CHAT_MODEL=qwen/qwen3-235b-a22b-2507
AI_UTILITY_MODEL=qwen/qwen3-30b-a3b-instruct-2507
# OpenRouter 推理开关：off / low / medium / high（留空则不发送该字段）。
# 指令模型设为 off 首字延迟明显更低。
AI_REASONING_EFFORT=off
```

Embedding / Rerank 使用本地服务（见下文“本地 Embedding + Rerank”）。Qdrant 见下文“本机运行 Qdrant”。

### 3. 初始化数据库并构建

```bash
npm run db:setup
npm run build
```

### 4. 启动

```bash
npm run start:prod
```

`start:prod` 会先执行迁移与初始化，再以 `NODE_ENV=production` 启动，同时提供 API 和前端静态资源。如果只想重启服务，用 `npm start` 即可（同样以生产模式运行）。初始化脚本在账户已存在时不会再覆盖密码。

AutoDL 的“自定义服务”通常使用 6006 或 6008 端口。这里配置为 6006 后，在 AutoDL 控制台把 6006 添加为 HTTP 服务即可。官方文档：<https://www.autodl.com/docs/port/>

访问路径：

```text
https://你的AutoDL服务地址/folio/
```

健康检查：

```text
https://你的AutoDL服务地址/api/health
```

## 本机运行 Qdrant（推荐）

直接运行 Qdrant 官方静态二进制：

```bash
mkdir -p /root/autodl-tmp/folio/vendor/qdrant && cd /root/autodl-tmp/folio/vendor/qdrant
# 需要外网；AutoDL 上可先执行 source /etc/network_turbo
curl -L -o qdrant.tar.gz \
  https://github.com/qdrant/qdrant/releases/download/v1.19.1/qdrant-x86_64-unknown-linux-musl.tar.gz
tar xzf qdrant.tar.gz
mkdir -p /root/autodl-tmp/folio/data/qdrant/{storage,snapshots}
QDRANT__STORAGE__STORAGE_PATH=/root/autodl-tmp/folio/data/qdrant/storage \
QDRANT__STORAGE__SNAPSHOTS_PATH=/root/autodl-tmp/folio/data/qdrant/snapshots \
QDRANT__SERVICE__HOST=127.0.0.1 QDRANT__TELEMETRY_DISABLED=true ./qdrant
```

在 `.env` 中启用：

```env
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=folio_chunks
```

已有文档的分块需要回填到 Qdrant（不会重复调用 Embedding，直接复用库中的向量）：

```bash
npm run db:reindex
```

之后问答会优先用 Qdrant 做向量检索；未配置 Qdrant 时才使用 MySQL JSON 向量与全文检索。生产环境建议把 Qdrant 纳入进程监控和健康检查，避免索引服务异常长期未被发现。

## 图片型 PDF 的 OCR

扫描版 PDF 没有文字层，`pdf-parse` 提取不到内容，系统会判断并自动 OCR：

- 判断方式：整个 PDF 的可提取文本平均每页少于 `OCR_MIN_CHARS_PER_PAGE`（默认 30）时，视为扫描件。
- 识别方式 `OCR_PROVIDER=auto`：优先用本机 `tesseract`，未安装时回退到视觉模型（需配置 `OCR_MODEL`）。
- 安装本机 OCR：

```bash
apt-get update && apt-get install -y poppler-utils tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
```

- 若使用模型 OCR（无需本机安装），例如：

```env
OCR_PROVIDER=model
OCR_MODEL=google/gemini-2.5-flash
```

相关参数：`OCR_LANGUAGE`（默认 `chi_sim+eng`）、`OCR_MAX_PAGES`（默认 30）、`OCR_DPI`（默认 200）、`OCR_ENABLED`。

## 本地 Embedding + Rerank（纯 CPU，推荐）

Embedding 和重排不需要大模型也不需要 GPU，用 `local_models/serve.py` 起一个本机服务即可（对外暴露 OpenAI 兼容的 `/v1/embeddings` 和 `/v1/rerank`），聊天模型仍走 OpenRouter。

```bash
pip install sentence-transformers fastapi "uvicorn[standard]" modelscope

# 国内下载用 ModelScope 更快（HF 直连约 0.6MB/s）
mkdir -p /root/autodl-tmp/folio/models
modelscope download --model BAAI/bge-m3 --local_dir /root/autodl-tmp/folio/models/bge-m3
modelscope download --model BAAI/bge-reranker-v2-m3 --local_dir /root/autodl-tmp/folio/models/bge-reranker-v2-m3

LOCAL_EMBEDDING_MODEL=/root/autodl-tmp/folio/models/bge-m3 \
LOCAL_RERANK_MODEL=/root/autodl-tmp/folio/models/bge-reranker-v2-m3 \
LOCAL_MODEL_THREADS=32 \
python3 local_models/serve.py --port 8080
```

`.env`：

```env
AI_EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
EMBEDDING_API_KEY=local
RERANK_PROVIDER=api
RERANK_URL=http://127.0.0.1:8080/v1/rerank
RERANK_API_KEY=local
RERANK_MODEL=BAAI/bge-reranker-v2-m3
RERANK_MIN_SCORE=0.55
SEARCH_SEMANTIC_MIN=0.45
```

阈值来自实测：bge-m3 相关约 0.58–0.66、无关约 0.23–0.30；bge-reranker-v2-m3 相关约 0.72、无关约 0.50。换模型后重新校准一次。

**切换 embedding 模型后必须重建向量**（维度会变，旧向量不可用）：

```bash
npm run db:reembed
```

## 注意事项

- 压缩包不包含 `.env`，需要在 AutoDL 上重新创建，避免泄露 API Key。
- `storage/` 保存上传文件；AutoDL 上建议把它放在数据盘，并定期备份。
- 公开访问前请修改 `MYSQL_PASSWORD`，并在创建账户后将 `ALLOW_REGISTRATION=false`。
- 如果使用 HTTPS 自定义服务，可以设置 `SECURE_COOKIES=true`。
- OpenRouter 是按 API 使用量计费，Embedding 只会在上传解析和问答检索时调用。

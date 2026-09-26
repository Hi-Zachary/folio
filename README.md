# Folio

Folio 是一个个人知识库：把散落的资料（PDF / Word / Markdown / TXT / 扫描件 / 粘贴文本）导入后，自动解析、分块、建立索引；随后可组织、检索、基于资料问答，并把有价值的回答沉淀成自己的笔记。回答始终带来源，可回到原文核对。Embedding 与重排可完全跑在本地 CPU，只有对话模型（和可选的模型 OCR）需要外部 API。

> 产品设计与分阶段方案见 [`/root/autodl-tmp/设计/Folio-产品设计方案-修订版.md`](/root/autodl-tmp/设计/Folio-产品设计方案-修订版.md)。顶级导航：**资料库 / 问答**。

## 功能

- **资料管理**：多文件并行上传、独立进度、重复检测、类型校验、预览、下载、删除、失败重试；支持 PDF / DOCX / Markdown / HTML / CSV / TXT，也可直接粘贴文本或导入公开网页。
- **组织与检索**：用**项目**（类似文件夹，把多篇资料组成长期工作范围，兼作问答范围）和**标签**（属性与筛选）组织资料；支持批量加入项目、按文件名/内容/笔记搜索，并可查看解析后的原文分块。
- **个人笔记**：对文档或具体分块划线记笔记，笔记可检索，并与引用来源放在一起。
- **文档版本**：上传新版本前自动保留旧文件和解析分块，可查看历史版本并恢复；恢复时当前内容也会保存成新版本。
- **相关文档**：基于向量近邻推荐同一知识库内的相关文档。
- **文档解析**：PDF 按页提取、DOCX、Markdown、TXT；扫描版 PDF 自动识别并 OCR（本机 `tesseract`，或 `OCR_MODEL` 指定的视觉模型）。
- **检索**：`bge-m3` Embedding + Qdrant 向量检索（未配 Qdrant 时回退 MySQL JSON），配合 CJK bigram 词法匹配、相关性门槛与 `bge-reranker-v2-m3` 重排。
- **项目**：以文件夹式卡片展示资料集合，可进入项目浏览、集中提问；支持按当前搜索条件创建自动更新的智能项目。
- **资料列表**：支持关键词、标签、项目、类型、状态筛选，以及按最近导入 / 标题 / 文件大小排序；移动端自动切换为卡片列表。
- **文档 AI 摘要**：按需为单篇文档生成层级摘要（分段摘要 → 汇总），缓存并做过期判断，用于快速回忆与多文档任务的全局信息。
- **问答（Agentic RAG）**：由“模型自主调用工具”的 Agent 驱动——可 `检索片段`、`列出资料目录`、`读取某篇的摘要/正文`、`列出项目`，并按需多轮调用后再作答。支持会话标题和消息内容搜索、**全库 / 项目 / 指定资料**三种范围、SSE 流式输出、统一的 `[1]` 引用角标（点击查看对应原文上下文）、复制、重新生成、👍/👎、追问建议、**保存为笔记**，以及多轮记忆。
- **粘贴文本 / 网页导入**：直接把文本或公开网页正文创建为资料，网页会保留来源地址并进入同一解析、分块和索引流程。
- **账户**：注册、登录、HttpOnly 会话 Cookie、退出，账户级资料与对话隔离。
- **导出**：会话导出为 Markdown 或 TXT。

## 技术栈

- 前端：React、TypeScript、Vite、Tailwind CSS、lucide-react、react-markdown
- 后端：Node.js、Express、TypeScript、Zod、mysql2
- 数据库：MySQL 8+ / MariaDB
- 向量库：Qdrant（可选，未启用时用 MySQL JSON 回退）
- 本地模型：`BAAI/bge-m3`（Embedding）、`BAAI/bge-reranker-v2-m3`（Rerank），纯 CPU
- 对话模型：任意 OpenAI 兼容 `/chat/completions`（默认 OpenRouter）

## 目录

```text
server/            后端（Express + 迁移/初始化脚本）
  sql/             数据库迁移
  src/services/    解析、检索、重排、会话记忆、本地 OCR 等
src/               前端（React）
local_models/      本地 Embedding + Rerank 服务（Python/FastAPI）
```

## 第一次运行

1. 安装依赖并准备配置：

   ```bash
   npm install
   cp .env.example .env
   ```

2. 启动本地 Embedding + Rerank（可选但推荐，见“本地模型”一节）。
3. 准备 MySQL，在 `.env` 中填写 `MYSQL_*`，然后初始化：

   ```bash
   npm run db:setup
   ```

4. 开发模式：`npm run dev`（前端 <http://localhost:5173/folio/>，后端 <http://localhost:3001/api/health>）。
   生产模式：`npm run build` 后 `npm run start:prod`（首次）或 `npm start`（重启）。

首次访问进入登录页，默认允许注册。公开部署并创建账户后，建议把 `ALLOW_REGISTRATION=false`，并在 HTTPS 下设置 `SECURE_COOKIES=true`。

## 本地模型（Embedding + Rerank）

Embedding 和重排用本地 CPU 模型即可，无需 GPU：

```bash
pip install sentence-transformers fastapi "uvicorn[standard]" modelscope
mkdir -p /root/autodl-tmp/folio/models
modelscope download --model BAAI/bge-m3 --local_dir /root/autodl-tmp/folio/models/bge-m3
modelscope download --model BAAI/bge-reranker-v2-m3 --local_dir /root/autodl-tmp/folio/models/bge-reranker-v2-m3

LOCAL_EMBEDDING_MODEL=/root/autodl-tmp/folio/models/bge-m3 \
LOCAL_RERANK_MODEL=/root/autodl-tmp/folio/models/bge-reranker-v2-m3 \
LOCAL_MODEL_THREADS=32 \
python3 local_models/serve.py --port 8080
```

服务同时暴露 OpenAI 兼容的 `/v1/embeddings` 与 `/v1/rerank`。在 `.env` 中指向它：

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

阈值按模型实测校准：bge-m3 相关约 0.58–0.66、无关约 0.23–0.30；bge-reranker-v2-m3 相关约 0.72、无关约 0.50。**更换 Embedding 模型后必须重建向量**（维度会变）：

```bash
npm run db:reembed
```

## 对话模型

对话走任意 OpenAI 兼容接口，例如 OpenRouter：

```env
AI_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=your-key
AI_CHAT_MODEL=qwen/qwen3-235b-a22b-2507
AI_UTILITY_MODEL=qwen/qwen3-30b-a3b-instruct-2507
AI_REASONING_EFFORT=off
```

`AI_UTILITY_MODEL` 用于改写、重排兜底和摘要（留空则复用对话模型）；`AI_REASONING_EFFORT` 可取 `off`/`low`/`medium`/`high`，指令模型设为 `off` 首字延迟明显更低。

**回答策略**：检索到资料时只依据资料回答并给出引用；**检索不到时不会直接拒答**，模型会用通用知识回答并在开头说明“以下内容基于通用知识，不是来自你的资料库”（可用 `ANSWER_WITHOUT_CONTEXT=false` 关闭）。多文档/单文档的“讲了什么、总结、比较”类问题会自动使用文档摘要作为全局上下文；模型偶发返回空时会提示重试，而不会把原始片段当成回答。

## 生产构建

```bash
npm run build     # 前端 dist/ + 后端 dist-server/
npm start         # 以 NODE_ENV=production 启动（同 API + 前端静态资源）
```

必须带 `NODE_ENV=production`（`npm start` 已内置），否则前端路由会 404。部署细节见 [AUTODL_DEPLOY.md](AUTODL_DEPLOY.md)。

## 数据模型

- `app_user`、`auth_session`：账户与登录会话
- `tag`、`document_tag`：用户标签与文档标签关联
- `collection`、`collection_document`：专题集与资料关联
- `document_note`：分块级笔记与高亮（支持手写 / 摘录 / 由 AI 回答保存）
- `documents`、`document_job`、`document_chunk`：文件元数据（含 AI 摘要字段）、任务、分块与向量备份
- `chat_session`、`chat_message`：会话与消息（含滚动摘要）
- `message_retrieval`、`message_source`：检索记录与引用来源

- Qdrant `folio_chunks`：Embedding 向量与检索元数据

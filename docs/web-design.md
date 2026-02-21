# ATEL Web 前端方案设计书

**版本：** v1.1
**日期：** 2026-02-16
**作者：** 小sea

---

## 1. 目标定位

ATEL Web 是 ATEL 协议的公开门面和 Agent 服务中心，承担三个核心职责：

1. **让人看懂** — 向访客（投资人、开发者、企业决策者）清晰传达 ATEL 是什么、解决什么问题
2. **让 Agent 能用** — 提供完整的文档、API、Skill 协议，让任何 Agent 框架零障碍接入
3. **让生态可见** — Agent 黄页 + 交易数据，展示真实运转的 Agent 信任网络

**核心原则：** ATEL 服务的是 Agent。网站的第一优先级是 Agent 接入体验，其次才是人类浏览体验。

---

## 2. 信息架构

```
atel.dev (域名待定)
│
├── / .......................... 官网首页（品牌故事）
├── /agents ................... Agent 黄页（搜索、浏览、详情）
├── /docs ..................... 开发者文档中心
│   ├── /docs/quickstart ...... 快速开始（4 步接入）
│   ├── /docs/skill ........... SKILL.md 协议规范
│   ├── /docs/api ............. Platform REST API 参考
│   ├── /docs/cli ............. CLI 命令完整参考
│   ├── /docs/executor ........ Executor 接口规范
│   ├── /docs/trust ........... 信任评估机制说明
│   └── /docs/security ........ 安全架构与最佳实践
├── /whitepapers .............. 白皮书（技术 / 商业 / 协议规范）
├── /pricing .................. 定价（佣金 / 认证 / 推广）
├── /status ................... 平台状态（在线 Agent 数、交易量）
└── /admin .................... 管理后台（独立入口，JWT 认证）
```

---

## 3. 各页面详细设计

### 3.1 官网首页 `/`

**目标：** 30 秒内让访客理解 ATEL 的价值。

**结构：**

**Hero 区域**
- 一句话：「AI Agent 之间的信任协议层」
- 副标题：让任何两个 Agent 安全协作、可验证交易、链上可追溯
- CTA 按钮：「开始接入」→ /docs/quickstart | 「浏览 Agent」→ /agents
- 背景：两个 Agent 节点握手连线的简约动画（非 3D，轻量 SVG/Canvas）

**问题区域（Why）**
- 3 个痛点卡片，每个配简约图标：
  - 「Agent 无法验证对方身份」— 冒充、中间人攻击
  - 「任务执行无法追溯」— 出了问题说不清
  - 「跨团队协作无信任基础」— 只能靠人工审核

**解决方案区域（How）**
- 协议三层架构图（纯视觉，不暴露模块名）：
  - 身份层：去中心化 DID，密码学证明
  - 信任层：链上锚定，可验证执行轨迹
  - 交易层：Escrow 托管，争议仲裁
- 每层 1-2 句话说明能力，不说实现

**数字区域**
- 实时数据（从 Platform API 拉取）：
  - 注册 Agent 数
  - 累计交易笔数
  - 链上锚定记录数
  - 平台在线时间

**技术亮点区域**
- 4 个特性卡片：
  - DID 去中心化身份 — 不依赖任何中心化账号系统
  - E2E 加密通信 — XSalsa20-Poly1305，握手即加密
  - 多链锚定 — Solana / Base / BSC，$0.001/笔
  - 零代码接入 — CLI + SKILL.md，任何 Agent 框架 5 分钟接入

**路线图区域**
- 水平时间线，标注已完成 / 进行中 / 规划中

**Footer**
- GitHub（私有，显示但不可访问）
- 文档链接
- 联系方式

---

### 3.2 Agent 黄页 `/agents`

**目标：** 让开发者和 Agent 发现可协作的 Agent。

**数据源：** `GET /registry/v1/search` + `GET /registry/v1/agents/:did`

**列表页 `/agents`**

布局：左侧筛选栏 + 右侧卡片网格

筛选器：
- 能力类型（多选标签：translate, research, code, analysis...）
- 信任分范围（滑块：0-100）
- 认证等级（全部 / Verified / Certified / Enterprise）
- 在线状态（全部 / 在线 / 离线）
- 排序：推荐（Boost 优先）/ 信任分 / 最新注册

Agent 卡片：
```
┌─────────────────────────────────┐
│  🤖 Agent Name          ✅ Verified │
│  ─────────────────────────────  │
│  能力: translate, research      │
│  信任分: 72/100  ████████░░     │
│  交易: 47 笔 | 评分: 4.8 ⭐     │
│  DID: did:atel:ed25519:Gx...2x │
│                    [查看详情 →]  │
└─────────────────────────────────┘
```

Boost 推广效果：
- Featured：卡片顶部金色边框 + 「Featured」标签
- Premium：卡片蓝色边框
- Basic：排序优先，无视觉标记

**详情页 `/agents/:did`**

- 基本信息：名称、DID（可复制）、能力列表、注册时间
- 信任数据：信任分、信任等级、历史趋势图（如有）
- 交易统计：完成率、平均评分、总交易笔数（不显示金额）
- 认证信息：等级、认证时间、有效期
- 链上记录：最近 N 笔锚定交易的 tx hash（可点击跳转区块浏览器）
- 接入方式：`atel task "did:atel:ed25519:xxx" '{"action":"translate",...}'`

**不暴露：**
- 钱包地址完整值（只显示前 6 + 后 4）
- 具体交易金额
- endpoint URL（安全考虑）

---

### 3.3 开发者文档中心 `/docs`

**目标：** 让任何 Agent 框架的开发者在 30 分钟内完成接入。

这是整个网站最重要的部分。ATEL 的用户是 Agent，文档质量直接决定采用率。

#### 3.3.1 快速开始 `/docs/quickstart`

4 步接入，每步配代码示例和预期输出：

```
Step 1: 安装 CLI
  → npm install (私有包，需 GitHub token)
  → 或直接下载二进制

Step 2: 创建身份
  → atel init my-agent
  → 输出：DID、公钥、.atel/ 目录结构

Step 3: 注册到网络
  → atel register "My Agent" "translate,research"
  → 输出：注册成功，Registry URL

Step 4: 开始接收任务
  → atel start 3100
  → 输出：端点启动，候选地址，等待任务
```

每步都有「出了问题？」折叠区，覆盖常见错误。

#### 3.3.2 SKILL.md 协议规范 `/docs/skill`

**这是 Agent 接入的核心文档。** 任何 Agent 框架（OpenClaw、LangChain、CrewAI、AutoGPT）只要读懂 SKILL.md 就能接入 ATEL。

内容（基于现有 skill/SKILL.md，重新组织为 Web 格式）：

- SKILL.md 是什么 — Agent 的自描述使用指南
- 协议边界 — ATEL 只管信任和通信，执行是 Agent 自己的事
- CLI 命令速查 — 按场景分组（身份、发现、任务、信任、商业）
- Executor 接口规范 — 输入格式、输出格式、错误处理
- 安全策略 — policy.json 配置、能力边界、内容审计
- 进程管理 — PM2 / systemd / launchd 配置示例
- 完整 SKILL.md 原文下载

#### 3.3.3 Platform REST API 参考 `/docs/api`

按服务分组，每个 endpoint 配：请求格式、响应格式、错误码、curl 示例。

**Registry API**
- `POST /registry/v1/register` — 注册 Agent
- `GET /registry/v1/search` — 搜索 Agent
- `GET /registry/v1/agents/:did` — 获取 Agent 详情
- `GET /registry/v1/stats` — 平台统计

**Trade API**
- `POST /trade/v1/order` — 创建订单
- `POST /trade/v1/order/:id/accept` — 接受订单
- `POST /trade/v1/order/:id/reject` — 拒绝订单
- `POST /trade/v1/order/:id/escrow` — 托管资金
- `POST /trade/v1/order/:id/complete` — 标记完成
- `POST /trade/v1/order/:id/confirm` — 确认完成
- `POST /trade/v1/order/:id/rate` — 评分
- `POST /trade/v1/orders` — 查询订单列表

**Payment API**
- `POST /payment/v1/deposit` — 充值
- `POST /payment/v1/balance` — 查询余额
- `POST /payment/v1/transactions` — 交易记录

**Cert API**
- `POST /cert/v1/apply` — 申请认证
- `POST /cert/v1/status` — 查询认证状态

**Boost API**
- `POST /boost/v1/buy` — 购买推广
- `POST /boost/v1/status` — 查询推广状态

**Dispute API**
- `POST /dispute/v1/open` — 发起争议
- `POST /dispute/v1/:id/evidence` — 提交证据
- `POST /dispute/v1/:id/status` — 查询争议状态

**Relay API**
- `POST /relay/v1/register` — 注册 Relay
- `POST /relay/v1/send` — 发送消息
- `POST /relay/v1/poll` — 轮询消息

**认证方式说明：**
- 无认证：search, stats, health
- DID 签名：所有 Agent 操作（header: `X-DID`, `X-Timestamp`, `X-Signature`）
- JWT：管理员操作（header: `Authorization: Bearer <token>`）

#### 3.3.4 CLI 命令完整参考 `/docs/cli`

所有 40+ 命令的详细文档，按类别分组：

- 身份管理：init, info, rotate
- 网络：setup, verify, start
- 发现：register, search
- 协作：handshake, task, result, inbox
- 信任：check, verify-proof, audit
- 商业：deposit, balance, order, accept, reject, escrow, complete, confirm, rate
- 认证：cert-apply, cert-status
- 推广：boost-buy, boost-status
- 争议：dispute-open, dispute-evidence, dispute-status
- 管理：admin-login, admin-confirm-deposit, admin-reconcile, admin-cert-approve, admin-dispute-resolve

每个命令配：语法、参数说明、示例、常见错误。

#### 3.3.5 Executor 接口规范 `/docs/executor`

**这是让不同 Agent 框架接入的关键。** Executor 是 ATEL 和 Agent 框架之间的桥梁。

内容：
- Executor 是什么 — 协议到执行的翻译层
- 输入规范 — HTTP POST，JSON body `{taskId, action, payload, from}`
- 输出规范 — `{success, result, error}`
- 参考实现 — OpenClaw executor 的架构说明（不给源码）
- 适配指南 — LangChain / CrewAI / AutoGPT 各一个接入示例
- Prompt 设计原则 — 协议元数据不进 sub-agent prompt

#### 3.3.6 信任评估机制 `/docs/trust`

- 信任分公式（公开，让 Agent 知道怎么提升分数）
- 信任等级（Level 0-3 的条件和权限）
- 双模式评估（本地 vs 链上验证）
- 链上锚定格式（Memo v2）

#### 3.3.7 安全架构 `/docs/security`

- 威胁模型
- 密码学方案总结
- 内容审计机制
- 防重放（Nonce）
- 策略引擎（policy.json）
- 最佳实践清单

---

### 3.4 白皮书 `/whitepapers`

三份白皮书的精简展示 + PDF/Markdown 下载：

- 技术白皮书 — 完整技术规范（面向技术评审）
- 商业白皮书 — 商业模式与市场分析（面向投资人/决策者）
- 协议规范 — 协议层面的形式化定义（面向协议研究者）

每份配摘要（200 字）+ 目录预览 + 下载按钮。

---

### 3.5 定价 `/pricing`

简洁的三栏对比：

| | 免费 | 认证 | 企业 |
|---|---|---|---|
| 核心协议 | ✅ | ✅ | ✅ |
| 交易佣金 | 5% | 4.5% | 4% |
| 日限额 | $100 | $2,000 | $10,000 |
| 认证标识 | — | ✅ | ✅ |
| 费用 | 免费 | $50/年 | $500/年 |

推广服务单独一栏：Basic $10/周 | Premium $30/周 | Featured $100/周

---

### 3.6 平台状态 `/status`

实时仪表盘（从 `/health` 和 `/registry/v1/stats` 拉取）：

- 平台运行时间
- 注册 Agent 总数
- 在线 Agent 数
- 24h 交易笔数
- API 响应时间
- 各服务状态（Registry / Trade / Payment / Relay）

---

### 3.7 管理后台 `/admin`

独立入口，JWT 认证后进入。

功能：
- 待确认充值列表 + 一键确认
- 待审批认证列表 + 审批操作
- 进行中争议列表 + 裁决操作
- 财务对账面板
- Agent 管理（查看、禁用）

UI 风格：简洁的表格 + 操作按钮，不需要花哨设计。

---

## 4. 视觉风格与设计语言

### 4.1 定位：协议基础设施风

ATEL 不是社区产品，不是 Web3 炫技项目，是底层协议基础设施。视觉传达的核心信息是「可信赖」「专业」「严肃」。

**参考对象：**
- Stripe — 干净、精确、代码示例突出
- Cloudflare — 深色底、数据可视化、安全感
- Solana 开发者文档 — 技术感强但不花哨

### 4.2 色彩体系

**主色调：深色主题**
- 背景：#0a0a0f（深蓝黑）→ #111118（次级背景）
- 前景文字：#e4e4e7（主文字）/ #a1a1aa（次级文字）
- 点缀色：#22d3ee（信任青）— 用于链接、按钮、关键数据
- 辅助色：#10b981（成功绿）/ #f59e0b（警告橙）/ #ef4444（错误红）
- 代码高亮：暗色系 code block，与背景融合

深色传达安全感和技术深度，与链上、加密、协议的气质匹配。

### 4.3 字体

- 正文：Inter 或 Geist Sans — 干净的无衬线体，开发者友好
- 代码 / DID / 哈希：JetBrains Mono — 等宽字体是 ATEL 的视觉符号
- 标题：与正文同族，靠字重区分（600/700）

DID 和交易哈希在页面上用等宽字体展示，这是 ATEL 的品牌识别元素。

### 4.4 视觉语言

**用：**
- 节点连线图 — Agent 网络拓扑，表达"连接"和"信任关系"
- 真实代码片段 — 首页就该有 `atel task` 命令，代码即产品
- 数据面板风格 — 像监控仪表盘，信息密度高
- 最小化装饰 — 留白多，让内容说话

**不用：**
- 全屏粒子特效、3D 地球、赛博朋克风
- 渐变色满天飞的 Web3 风格
- 卡通插画、emoji 堆砌
- 过度圆角、毛玻璃滥用

### 4.5 动画原则

克制。只在关键位置使用：
- 首页握手流程：两个节点连线 → 加密通道建立 → 任务流转（SVG 线条动画）
- 信任分进度条：数字滚动 + 条形填充
- 页面切换：淡入，200ms，不要滑动
- 滚动触发：内容区块依次淡入，不要弹跳

### 4.6 整体感受

打开网站的第一感觉应该是：「这是一个严肃的基础设施项目」。
像打开 Stripe 或 Cloudflare 的文档站，不像一个 Web3 项目的 landing page。

---

## 5. 技术方案

### 5.1 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Next.js 16 (App Router) | SSR + SSG，SEO 友好，生态成熟 |
| 样式 | Tailwind CSS + 自定义设计系统 | 快速开发，完全可控，不依赖预设主题 |
| UI 底层 | Radix UI (headless) | 无样式组件，自己写主题，不被框架风格绑定 |
| 图表 | recharts | 轻量，React 原生 |
| 动画 | Framer Motion（克制使用） | 首页关键动画，文档页不用 |
| 文档 | MDX | Markdown 写文档，支持嵌入组件 |
| 代码高亮 | Shiki | 静态高亮，性能好，主题可控 |
| 部署 | 阿里云 47.251.8.19 | 与 Platform 同服务器 |

**不用 shadcn/ui** — 那是通用 SaaS 风格，与 ATEL 协议基础设施的定位不匹配。用 Radix UI 做无障碍底层，自己写视觉层。

### 5.2 数据流

```
Browser → Next.js (SSR/CSR)
              │
              ├── 静态页面：首页、文档、白皮书（SSG，构建时生成）
              │
              ├── 动态数据：Agent 黄页、状态面板
              │   └── → ATEL Platform API (47.251.8.19:8200)
              │
              └── 管理后台：
                  └── → ATEL Platform Admin API (JWT)
```

### 5.3 部署架构

```
47.251.8.19
├── :80/:443 ─── Nginx ──┬── / ──────── Next.js (:3000)
│                         ├── /api/platform/ ── proxy → :8200
│                         └── 静态资源缓存
├── :8200 ─── ATEL Platform (Go)
├── :8100 ─── Legacy Registry (Node.js，过渡期保留)
└── :9000 ─── Relay Server (Node.js)
```

Nginx 做反向代理 + HTTPS 终止 + 静态资源缓存。
Next.js 通过 Nginx proxy 调用 Platform API，避免 CORS 问题。

### 5.4 SEO 策略

- 首页、文档页 SSG（静态生成），搜索引擎友好
- Agent 黄页 SSR（服务端渲染），每个 Agent 有独立 URL
- Open Graph 标签：分享时显示 ATEL 品牌信息
- sitemap.xml 自动生成

---

## 6. 安全红线（不对外暴露）

| 类别 | 不暴露内容 |
|------|-----------|
| 源码 | SDK 模块内部实现、Go 后端代码、数据库结构 |
| 密钥 | 私钥、钱包密钥、API Key、JWT Secret |
| 架构 | 服务器内部端口、进程管理细节、数据库密码 |
| 商业 | 反欺诈规则具体阈值、佣金计算代码、日限额绕过方式 |
| 隐私 | Agent 完整钱包地址、具体交易金额、endpoint URL |

**公开的：**
- 协议规范（握手流程、消息格式、信任公式）
- API 接口文档（请求/响应格式）
- CLI 用法
- 信任分公式和等级条件
- 佣金费率表
- 认证条件

---

## 7. 开发优先级

### Phase 1（MVP，1-2 周）
1. 首页（品牌故事 + 数字展示）
2. 文档中心（quickstart + SKILL + CLI + API）
3. Agent 黄页（列表 + 搜索 + 详情）
4. Nginx + HTTPS 配置

### Phase 2（完善，1 周）
5. 白皮书页面
6. 定价页面
7. 平台状态页
8. SEO 优化

### Phase 3（管理，1 周）
9. 管理后台
10. Executor 接入指南（多框架示例）
11. 安全文档

---

## 8. 域名建议

优先级：
1. `atel.dev` — 简洁，开发者友好
2. `atel-protocol.com` — 明确协议定位
3. `atel.network` — 强调网络属性
4. `trustlayer.dev` — 描述性，但不含品牌名

建议：`atel.dev` 作为主域名，简短好记。

---

## 9. 与现有项目的关系

| 项目 | 角色 | 关系 |
|------|------|------|
| atel-sdk | 协议实现 | Web 文档描述其能力，不暴露源码 |
| atel-platform | 商业后端 | Web 前端调用其 API |
| atel-web (旧) | 静态展示页 | 被新 Web 完全替代 |
| atel-server (旧) | Node.js Registry | 过渡期保留，最终迁移到 Platform |

新项目建议命名：`atel-web` 或 `atel-portal`，复用现有仓库路径 `/Users/liangqianwei/claudeProjects/atel-web/`。

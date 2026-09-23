# Prompt RSI Lab

一个真实运行的、范围受控的递归式自我改进（RSI）实验：优化“将技术文章写成四段式中文摘要”的提示词。线上网站：[rsi-evolution-lab.leoliu-dev.workers.dev](https://rsi-evolution-lab.leoliu-dev.workers.dev)。

## 每日闭环

Cloudflare Cron 每天 01:00 UTC（北京时间 09:00）运行：

1. 读取 KV 中的当前冠军提示词与上次失分。
2. 使用 Workers AI 生成两个新的完整候选提示词。
3. 冠军和两个候选分别摘要 [3 篇固定技术短文](src/benchmark.js)，保存全部输出。
4. 按相同规则计算事实关键词覆盖率、四段格式与长度分，并扣除禁用断言。
5. 候选综合分比当天冠军高至少 2 分、事实覆盖不下降、无禁用断言时，才更新冠军。否则保留旧版。
6. 将完整实验与最近 30 次趋势写入 Cloudflare KV，网站通过 /api/evolution 展示。
7. GitHub Actions 于 02:00 UTC 读取当天已完成的实验，提交 snapshots/YYYY-MM-DD.json。若当天实验未完成，归档任务失败并保留错误信号，不生成虚假记录。

网站展示的分数来自真实模型输出，没有随日期自动上涨的模拟数据。模型使用 [Cloudflare Workers AI 的 Qwen3 30B A3B](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)；每轮最多 10 次模型调用。

## 评分边界

自动评分是一个可复查的代理指标，不等于完整的语义事实核查：

- 事实标签命中：60%。
- “结论、要点、风险、术语”四段格式：20%。
- 去空白后 80–450 字内，越精简得分越高：20%。
- 命中预设错误断言：每项扣 15 分，并禁止该候选晋级。

测试文章、关键词别名和禁用断言都在 src/benchmark.js。更改基准集会影响分数可比性，应作为新的实验版本记录。固定基准长期使用也可能过拟合；实际扩展时应增加保密留出集和人工复核。

## 开发

    npm ci
    npm test
    npm run check
    npm run dev

本地访问 http://localhost:8787。Workers AI 绑定调用线上模型，可能产生 Cloudflare 用量。Cron 可通过 Wrangler 本地计划事件路由测试。

## 部署与首次运行

项目绑定 Leo 账号下的 KV 命名空间，配置在 wrangler.jsonc。运行：

    npm run deploy
    npx wrangler secret put RUN_TOKEN

RUN_TOKEN 仅用于管理员手动启动首轮或故障重试，不要提交到 Git。向 /api/admin/run 发送 POST，携带 Authorization: Bearer <RUN_TOKEN> 即可；同一天已完成的实验会跳过。正常每日运行由 Cron 自动触发，不需要该令牌。

GitHub Actions 使用仓库自带的 GITHUB_TOKEN 提交归档，不需要 Cloudflare API Token。网站每日直接读取 KV，因此每次实验后无需重新部署静态文件。代码修改后仍需运行 npm run deploy。

## 主要文件

- src/benchmark.js：测试文章、事实标签、初始 Prompt 与模型。
- src/evolution.js：候选生成、真实摘要、评分、晋级与 KV 持久化。
- src/index.js：公开 API、受令牌保护的手动触发入口与 Cron 处理。
- public/index.html：线上实验控制台。
- scripts/snapshot.mjs：GitHub 每日实验归档。
- test/evolution.test.js：晋级、幂等、失败保留冠军测试。

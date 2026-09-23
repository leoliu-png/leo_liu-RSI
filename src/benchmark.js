// Short original passages; reference anchors are reviewable in Git.
export const benchmark = [
  {
    id: "postgres-replica", title: "异步只读副本",
    article: "订单服务把写入提交到 PostgreSQL 主库，再返回成功。只读副本通过异步复制接收变更，因此用户刚下单后立即查询副本，可能短时间看不到订单。副本故障时读请求会回退主库。这种设计提高读吞吐量，但不保证副本上的即时一致性。",
    anchors: [["PostgreSQL"], ["异步复制"], ["短时间", "立即"], ["回退主库", "主库回退"], ["不保证", "无法保证"]],
    forbidden: ["同步复制", "总能立即读到", "零延迟"]
  },
  {
    id: "http-cache", title: "HTTP 条件请求",
    article: "服务器在响应中返回 ETag。客户端下次请求携带 If-None-Match；如果资源没有变化，服务器可返回 304，并且不再发送响应正文。ETag 由服务端维护，不能仅凭文件名判断内容是否变化。该机制减少重复传输，但首次请求仍需获取完整资源。",
    anchors: [["ETag"], ["If-None-Match"], ["304"], ["响应正文", "正文"], ["首次请求"]],
    forbidden: ["首次请求不需要", "必定返回 200", "完全不需要网络"]
  },
  {
    id: "passkeys", title: "通行密钥登录",
    article: "WebAuthn 登录时，服务器生成一次性 challenge。认证器使用私钥对挑战签名，服务器用已登记的公钥验证签名。私钥留在用户设备，不会发送给网站。若设备丢失，用户需要事先配置的恢复方式；通行密钥不能消除账户恢复问题。",
    anchors: [["WebAuthn"], ["challenge", "挑战"], ["私钥"], ["公钥"], ["恢复"]],
    forbidden: ["私钥发送给网站", "无需账户恢复", "公钥签名"]
  }
];

export const initialPrompt = `你是一名严谨的技术编辑。只依据给出的文章，用中文输出以下四段，并保留标题：
结论：一句话概括。
要点：列出 3 至 5 条可由原文核对的关键事实，保留数字、名称和条件。
风险：写出原文提到的限制；没有则写“原文未说明”。
术语：解释首次出现的关键技术术语；原文信息不足时写“原文未说明”。
禁止补充原文以外的信息。全文不超过 450 字。`;

export const modelName = "@cf/qwen/qwen3-30b-a3b-fp8";

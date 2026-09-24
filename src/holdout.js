// Fresh factual details are generated for each China-local experiment day.
// These passages are never included in the prompt- or strategy-proposal calls.
function dayNumber(date) {
  return Number(date.replaceAll("-", ""));
}

export function holdoutForDate(date) {
  const day = dayNumber(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day)) throw new Error("Invalid experiment date");
  const retry = 3 + day % 5;
  const ttl = 15 + day % 11;
  const limit = 30 + day % 31;
  const rotation = 20 + day % 25;
  const topics = [
    {
      id: `queue-${date}`, title: "异步任务重试",
      article: `订单通知由 RabbitMQ 异步投递。消费者处理失败时最多重试 ${retry} 次，仍失败的消息进入死信队列，由值班人员检查。队列采用至少一次投递，因此消费者需要按订单编号做幂等处理，不能假设每条通知只执行一次。`,
      anchors: [["RabbitMQ"], [String(retry), `${retry}次`], ["死信队列"], ["至少一次"], ["幂等"]],
      forbidden: ["恰好一次投递", "永不重复", "无需幂等"]
    },
    {
      id: `object-${date}`, title: "对象存储清理",
      article: `客户端以分片方式上传文件，完成后服务端核对 SHA-256 摘要。中断的分片可以重试，但尚未完成的上传会在 ${ttl} 小时后清理。对象写入成功不等于下游索引已经更新，搜索页面可能短时间查不到新文件。`,
      anchors: [["分片"], ["SHA-256"], [String(ttl), `${ttl}小时`], ["清理"], ["索引", "搜索"]],
      forbidden: ["永不清理", "立即可搜索", "无需校验"]
    },
    {
      id: `rate-${date}`, title: "接口限流",
      article: `公开 API 按每个访问令牌每分钟 ${limit} 次请求限流。超过额度时返回 HTTP 429，并在 Retry-After 中提示等待秒数。该限制保护服务稳定性，但不同令牌之间不共享额度，也不能替代用户身份验证。`,
      anchors: [[String(limit), `${limit}次`], ["访问令牌"], ["429"], ["Retry-After"], ["身份验证"]],
      forbidden: ["所有令牌共享额度", "无需身份验证", "永不返回429"]
    },
    {
      id: `secret-${date}`, title: "密钥轮换",
      article: `服务端每 ${rotation} 天轮换一次签名密钥。轮换期间，新旧两把密钥并行验证已有会话，旧密钥在宽限期结束后停用。密钥只保存在服务端，客户端仅持有签名后的令牌；轮换不能撤销已经泄露但仍在宽限期内的令牌。`,
      anchors: [[String(rotation), `${rotation}天`], ["新旧", "两把"], ["宽限期"], ["服务端"], ["泄露"]],
      forbidden: ["客户端保存密钥", "立即撤销所有令牌", "无需宽限期"]
    }
  ];
  const first = day % topics.length;
  return [topics[first], topics[(first + 2) % topics.length]];
}

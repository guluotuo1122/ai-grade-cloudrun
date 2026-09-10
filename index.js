/**
 * AI 批改云托管服务（CloudBase Run）
 * 核心：一张图直接给视觉大模型，一次输出全部题的判定，突破微信云函数 60s 硬限制。
 *
 * 接口：
 *   GET  /           健康检查
 *   POST /grade      批改一张图（body: { imageUrl, apiKey?, model?, prompt? }）
 *                    → 返回 { success, content }，content 是模型原始文本（JSON）
 *
 * 部署（CloudBase 云托管 → Git 部署）：
 *   1. 环境变量配置 DASHSCOPE_API_KEY（或每次请求带 apiKey）
 *   2. 启动命令：npm start（监听 process.env.PORT，默认 80）
 */
const http = require('http')
const https = require('https')

const PORT = process.env.PORT || 80
const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const DEFAULT_MODEL = process.env.VISION_MODEL || 'qwen3-vl-plus'

/** 批改 prompt：一张图一次输出所有题的判定（精简 5 字段，避免输出 token 巨多） */
const GRADE_PROMPT = `你是批卷老师。下方是一张试卷/作业的图片。请【一次性】识别图上所有"需要学生作答的题"，按【从上到下、从左到右】顺序，对每一题输出判定。

"一道题" = 一个填空横线 / 括号空 / 句内空 / 写作的每条 / 匹配答案的每一项（a、b、c…也各算一题，它们是没有填空线的印刷句但学生要连线配对，绝不能跳过）。

对每一题输出：
- question：该题题干（只抄该题本身；不含大题标题如"2 ★★ Complete the questions..."、不含大题要求如"Use the verbs in brackets"）
- studentAnswer：学生手写答案（清晰、孤立、无涂改才填；被划掉/打叉/涂改/多笔 → 填"未知"）
- verdict：correct（对）/ wrong（错）/ unsure（未写或看不清）
- correctAnswer：正确答案（你自己分析题目得出，不抄卷面订正/红笔）
- reason：一句话依据（≤30 字）

【关键规则】
- ★ 学生答案有涂改/划掉/打叉/订正/多笔叠写 → studentAnswer 填"未知"、verdict 填 unsure（宁可错报未知，不要错报一个错答案）
- ★ correctAnswer 你自己解题得出，绝不抄卷面的订正/红笔答案
- ★ 数学题选项字母 A/B/C/D ≠ 题目里的变量名（如"点C"），按数值匹配选项字母，不要按名称

【输出 JSON，一次性输出所有题，图上有几题就输出几个对象，一个都不能漏】
{ "gradings": [ { "question":"题干", "studentAnswer":"学生答案或未知", "verdict":"correct", "correctAnswer":"正确答案", "reason":"依据" } ] }

只输出 JSON，不要任何其他文字，不要 markdown 代码块。`

/** 从模型返回文本提取 JSON 数组（容忍 markdown 代码块/前后缀） */
function extractGradings(text) {
  if (!text) return []
  let t = String(text).replace(/```(json)?/gi, '')
  const start = Math.min(...['{', '['].map((c) => { const i = t.indexOf(c); return i === -1 ? Infinity : i }))
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'))
  if (start === Infinity || end === -1 || end <= start) return []
  try {
    const obj = JSON.parse(t.slice(start, end + 1))
    return Array.isArray(obj.gradings) ? obj.gradings : (Array.isArray(obj) ? obj : [])
  } catch (e) {
    return []
  }
}

/** 调用 DashScope OpenAI 兼容接口（流式 stream:true，边生成边回调 onDelta，避免网关空闲超时） */
function callDashScopeStream({ apiKey, model, imageUrl, prompt, onDelta }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model || DEFAULT_MODEL,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: prompt }
          ]
        }
      ]
    })
    const url = new URL(DASHSCOPE_URL)
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 180000 // 3 分钟
    }, (res) => {
      let buffer = ''
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf-8')
        // 解析 SSE 行（data: {...}）
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          try {
            const obj = JSON.parse(data)
            const delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content
            if (delta && onDelta) onDelta(delta)
          } catch (e) { /* 忽略解析失败的行 */ }
        }
      })
      res.on('end', resolve)
      res.on('error', reject)
    })
    req.on('error', (e) => reject(new Error('DashScope 网络错误: ' + e.message)))
    req.on('timeout', () => req.destroy(new Error('DashScope 超时(180s)')))
    req.write(body)
    req.end()
  })
}

/** 读请求体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 5 * 1024 * 1024) { req.destroy(); reject(new Error('请求体过大')) }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // 健康检查
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, model: DEFAULT_MODEL }))
    return
  }

  // 批改（流式：立即响应头 + 边生成边发心跳，避免网关 60s 空闲超时返回 504）
  if (req.method === 'POST' && req.url === '/grade') {
    const raw = await readBody(req)
    let imageUrl, apiKey, model, prompt
    try {
      const p = JSON.parse(raw || '{}')
      imageUrl = p.imageUrl; apiKey = p.apiKey; model = p.model; prompt = p.prompt
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, message: '请求体不是合法 JSON' }))
      return
    }

    if (!imageUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, message: '缺少 imageUrl（图片 https 地址）' }))
      return
    }
    const key = apiKey || process.env.DASHSCOPE_API_KEY
    if (!key) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: false, message: '缺少 API Key' }))
      return
    }

    // 立即写响应头（chunked + 禁用网关缓冲，让心跳立即转发）
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    })

    try {
      let content = ''
      await callDashScopeStream({
        apiKey: key,
        model,
        imageUrl,
        prompt: prompt || GRADE_PROMPT,
        onDelta: (delta) => {
          content += delta
          res.write(' ') // 心跳：每收到 delta 就写数据，保持连接活跃，防网关超时
        }
      })
      const gradings = extractGradings(content)
      res.end(JSON.stringify({ success: true, count: gradings.length, gradings }))
    } catch (e) {
      res.end(JSON.stringify({ success: false, message: (e && e.message) || '处理失败' }))
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('not found')
})

server.listen(PORT, () => {
  console.log(`[ai-grade] 云托管服务已启动，端口 ${PORT}，模型 ${DEFAULT_MODEL}`)
})

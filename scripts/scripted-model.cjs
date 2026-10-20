// A scripted OpenAI-compatible model on loopback for end-to-end tests of the built app. It plays
// whatever `reply` decides from the conversation it was sent, and records every request so a test
// can check what SideKick actually sent: the prompt, its size, and the reply limit it asked for.
const { createServer } = require('node:http')

function text(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => part.text || '').join('') : ''
}

/** The characters a request's messages hold, the size the model would be asked to read. */
function promptCharacters(messages) {
  return messages.reduce(
    (sum, message) =>
      sum +
      text(message.content).length +
      JSON.stringify(message.tool_calls ?? []).length +
      (message.tool_call_id ?? '').length,
    0
  )
}

/** Streams an answer as server-sent events, in `chunks` pieces `delayMs` apart. */
async function stream(response, answer, { chunks = 1, delayMs = 0 } = {}) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (body) => response.write(`data: ${JSON.stringify(body)}\n\n`)
  if (answer.toolCall) {
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
                type: 'function',
                function: {
                  name: answer.toolCall.name,
                  arguments: JSON.stringify(answer.toolCall.arguments)
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    })
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else {
    const content = answer.content ?? ''
    const size = Math.max(1, Math.ceil(content.length / Math.max(1, chunks)))
    for (let start = 0; start < content.length; start += size) {
      send({
        choices: [
          { index: 0, delta: { content: content.slice(start, start + size) }, finish_reason: null }
        ]
      })
      if (delayMs) await new Promise((done) => setTimeout(done, delayMs))
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  }
  response.end('data: [DONE]\n\n')
}

/**
 * Starts the model. `reply(messages, request)` returns, or resolves to, `{ content }`,
 * `{ toolCall: { name, arguments } }`, or either with a `stream` of `{ chunks, delayMs }` to
 * fragment the answer. A promise holds the answer back until it settles.
 */
async function startScriptedModel({ models, reply }) {
  const requests = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (part) => (body += part))
    request.on('end', async () => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: models }))
        return
      }
      if (request.url !== '/v1/chat/completions') {
        response.writeHead(404).end()
        return
      }
      const parsed = JSON.parse(body)
      const record = {
        messages: parsed.messages,
        maxTokens: parsed.max_tokens ?? parsed.max_completion_tokens,
        promptCharacters: promptCharacters(parsed.messages),
        tools: (parsed.tools ?? []).map((tool) => tool.function?.name)
      }
      requests.push(record)
      let answer
      try {
        answer = await reply(parsed.messages, record)
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: String(error?.message ?? error) } }))
        return
      }
      void stream(response, answer, answer.stream)
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((done) => server.close(() => done()))
  }
}

module.exports = { startScriptedModel, text, promptCharacters }

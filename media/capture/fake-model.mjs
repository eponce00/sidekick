// An OpenAI-compatible model on loopback that plays a scripted scene, so the recordings show the
// real app doing real work at a steady, readable pace. Each scene is a list of turns; a request
// gets the turn after the last one the conversation already holds.
import { createServer } from 'node:http'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))

function lastUserText(messages) {
  const user = [...messages].reverse().find((message) => message.role === 'user')
  const content = user?.content
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((part) => part.text || '').join('') : ''
}

/** Pieces of `text` about `size` characters long, split after spaces where it can. */
function pieces(text, size) {
  const out = []
  let rest = text
  while (rest.length > size) {
    const cut = rest.lastIndexOf(' ', size) > size / 2 ? rest.lastIndexOf(' ', size) + 1 : size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest) out.push(rest)
  return out
}

async function streamTurn(response, turn) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (delta, finish = null) =>
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    )
  if (turn.thinking) {
    for (const piece of pieces(turn.thinking, 18)) {
      send({ reasoning_content: piece })
      await pause(turn.thinkingDelayMs ?? 30)
    }
  }
  if (turn.text) {
    for (const piece of pieces(turn.text, turn.textChunk ?? 14)) {
      send({ content: piece })
      await pause(turn.textDelayMs ?? 28)
    }
  }
  for (const [index, call] of (turn.toolCalls ?? []).entries()) {
    const id = `call_${Date.now()}_${index}`
    const args = JSON.stringify(call.arguments)
    const size = call.chunk ?? args.length
    send({
      tool_calls: [{ index, id, type: 'function', function: { name: call.name, arguments: '' } }]
    })
    for (let at = 0; at < args.length; at += size) {
      send({ tool_calls: [{ index, function: { arguments: args.slice(at, at + size) } }] })
      if (call.delayMs) await pause(call.delayMs)
    }
  }
  send({}, turn.toolCalls?.length ? 'tool_calls' : 'stop')
  response.write(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4200, completion_tokens: 380, total_tokens: 4580 } })}\n\n`
  )
  response.write('data: [DONE]\n\n')
  response.end()
}

/**
 * Starts the model. `scenes` maps a phrase in the user's message to its turns; `onRequest` sees
 * every request body, as the first dry run uses to list the tools SideKick offers.
 */
export async function startFakeModel({ model, scenes, onRequest }) {
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ data: [{ id: model, object: 'model', context_length: 131072 }] })
      )
      return
    }
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body || '{}')
    onRequest?.(parsed)
    const messages = parsed.messages ?? []
    const said = lastUserText(messages)
    const scene = Object.entries(scenes).find(([phrase]) => said.includes(phrase))?.[1]
    // The turns this request answers: those after the assistant turns since the user spoke.
    const sinceUser = messages.slice(messages.map((m) => m.role).lastIndexOf('user') + 1)
    const done = sinceUser.filter((message) => message.role === 'assistant').length
    const turn = scene?.[done] ?? { text: 'Done.' }
    if (turn.waitMs) await pause(turn.waitMs)
    await streamTurn(response, turn)
  })
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() }
}

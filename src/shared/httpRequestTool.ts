import type { AgentToolDefinition } from './agentToolDefinitions'

export const HTTP_REQUEST_TOOL = 'http_request'

export const HTTP_REQUEST_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/** Calls an API. A stored credential is named by alias and added by SideKick, never by the model. */
export const httpRequestTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: HTTP_REQUEST_TOOL,
    description:
      "Send one HTTP request to an API and read the response. Use web_fetch to read a web page instead. To authenticate with a credential the user stored, pass its alias as credential: SideKick adds the value where the user set it up, only over HTTPS to that credential's hosts, and you never see it. Never put a key, token or password in headers, the URL or the body yourself. Redirects are not followed; the response says where one points. Tokens in the response to a request that used a credential come back as aliases such as name~1, which you pass as credential in later requests.",
    parameters: {
      type: 'object',
      required: ['method', 'url'],
      properties: {
        method: { type: 'string', enum: [...HTTP_REQUEST_METHODS] },
        url: { type: 'string', description: 'Absolute http or https URL.' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Request headers, such as Accept. Never a secret.'
        },
        body: {
          type: 'string',
          description:
            'A raw body; set its Content-Type in headers. Use json or form instead when they fit.'
        },
        json: { type: 'object', description: 'A JSON object body; sets Content-Type.' },
        form: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'A form body (application/x-www-form-urlencoded); sets Content-Type.'
        },
        credential: {
          type: 'string',
          description: 'Alias from credentials_list, or a token alias a previous response returned.'
        },
        timeout: {
          type: 'number',
          minimum: 1,
          maximum: 120,
          description: 'Seconds to wait for the response, default 30.'
        }
      }
    }
  }
}

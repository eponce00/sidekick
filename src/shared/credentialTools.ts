/**
 * Tools that tell SideKick's agent which credentials the user stored and let it ask for one.
 * Neither returns a value: the user types values only into SideKick's own Settings window.
 */
import type { AgentToolDefinition } from './agentToolDefinitions'

export const CREDENTIALS_LIST_TOOL = 'credentials_list'
export const CREDENTIALS_REQUEST_TOOL = 'credentials_request'

/** The tools that take a credential's alias and add its value themselves. */
export const CREDENTIAL_CONSUMER_TOOLS: readonly string[] = [
  'http_request',
  'shell',
  'browser_sign_in'
]

export const credentialsListTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: CREDENTIALS_LIST_TOOL,
    description:
      "List the credentials the user stored for you, as a password manager lists them: each alias, kind (secret or sign-in), description, and a sign-in's username. Decide from the description which one a task needs and where it belongs. Never returns a secret or password, and you never need one: tools that accept a credential take its alias. Values are redacted from every tool result as [secret: alias].",
    parameters: { type: 'object', properties: {} }
  }
}

export const credentialsRequestTool: AgentToolDefinition = {
  type: 'function',
  function: {
    name: CREDENTIALS_REQUEST_TOOL,
    description:
      "Open SideKick's Credentials settings so the user can add a credential you need, or update one, by typing the value there. You never see the value; afterwards credentials_list shows whether it is stored. Never ask the user to paste a key, token or password into the conversation.",
    parameters: {
      type: 'object',
      required: ['alias'],
      properties: {
        alias: {
          type: 'string',
          description:
            'Suggested alias: lowercase letters, digits, hyphens or underscores, such as partner-center. An existing alias opens that credential.'
        },
        kind: {
          type: 'string',
          enum: ['secret', 'sign_in'],
          description: 'secret for an API key or token; sign_in for a username and password.'
        },
        description: {
          type: 'string',
          description: 'One sentence saying what it is for, shown to the user and kept with it.'
        }
      }
    }
  }
}

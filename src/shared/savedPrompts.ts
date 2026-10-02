/** A prompt saved as a Markdown file and offered as a `/` command in the message box. */
export interface SavedPrompt {
  /** The command name: the file name without `.md`. */
  name: string
  description?: string
  body: string
  source: 'project' | 'user'
  /** Where the file lives, for display: project-relative or under the home folder. */
  location: string
}

/** Where `$ARGUMENTS` appears in a prompt, the text typed after the command goes. */
export const SAVED_PROMPT_ARGUMENTS = '$ARGUMENTS'

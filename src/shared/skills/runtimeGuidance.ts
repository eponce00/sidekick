import type { Skill } from './types'

/** Shared by first activation and later turns; loading a skill never runs a command. */
export function getSkillRuntimeGuidance(skill: Skill): string {
  if (
    !skill.requiresPython &&
    !skill.requiresPythonPackages?.length &&
    !skill.requiresNodePackages?.length
  )
    return ''
  return (
    `\n\n### Runtime and platform contract\n
Loading this skill does not install or verify dependencies. Declared Python packages: ${skill.requiresPythonPackages?.join(', ') || 'none'}. Declared Node packages: ${skill.requiresNodePackages?.join(', ') || 'none'}.
For programmatic file work only, check the relevant workflow using the shipped preflight.py helper before executing it. Workflow names: pdf, pdf-render, office, office-validate, office-xsd, office-render, office-render-images, docx-create, docx-create-python, docx-comment, pptx-create, pptx-create-python, pptx-read, xlsx, xlsx-recalc, docx-accept. Python and Node creation routes are separate supported engines; honor an explicitly requested engine and never silently change it. An available result is discovery, not proof of successful execution. Office validation is structural, not full XSD conformance. Report missing dependencies; do not install packages, change global NODE_PATH, or change the user's application profile implicitly.
The examples below use Windows PowerShell. On Windows: python "$env:SIDEKICK_SKILLS\\preflight.py" WORKFLOW. On macOS/Linux: python3 "$SIDEKICK_SKILLS/preflight.py" WORKFLOW. Confirm Python 3.10+ exists first; if unavailable, report it for Python workflows. Node-only creation can instead check node and require.resolve for its package from the workspace without requiring Python. Quote paths, use the actual shell's syntax, and replace Windows separators and commands on other platforms. Use open on macOS or xdg-open on Linux only after the user asks to open a file.
SIDEKICK_SKILLS is the read-only helper directory supplied by the command runtime, not a Python/Node package installation. SIDEKICK_SCRATCH is a managed temporary directory, but file tools may be project-scoped: when they cannot write scratch, use a unique project-relative temporary script via apply_patch, run it, then delete only that script. Never write generated source through shell heredocs or Set-Content. Files do not auto-delete. Do not assume npm globals are available. For scripts in scratch, resolve a package with require.resolve('PACKAGE', { paths: [process.env.WORKSPACE_FOLDER || process.cwd()] }) before requiring it.
In Docker-isolated shell mode, configured bundled helpers are mounted read-only at /sidekick-skills and SIDEKICK_SKILLS points there. Use Linux shell syntax inside the container, even on a Windows host. Host Python, Node packages, and Office runtimes are not mounted or installed; check availability inside the container and report missing dependencies. A missing or invalid configured helper directory fails the isolated command explicitly. If no helper directory is configured, helpers are not mounted; never switch to host execution silently. Browser-only PDF tasks must stay in the browser and do not require Python preflight or a Python fallback. Reopen outputs and verify structure/content; report missing rendering or schema validation honestly.\n` +
    'Office helpers are not a security sandbox. Do not enable document-provided macros or fetch external document links. Use isolated execution for untrusted Office files; a renderer subprocess alone is not containment.\n'
  )
}

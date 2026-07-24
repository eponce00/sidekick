interface PromptSharpenIconProps {
  size?: number
  active?: boolean
}

/** SideKick's prompt-refinement mark: a draft becoming clearer, finished with a spark. */
export function PromptSharpenIcon({
  size = 17,
  active = false
}: PromptSharpenIconProps): React.JSX.Element {
  return (
    <svg
      className={active ? 'prompt-sharpen-icon is-active' : 'prompt-sharpen-icon'}
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path className="prompt-sharpen-line line-one" d="M2.25 5.25h5" />
      <path className="prompt-sharpen-line line-two" d="M2.25 9h8" />
      <path className="prompt-sharpen-line line-three" d="M2.25 12.75h11" />
      <path
        className="prompt-sharpen-spark"
        d="M13.4 2.15c.18 1.48.97 2.27 2.45 2.45-1.48.18-2.27.97-2.45 2.45-.18-1.48-.97-2.27-2.45-2.45 1.48-.18 2.27-.97 2.45-2.45Z"
      />
    </svg>
  )
}

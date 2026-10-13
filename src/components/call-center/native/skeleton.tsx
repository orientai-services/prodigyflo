/** A section's placeholder while its server render is on the way: the shape of a list, never a blank screen. */
export function SectionSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="cc-skel" aria-hidden="true">
      <i className="cc-skel-bar" />
      {Array.from({ length: rows }, (_, index) => (
        <i key={index} className="cc-skel-row" />
      ))}
    </div>
  )
}
